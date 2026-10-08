package dev.kept.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.kept.android.KeptApplication
import dev.kept.android.data.Discard
import dev.kept.android.data.EditorSnapshotPolicy
import dev.kept.android.data.Note
import dev.kept.android.data.copyJson
import dev.kept.android.data.copyForEdit
import dev.kept.android.data.KeptRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

class NoteEditorViewModel(
    private val repository: KeptRepository,
    initial: Note
) : ViewModel() {
    private val profile = repository.settings.profile
    private val _draft = MutableStateFlow(initial.raw.copyJson())
    val draft = _draft.asStateFlow()
    private val _draftGeneration = MutableStateFlow(0L)
    val draftGeneration = _draftGeneration.asStateFlow()
    private val startedAsNew = initial.id <= 0
    private var serverBase = Note(initial.raw.copyJson())
    private val _dirty = MutableStateFlow(false)
    val dirty = _dirty.asStateFlow()
    private val _incoming = MutableStateFlow<Note?>(null)
    val incoming = _incoming.asStateFlow()
    private val _localSaving = MutableStateFlow(false)
    val localSaving = _localSaving.asStateFlow()
    private val _localSaveFailed = MutableStateFlow(false)
    val localSaveFailed = _localSaveFailed.asStateFlow()
    private val _errors = MutableSharedFlow<String>(extraBufferCapacity = 4)
    val errors = _errors.asSharedFlow()
    private val persistenceMutex = Mutex()
    @Volatile private var saveGeneration = 0
    @Volatile private var persistedGeneration = 0
    @Volatile private var pendingSince = 0L
    private val localWrites = java.util.concurrent.atomic.AtomicInteger()
    /** Number of local draft commits made by this session (a measure of write amplification while typing). */
    internal val localWriteCount get() = localWrites.get()
    private var persistenceJob: Job? = null

    init {
        viewModelScope.launch(Dispatchers.IO) {
            repository.acceptedNoteSnapshots.collect { accepted ->
                if (accepted.profile == profile && accepted.note.syncId == serverBase.syncId) {
                    acceptServerSnapshot(accepted.note, accepted.submitted)
                }
            }
        }
        viewModelScope.launch(Dispatchers.IO) {
            repository.incomingNoteSnapshots.collect { remote ->
                if (remote.profile == profile && remote.note.syncId == serverBase.syncId) applyIncoming(remote.note)
            }
        }
    }

    /**
     * Applies an edit to a new draft. Name the top-level fields the block mutates in place (`"checkBoxes"`, `"labels"`)
     * so only those are deep-copied and the rest of the note (inline images, drawings, unknown fields) is shared with
     * the previous draft instead of being re-serialized on every keystroke. With no names the whole note is copied.
     */
    @Synchronized fun change(vararg touched: String, block: (JSONObject) -> Unit) {
        publish(_draft.value.copyForEdit(touched).also(block))
    }

    @Synchronized fun replace(value: JSONObject) {
        publish(value.copyJson())
    }

    private fun publish(next: JSONObject) {
        _draft.value = next
        _draftGeneration.value += 1
        _dirty.value = true
        persistLocally(next)
    }

    @Synchronized fun updateChecklistCollapsed(collapsed: Boolean) {
        val next = _draft.value.copyJson().put("completedChecklistCollapsed", collapsed)
        _draft.value = next
        viewModelScope.launch(Dispatchers.IO) {
            try { repository.setChecklistCollapsed(Note(next), collapsed, profile) }
            catch (error: Exception) { _errors.emit(error.message ?: "Could not save checklist view state") }
        }
    }

    @Synchronized fun applyIncoming(incoming: Note) {
        val local = Note(_draft.value)
        val wasDirty = _dirty.value
        if (wasDirty) {
            if (local.id > 0 && incoming.id == local.id && incoming.revision > serverBase.revision &&
                !EditorSnapshotPolicy.sameEditableContent(local, incoming)) {
                _incoming.value = incoming
            }
            return
        }
        EditorSnapshotPolicy.apply(local, incoming, dirty = false)?.let {
            _draft.value = it.raw
            _draftGeneration.value += 1
            serverBase = incoming
            _incoming.value = null
            _dirty.value = !EditorSnapshotPolicy.sameEditableContent(Note(it.raw), serverBase)
        }
    }

    @Synchronized internal fun acceptServerSnapshot(accepted: Note, submitted: Note? = null) {
        val current = Note(_draft.value)
        val acceptedSubmission = submitted ?: accepted
        val noLaterEditThanAcceptedOperation = EditorSnapshotPolicy.sameEditableContent(current, acceptedSubmission)
        serverBase = accepted
        val rebased = if (noLaterEditThanAcceptedOperation) accepted.raw.copyJson()
            else _draft.value.copyJson().put("id", accepted.id).put("revision", accepted.revision)
        _draft.value = rebased
        _draftGeneration.value += 1
        _dirty.value = !noLaterEditThanAcceptedOperation && !EditorSnapshotPolicy.sameEditableContent(Note(rebased), accepted)
        if (_incoming.value?.revision?.let { it <= accepted.revision } == true) _incoming.value = null
    }

    suspend fun flushAndQueueSync() {
        persistenceMutex.withLock {
            while (true) {
                val generation = saveGeneration
                if (_dirty.value) {
                    if (persistedGeneration == generation && profile == repository.settings.profile) {
                        // Already committed locally by the debounced write: only hand the queue to the sync worker.
                        repository.queueSync()
                    } else {
                        repository.save(Note(_draft.value), synchronize = true, profile = profile)
                        markPersisted(generation)
                    }
                    _localSaveFailed.value = false
                    if (generation == saveGeneration) _localSaving.value = false
                }
                else if (profile == repository.settings.profile) repository.requestSync()
                if (generation == saveGeneration) {
                    break
                }
            }
        }
    }

    /** Commits an edit still waiting in the debounce window (called when the editor leaves the foreground). */
    suspend fun flushLocal() {
        persistenceMutex.withLock {
            val generation = saveGeneration
            if (_dirty.value && persistedGeneration < generation) {
                repository.save(Note(_draft.value), synchronize = false, profile = profile)
                markPersisted(generation)
                _localSaveFailed.value = false
                if (generation == saveGeneration) _localSaving.value = false
            }
        }
    }

    private fun markPersisted(generation: Int) {
        persistedGeneration = generation
        pendingSince = 0
        localWrites.incrementAndGet()
    }

    // Closing a note created in this session without content discards it instead of saving a blank note.
    suspend fun finish() {
        val draft = Note(_draft.value.copyJson())
        if (!startedAsNew || draft.hasContent) return flushAndQueueSync()
        persistenceMutex.withLock {
            persistenceJob?.cancel()
            // The emptied draft may still be waiting in the debounce window; the discard decision reads stored state.
            if (_dirty.value && persistedGeneration < saveGeneration) {
                repository.save(draft, synchronize = false, profile = profile)
                markPersisted(saveGeneration)
            }
            saveGeneration++
            if (repository.discardIfEmpty(draft.syncId, profile) == Discard.SYNCED && draft.owner == repository.settings.userId &&
                profile == repository.settings.profile) {
                // The server may already know this note (an autosave went out before the text was removed).
                repository.setTrashed(listOf(draft.syncId), true)
            }
        }
    }

    suspend fun preserveForRecovery() {
        persistenceMutex.withLock {
            while (true) {
                val generation = saveGeneration
                if (_dirty.value) {
                    repository.preserveDraftForRecovery(Note(_draft.value.copyJson()), profile)
                    _localSaveFailed.value = false
                }
                if (generation == saveGeneration) {
                    break
                }
            }
        }
    }

    private fun persistLocally(snapshot: JSONObject) {
        val generation = ++saveGeneration
        _localSaving.value = true
        _localSaveFailed.value = false
        // Coalesce keystrokes into one write, but never leave an edit uncommitted for longer than MAX_UNSAVED_MS.
        val now = System.nanoTime() / 1_000_000
        if (pendingSince == 0L) pendingSince = now
        val wait = LOCAL_SAVE_DEBOUNCE_MS.coerceAtMost((pendingSince + MAX_UNSAVED_MS - now).coerceAtLeast(0))
        persistenceJob?.cancel()
        persistenceJob = viewModelScope.launch(Dispatchers.IO) {
            var failed = false
            try {
                delay(wait)
                persistenceMutex.withLock {
                    if (generation == saveGeneration && persistedGeneration < generation) {
                        repository.save(Note(snapshot), synchronize = false, profile = profile)
                        markPersisted(generation)
                        _localSaveFailed.value = false
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                failed = true
                if (generation == saveGeneration) _localSaveFailed.value = true
                _errors.emit(error.message ?: "Could not save draft on this device")
            } finally {
                if (generation == saveGeneration && (failed || persistedGeneration >= generation)) _localSaving.value = false
            }
        }
    }

    companion object {
        internal const val LOCAL_SAVE_DEBOUNCE_MS = 250L
        internal const val MAX_UNSAVED_MS = 1_000L
    }

    class Factory(private val app: KeptApplication, private val initial: Note) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            require(modelClass.isAssignableFrom(NoteEditorViewModel::class.java))
            return NoteEditorViewModel(app.repository, initial) as T
        }
    }
}
