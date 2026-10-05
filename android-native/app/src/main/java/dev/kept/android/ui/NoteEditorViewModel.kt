package dev.kept.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import dev.kept.android.KeptApplication
import dev.kept.android.data.EditorSnapshotPolicy
import dev.kept.android.data.Note
import dev.kept.android.data.copyJson
import dev.kept.android.data.KeptRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
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

    @Synchronized fun change(block: (JSONObject) -> Unit) {
        val next = _draft.value.copyJson().also(block)
        _draft.value = next
        _dirty.value = !EditorSnapshotPolicy.sameEditableContent(Note(next), serverBase)
        persistLocally(next)
    }

    @Synchronized fun replace(value: JSONObject) {
        val next = value.copyJson()
        _draft.value = next
        _dirty.value = !EditorSnapshotPolicy.sameEditableContent(Note(next), serverBase)
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
        _dirty.value = !noLaterEditThanAcceptedOperation && !EditorSnapshotPolicy.sameEditableContent(Note(rebased), accepted)
        if (_incoming.value?.revision?.let { it <= accepted.revision } == true) _incoming.value = null
    }

    suspend fun flushAndQueueSync() {
        persistenceMutex.withLock {
            while (true) {
                val generation = saveGeneration
                val snapshot = Note(_draft.value.copyJson())
                if (_dirty.value) {
                    repository.save(snapshot, synchronize = true, profile = profile)
                    _localSaveFailed.value = false
                }
                else if (profile == repository.settings.profile) repository.requestSync()
                if (generation == saveGeneration) {
                    break
                }
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
        persistenceJob?.cancel()
        persistenceJob = viewModelScope.launch(Dispatchers.IO) {
            try {
                persistenceMutex.withLock {
                    if (generation == saveGeneration) {
                        repository.save(Note(snapshot), synchronize = false, profile = profile)
                        _localSaveFailed.value = false
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                if (generation == saveGeneration) _localSaveFailed.value = true
                _errors.emit(error.message ?: "Could not save draft on this device")
            } finally {
                if (generation == saveGeneration) _localSaving.value = false
            }
        }
    }

    class Factory(private val app: KeptApplication, private val initial: Note) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            require(modelClass.isAssignableFrom(NoteEditorViewModel::class.java))
            return NoteEditorViewModel(app.repository, initial) as T
        }
    }
}
