package dev.kept.android.data

import android.content.Context
import android.text.Html
import androidx.room.withTransaction
import dev.kept.android.KeptApplication
import dev.kept.android.reminders.ReminderScheduler
import dev.kept.android.widgets.NotesWidget
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class KeptRepository(private val app: KeptApplication, val database: KeptDatabase,
    val settings: ConnectionProfile, val api: NativeApi, private val mediaUploader: MediaUploadPort = Media(app)) {
    private data class DecodedNote(val payload: String, val note: Note)

    val store = database.store()
    val status = MutableStateFlow(settings.message.takeIf { it.isNotBlank() }?.let { "Saved on device · $it" } ?: "Saved on device")
    val connectionState = MutableStateFlow<ConnectionState>(when {
        settings.message.contains("session expired", true) -> ConnectionState.SessionExpired(settings.message)
        settings.message.contains("access denied", true) -> ConnectionState.GatewayDenied(settings.message)
        settings.message.contains("certificate", true) -> ConnectionState.CertificateAttention(settings.message)
        settings.message.contains("protocol", true) -> ConnectionState.Incompatible(settings.message)
        settings.token.isBlank() -> ConnectionState.Configured
        else -> ConnectionState.Authenticated
    })
    val editors = MutableStateFlow<Map<Long, List<String>>>(emptyMap())
    private val _acceptedNoteSnapshots = MutableSharedFlow<ProfiledNoteSnapshot>(extraBufferCapacity = 16)
    val acceptedNoteSnapshots = _acceptedNoteSnapshots.asSharedFlow()
    private val _incomingNoteSnapshots = MutableSharedFlow<ProfiledNoteSnapshot>(extraBufferCapacity = 16)
    val incomingNoteSnapshots = _incomingNoteSnapshots.asSharedFlow()
    private val editMutex = Mutex()
    private val syncMutex = Mutex()
    private val acceptedRevisions = java.util.concurrent.ConcurrentHashMap<String, Long>()
    private val noteDecodeLock = Any()
    private var noteDecodeProfile = ""
    private val decodedNotes = mutableMapOf<String, DecodedNote>()
    private val reconcileScheduleLock = Any()
    private var pendingReconcile: Job? = null
    private var socket: WebSocket? = null
    private var socketConnection: ConnectionSnapshot? = null
    private var reconnect: Job? = null
    private val reconnectLock = Any()
    private val socketMutex = Mutex()
    @Volatile private var foreground = false
    private var joinedNote: Long? = null

    fun restoreConnectionState() {
        val message = settings.message
        status.value = message.takeIf { it.isNotBlank() }?.let { "Saved on device · $it" } ?: "Saved on device"
        connectionState.value = when {
            message.contains("session expired", true) -> ConnectionState.SessionExpired(message)
            message.contains("access denied", true) -> ConnectionState.GatewayDenied(message)
            message.contains("certificate", true) -> ConnectionState.CertificateAttention(message)
            message.contains("protocol", true) -> ConnectionState.Incompatible(message)
            settings.token.isBlank() -> ConnectionState.Configured
            else -> ConnectionState.Authenticated
        }
    }

    fun notes(): Flow<List<Note>> {
        val profile = settings.profile
        return store.observe(profile, "note")
            .distinctUntilChanged()
            .map { rows ->
                synchronized(noteDecodeLock) {
                    if (noteDecodeProfile != profile) {
                        noteDecodeProfile = profile
                        decodedNotes.clear()
                    }
                    val present = HashSet<String>(rows.size)
                    val projected = rows.map { row ->
                        present += row.syncId
                        val cached = decodedNotes[row.syncId]
                        if (cached?.payload == row.payload) cached.note
                        else Note(JSONObject(row.payload)).also { decodedNotes[row.syncId] = DecodedNote(row.payload, it) }
                    }
                    decodedNotes.keys.retainAll(present)
                    projected.sortedWith(NoteOrder.comparator)
                }
            }
            .flowOn(Dispatchers.Default)
    }
    fun reminders(): Flow<List<JSONObject>> = store.observe(settings.profile, "reminder")
        .distinctUntilChanged()
        .map { rows -> rows.map { JSONObject(it.payload) } }
        .flowOn(Dispatchers.Default)
    fun occurrences(): Flow<List<JSONObject>> = store.observe(settings.profile, "occurrence")
        .distinctUntilChanged()
        .map { rows -> rows.map { JSONObject(it.payload) } }
        .flowOn(Dispatchers.Default)
    fun conflicts(): Flow<List<Outbox>> = store.conflicts(settings.profile)
    suspend fun note(id: String): Note? = store.record(settings.profile, "note", id)?.let { Note(JSONObject(it.payload)) }
    fun observeNote(id: String): Flow<Note?> = store.observeRecord(settings.profile, "note", id)
        .distinctUntilChanged()
        .map { it?.let { row -> Note(JSONObject(row.payload)) } }
        .flowOn(Dispatchers.Default)

    suspend fun save(note: Note, synchronize: Boolean = true, profile: String = settings.profile) = editMutex.withLock {
        if (synchronize && profile != settings.profile) error("This draft belongs to a different Kept profile.")
        // Outbox reads must share the write transaction: a sync acknowledgement landing between them would leave the new
        // entry depending on a deleted operation, and it would never be sent.
        database.withTransaction {
            // Shallow: the copy is only serialized (once), so untouched nested fields need no deep copy.
            val raw = note.raw.shallowCopy().put("revision", knownRevision(profile, note))
            val payload = raw.toString()
            store.put(Record(profile, "note", note.syncId, payload))
            store.enqueue(noteUpsertEntry(profile, note.syncId, raw, payload))
        }
        if (profile == settings.profile) changed(synchronize, reconcile = true)
    }

    // Drops a never-synced, contentless note along with its queued upsert. SYNCED means the server may already know the
    // blank note, so the caller should trash it instead; KEPT means something (content, a reminder, an upload) needs it.
    suspend fun discardIfEmpty(syncId: String, profile: String = settings.profile): Discard = editMutex.withLock {
        val outcome = database.withTransaction {
            val note = store.record(profile, "note", syncId)?.let { Note(JSONObject(it.payload)) } ?: return@withTransaction Discard.KEPT
            val pending = store.pending(profile)
            val upserts = pending.filter { it.type == "note.upsert" && it.syncId == syncId }
            val referenced = store.list(profile, "reminder").any { JSONObject(it.payload).text("noteSyncId") == syncId } ||
                pending.any { entry ->
                    entry.type == "media.upload" &&
                        runCatching { JSONObject(entry.payload).text("noteSyncId") == syncId }.getOrDefault(false)
                }
            if (note.hasContent || referenced) return@withTransaction Discard.KEPT
            if (note.id > 0 || note.revision > 0 || upserts.any { it.state == OutboxState.IN_FLIGHT || it.attempted || it.conflict != null })
                return@withTransaction Discard.SYNCED
            store.remove(profile, "note", syncId)
            upserts.forEach { store.acknowledge(it.operationId) }
            Discard.DISCARDED
        }
        if (outcome == Discard.DISCARDED && profile == settings.profile) changed(synchronize = false)
        outcome
    }

    // Only call inside a transaction.
    private suspend fun noteUpsertEntry(profile: String, syncId: String, raw: JSONObject, payload: String = raw.toString()): Outbox {
        val conflicted = store.conflicted(profile, "note.upsert", syncId)
        if (conflicted != null) return conflicted.copy(payload = payload)
        val queued = store.queued(profile, "note.upsert", syncId)
        if (queued != null && !queued.attempted) return queued.copy(payload = payload)
        val pendingMedia = store.pending(profile).lastOrNull { entry ->
            entry.type == "media.upload" && entry.conflict == null &&
                runCatching { JSONObject(entry.payload).text("noteSyncId") == syncId }.getOrDefault(false)
        }
        val predecessor = queued ?: store.inFlight(profile, "note.upsert", syncId)
        return Outbox(UUID.randomUUID().toString(), profile, "note.upsert", syncId, payload,
            baseRevision = raw.optLong("revision"), dependsOnOperationId = pendingMedia?.operationId ?: predecessor?.operationId)
    }

    // The editor's copy can trail an acknowledgement this repository already applied.
    private fun knownRevision(profile: String, note: Note) = maxOf(note.revision, acceptedRevisions["$profile\u0000${note.syncId}"] ?: 0L)

    suspend fun reorder(ids: List<String>) = editMutex.withLock {
        val profile = settings.profile
        database.withTransaction {
            val base = System.currentTimeMillis().toDouble()
            ids.forEachIndexed { index, id ->
                note(id)?.let { note -> store.put(Record(profile, "note", id, note.raw.copyJson().put("sortOrder", base + ids.size - index).toString())) }
            }
            val queued = store.queued(profile, "note.reorder", "order")
            val predecessor = store.inFlight(profile, "note.reorder", "order")
            val previous = queued?.let { q -> JSONObject(q.payload).optJSONArray("syncIds")?.let { a -> List(a.length()) { a.getString(it) } } }.orEmpty()
            val merged = ids + previous.filter { it !in ids.toSet() }
            val payload = JSONObject().put("syncIds", JSONArray(merged)).toString()
            store.enqueue(queued?.copy(payload = payload) ?: Outbox(UUID.randomUUID().toString(), profile, "note.reorder", "order", payload,
                dependsOnOperationId = predecessor?.operationId))
        }
        changed()
    }

    suspend fun setTrashed(syncIds: List<String>, trashed: Boolean) = editMutex.withLock {
        val profile = settings.profile
        val edited = database.withTransaction {
            var count = 0
            syncIds.distinct().forEach { syncId ->
                val row = store.record(profile, "note", syncId) ?: return@forEach
                val note = Note(JSONObject(row.payload))
                require(note.owner == settings.userId) { "Only notes you own can be moved to or restored from Trash." }
                val raw = note.raw.copyJson().put("trashed", trashed).put("revision", knownRevision(profile, note))
                store.put(Record(profile, "note", syncId, raw.toString()))
                store.enqueue(noteUpsertEntry(profile, syncId, raw))
                count++
            }
            count
        }
        if (edited == 0) return@withLock
        if (profile == settings.profile) changed()
    }

    suspend fun setReminder(note: Note, due: String, timezone: String, repeat: String?) = editMutex.withLock {
        val profile = settings.profile
        database.withTransaction {
            require(store.record(profile, "note", note.syncId) != null) { "This note belongs to a different Kept profile." }
            val existing = store.list(profile, "reminder").map { JSONObject(it.payload) }
                .find { it.optLong("noteId") == note.id || it.text("noteSyncId") == note.syncId }
            val raw = existing?.copyJson() ?: JSONObject().put("id", -System.currentTimeMillis()).put("syncId", "reminder-${UUID.randomUUID()}")
            val requestedRule = Recurrence.normalizeRule(repeat)
            val existingRule = Recurrence.normalizeRule(existing?.text("repeatRule"))
            val definitionChanged = existing == null || !Recurrence.sameInstant(existing.text("dueAtUtc"), due) ||
                existing.text("timezone", "UTC") != timezone || existingRule != requestedRule
            raw.put("noteId", note.id).put("noteSyncId", note.syncId).put("userId", settings.userId).put("dueAtUtc", due)
                .put("timezone", timezone).put("repeatRule", requestedRule ?: JSONObject.NULL).put("status", "pending")
                .put("title", if (note.locked) "Kept reminder" else note.title).put("body", if (note.locked) "" else NoteFormat.displayText(note.body).take(500))
            val id = raw.getString("syncId")
            val conflicted = store.conflicted(profile, "reminder.upsert", id)
            val queued = store.queued(profile, "reminder.upsert", id)
            val inFlight = store.inFlight(profile, "reminder.upsert", id)
            val noteCreation = store.pending(profile).lastOrNull { it.type == "note.upsert" && it.syncId == note.syncId }
            val previous = conflicted ?: queued
            val baseScheduleVersion = previous?.baseScheduleVersion
                ?: existing?.takeIf { it.optLong("id") > 0 }?.optLong("scheduleVersion")
                ?: 0L
            val hasPendingDefinitionChange = previous != null && JSONObject(previous.payload).optLong("scheduleVersion") > baseScheduleVersion
            val scheduleVersion = baseScheduleVersion + if (definitionChanged || hasPendingDefinitionChange) 1 else 0
            val scheduleAnchorAtUtc = if (definitionChanged) due else existing?.text("scheduleAnchorAtUtc")?.takeIf { it.isNotBlank() }
                ?: existing?.text("dueAtUtc")?.takeIf { it.isNotBlank() } ?: due
            raw.put("scheduleVersion", scheduleVersion.coerceAtLeast(1)).put("scheduleAnchorAtUtc", scheduleAnchorAtUtc)
            store.put(Record(profile, "reminder", id, raw.toString()))
            val dependency = previous?.dependsOnOperationId ?: inFlight?.operationId
                ?: noteCreation?.takeIf { note.id <= 0 }?.operationId
            store.enqueue(previous?.copy(payload = raw.toString(), dependsOnOperationId = dependency)
                ?: Outbox(UUID.randomUUID().toString(), profile, "reminder.upsert", id, raw.toString(),
                    baseScheduleVersion = existing?.takeIf { it.optLong("id") > 0 }?.optLong("scheduleVersion"),
                    dependsOnOperationId = dependency))
        }
        changed()
    }

    suspend fun deleteReminder(id: String) = editMutex.withLock {
        val found = database.withTransaction {
            val existing = store.record(settings.profile, "reminder", id) ?: return@withTransaction false
            val raw = JSONObject(existing.payload)
            val queued = store.queued(settings.profile, "reminder.upsert", id)
            val inFlight = store.inFlight(settings.profile, "reminder.upsert", id)
            store.remove(settings.profile, "reminder", id)
            if (raw.optLong("id") < 0 && inFlight == null) {
                queued?.let { store.acknowledge(it.operationId) }
            } else {
                queued?.let { store.acknowledge(it.operationId) }
                store.enqueue(Outbox(UUID.randomUUID().toString(), settings.profile, "reminder.delete", id, raw.toString(),
                    baseScheduleVersion = raw.optLong("scheduleVersion").takeIf { it > 0 }, dependsOnOperationId = inFlight?.operationId))
            }
            true
        }
        if (found) changed()
    }

    suspend fun dismissReminder(id: String) = editMutex.withLock {
        val found = database.withTransaction {
            val existing = store.record(settings.profile, "reminder", id) ?: return@withTransaction false
            val raw = JSONObject(existing.payload).put("status", "dismissed")
            val queued = store.queued(settings.profile, "reminder.upsert", id)
            val conflicted = store.conflicted(settings.profile, "reminder.upsert", id)
            val inFlight = store.inFlight(settings.profile, "reminder.upsert", id)
            val previous = conflicted ?: queued
            store.put(Record(settings.profile, "reminder", id, raw.toString()))
            val dependency = previous?.dependsOnOperationId ?: inFlight?.operationId
            store.enqueue(previous?.copy(payload = raw.toString(), dependsOnOperationId = dependency)
                ?: Outbox(UUID.randomUUID().toString(), settings.profile, "reminder.upsert", id, raw.toString(),
                    baseScheduleVersion = raw.optLong("scheduleVersion").takeIf { it > 0 }, dependsOnOperationId = dependency))
            true
        }
        if (found) changed()
    }

    suspend fun occurrenceAction(occurrence: JSONObject, state: String, until: String? = null) = editMutex.withLock {
        val id = occurrence.getString("occurrenceId")
        val profile = settings.profile
        require(store.record(profile, "reminder", occurrence.text("syncId")) != null) { "This reminder belongs to a different Kept profile." }
        val raw = occurrence.copyJson().put("state", state).put("snoozeUntil", until ?: JSONObject.NULL)
        val payload = JSONObject().put("occurrenceId", id).put("reminderSyncId", raw.getString("syncId"))
            .put("scheduleVersion", raw.optLong("scheduleVersion", 1)).put("state", state).put("snoozeUntil", until ?: JSONObject.NULL)
        database.withTransaction {
            store.put(Record(profile, "occurrence", id, raw.toString()))
            val queued = store.queued(profile, "reminder.action", id)
            val inFlight = store.inFlight(profile, "reminder.action", id)
            store.enqueue(queued?.copy(payload = payload.toString()) ?: Outbox(UUID.randomUUID().toString(), profile,
                "reminder.action", id, payload.toString(), dependsOnOperationId = inFlight?.operationId))
        }
        if (profile == settings.profile) changed()
    }

    private fun changed(synchronize: Boolean = true, reconcile: Boolean = true) {
        status.value = "Saved on device · waiting to sync"
        if (reconcile) synchronized(reconcileScheduleLock) {
            pendingReconcile?.cancel()
            pendingReconcile = app.scope.launch {
                delay(250)
                reconcile()
            }
        }
        if (synchronize) app.enqueueSync(app)
    }

    /** Hands already-committed outbox work to the sync worker without rewriting or reconciling anything. */
    fun queueSync() = app.enqueueSync(app)

    fun requestSync() {
        app.scope.launch { reconcile() }
        app.enqueueSync(app)
    }

    fun authenticated() {
        connectionState.value = ConnectionState.Authenticated
        settings.message = ""
        status.value = "Saved on device · waiting to sync"
    }

    suspend fun reconcile() {
        app.reminders.reconcile()
        app.refreshWidgets(app)
    }

    suspend fun sync() = syncMutex.withLock {
        val connection = settings.snapshot()
        if (connection.token.isBlank()) return@withLock
        val profile = connection.profile
        var effectsChanged = false
        val acceptedThisSync = mutableSetOf<String>()
        try {
            status.value = "Syncing…"
            database.withTransaction {
                store.requeueInFlight(profile)
                // An edit queued behind an operation that was already acknowledged would otherwise wait forever.
                for (orphan in store.orphaned(profile)) {
                    val revision = if (orphan.type == "note.upsert") store.record(profile, "note", orphan.syncId)
                        ?.let { JSONObject(it.payload).optLong("revision") } else null
                    store.enqueue(orphan.copy(dependsOnOperationId = null, baseRevision = revision ?: orphan.baseRevision))
                }
            }
            while (true) {
                val entry = database.withTransaction {
                    val candidate = store.nextSendable(profile) ?: return@withTransaction null
                    if (store.markInFlight(candidate.operationId) != 1) null else candidate.copy(state = OutboxState.IN_FLIGHT)
                } ?: break
                try {
                    if (entry.type == "media.upload") {
                        val uploaded = try { mediaUploader.upload(entry, this) }
                        catch (error: ApiException) {
                            if (error.code == 401 || error.code == 429 || error.code >= 500) throw error
                            database.withTransaction {
                                val conflict = JSONObject().put("error", error.message.ifBlank {
                                    "The file could not be attached. Save the note and file as a copy to recover it."
                                }).toString()
                                store.enqueue(entry.copy(state = OutboxState.CONFLICT, conflict = conflict))
                                store.conflictDependents(profile, entry.operationId, conflict)
                            }
                            continue
                        }
                        database.withTransaction {
                            store.acknowledge(entry.operationId)
                            val source = JSONObject(entry.payload)
                            val noteSyncId = source.text("noteSyncId")
                            val noteRow = store.record(profile, "note", noteSyncId)
                            val acceptedRevision = uploaded.optLong("noteRevision").takeIf { it > 0 }
                            if (noteRow != null) {
                                val note = JSONObject(noteRow.payload)
                                acceptedRevision?.let { note.put("revision", it) }
                                if (uploaded.text("kind") == "image") {
                                    val image = uploaded.getJSONObject("image")
                                    val images = note.optJSONArray("images") ?: JSONArray()
                                    if ((0 until images.length()).none { images.optJSONObject(it)?.text("id") == image.text("id") }) images.put(image)
                                    note.put("images", images)
                                } else {
                                    val attachmentSyncId = uploaded.text("syncId")
                                    store.put(Record(profile, "attachment", attachmentSyncId, uploaded.toString()))
                                    acceptedThisSync += "attachment:$attachmentSyncId"
                                    val attachments = note.optJSONArray("attachments") ?: JSONArray()
                                    if ((0 until attachments.length()).none { attachments.optJSONObject(it)?.text("syncId") == attachmentSyncId }) {
                                        attachments.put(uploaded)
                                        note.put("attachments", attachments)
                                    }
                                }
                                store.put(noteRow.copy(payload = note.toString()))
                            }
                            acceptedThisSync += "note:$noteSyncId"
                            store.unblockDependents(profile, entry.operationId, acceptedRevision, null)
                        }
                        java.io.File(app.filesDir, "pending-media/${JSONObject(entry.payload).getString("file")}").delete()
                        continue
                    }

                    val mutation = JSONObject().put("type", entry.type).put("syncId", entry.syncId).put("operationId", entry.operationId)
                        .put("payload", JSONObject(entry.payload))
                    entry.baseRevision?.let { mutation.put("baseRevision", it) }
                    entry.baseScheduleVersion?.let { mutation.put("baseScheduleVersion", it) }
                    val response = JSONObject(api.call("/api/sync/mutations", "POST", NativeProtocol.mutationBatch(listOf(mutation), includeSnapshot = false), connection))
                    val result = response.getJSONArray("results").getJSONObject(0)
                    var retryError: ApiException? = null
                    var acceptedNote: Note? = null
                    var acceptedNoteSubmission: Note? = null
                    var incomingNote: Note? = null
                    database.withTransaction {
                        if (result.optBoolean("ok")) {
                            store.acknowledge(entry.operationId)
                            var acceptedRevision: Long? = null
                            if (entry.type == "note.upsert" && result.optLong("id") > 0) {
                                val current = store.record(profile, "note", entry.syncId)
                                if (current != null) {
                                    val saved = JSONObject(current.payload)
                                    val baseRevision = entry.baseRevision ?: saved.optLong("revision", 0)
                                    acceptedRevision = baseRevision + 1
                                    acceptedRevisions["$profile\u0000${entry.syncId}"] = acceptedRevision
                                    saved.put("id", result.getLong("id")).put("revision", maxOf(acceptedRevision, saved.optLong("revision")))
                                    store.put(current.copy(payload = saved.toString()))
                                    val acceptedSnapshot = result.optJSONObject("payload")
                                        ?: response.optJSONObject("snapshot")?.optJSONArray("notes")?.objects()
                                            ?.firstOrNull { it.text("syncId") == entry.syncId }
                                    acceptedNote = Note(acceptedSnapshot?.copyJson()
                                        ?: JSONObject(entry.payload).put("id", result.getLong("id")).put("revision", acceptedRevision))
                                    acceptedNoteSubmission = Note(JSONObject(entry.payload))
                                }
                            }
                            val reminderPayload = result.optJSONObject("payload")
                            var acceptedScheduleVersion: Long? = reminderPayload?.optLong("scheduleVersion")
                                ?.takeIf { entry.type == "reminder.upsert" }
                            if (entry.type == "reminder.upsert" && result.optLong("id") > 0) {
                                val canonicalSyncId = reminderPayload?.text("syncId", entry.syncId) ?: entry.syncId
                                val pendingSuccessor = store.dependents(profile, entry.operationId).any { it.type == "reminder.upsert" }
                                remapReminderIdentity(profile, entry.syncId, canonicalSyncId, result.getLong("id"), reminderPayload, pendingSuccessor)
                                acceptedThisSync += "reminder:$canonicalSyncId"
                            }
                            store.unblockDependents(profile, entry.operationId, acceptedRevision, acceptedScheduleVersion)
                            when {
                                entry.type.startsWith("note.") -> acceptedThisSync += "note:${entry.syncId}"
                                entry.type.startsWith("reminder.") -> acceptedThisSync += "reminder:${entry.syncId}"
                                entry.type.startsWith("attachment.") -> acceptedThisSync += "attachment:${entry.syncId}"
                            }
                        } else {
                            val statusCode = result.optInt("status", 400)
                            if (result.optBoolean("retryable") || statusCode >= 500 || statusCode == 429) {
                                retryError = ApiException(statusCode, result.text("error", "The server could not apply this change yet."))
                                store.requeue(entry.operationId)
                            } else {
                                store.enqueue(entry.copy(state = OutboxState.CONFLICT, conflict = result.toString()))
                                store.conflictDependents(profile, entry.operationId, result.toString())
                                if (entry.type == "note.upsert") incomingNote = result.optJSONObject("latest")?.let(::Note)
                            }
                        }
                        response.optJSONObject("snapshot")?.let { applySnapshot(profile, it, acceptedThisSync) }
                    }
                    acceptedNote?.let { _acceptedNoteSnapshots.tryEmit(ProfiledNoteSnapshot(profile, it, acceptedNoteSubmission)) }
                    incomingNote?.let { _incomingNoteSnapshots.tryEmit(ProfiledNoteSnapshot(profile, it)) }
                    retryError?.let { throw it }
                } catch (error: Exception) {
                    database.withTransaction { store.requeue(entry.operationId) }
                    throw error
                }
            }
            val cursor = store.cursor(profile)?.cursor
            if (cursor == null) {
                val snapshot = JSONObject(api.call("/api/sync/bootstrap", connection = connection))
                database.withTransaction { applySnapshot(profile, snapshot, acceptedThisSync) }
                effectsChanged = true
            } else {
                var current = cursor
                do {
                    val response = JSONObject(api.call("/api/sync/changes?cursor=$current", connection = connection))
                    var removedNote = false
                    var pageChanged = false
                    val incomingNotes = mutableListOf<Note>()
                    database.withTransaction {
                        val pending = store.pending(profile)
                        for (change in response.getJSONArray("changes").objects()) {
                            val kind = change.text("resourceType"); val id = change.text("resourceSyncId")
                            if (change.text("operation") == "delete") {
                                if (store.record(profile, kind, id) != null) {
                                    if (kind == "note") preserveRevokedNoteDrafts(profile, id)
                                    store.remove(profile, kind, id)
                                    pageChanged = true
                                    if (kind == "note") removedNote = true
                                }
                                pending.filter { it.syncId == id }.forEach { store.enqueue(it.copy(state = OutboxState.CONFLICT,
                                    conflict = JSONObject().put("error", "This item was removed or access was revoked.").toString())) }
                            } else if (pending.none { it.syncId == id }) {
                                change.optJSONObject("payload")?.let { payload ->
                                    val encoded = payload.toString()
                                    if (store.record(profile, kind, id)?.payload != encoded) {
                                        store.put(Record(profile, kind, id, encoded))
                                        pageChanged = true
                                    }
                                }
                            } else if (kind == "note") {
                                val remote = change.optJSONObject("payload")?.let(::Note)
                                val baseRevision = pending.firstOrNull { it.type == "note.upsert" && it.syncId == id }?.baseRevision
                                val local = store.record(profile, "note", id)?.let { Note(JSONObject(it.payload)) }
                                if (remote != null && local != null && remote.revision > (baseRevision ?: local.revision) &&
                                    !EditorSnapshotPolicy.sameEditableContent(local, remote)) incomingNotes += remote
                            }
                        }
                        current = response.getLong("cursor")
                        store.cursor(SyncState(profile, current))
                    }
                    incomingNotes.forEach { _incomingNoteSnapshots.tryEmit(ProfiledNoteSnapshot(profile, it)) }
                    if (removedNote) Media(app).clearProfile(profile)
                    if (pageChanged) effectsChanged = true
                } while (response.optBoolean("hasMore"))
            }
            val occurrences = JSONArray(api.call("/api/native/reminders/occurrences", connection = connection))
            if (database.withTransaction { applyOccurrences(profile, occurrences) }) effectsChanged = true
            val hasConflicts = store.pending(profile).any { it.conflict != null }
            status.value = if (hasConflicts) "An edit needs your attention" else "Synced"
            connectionState.value = ConnectionState.Authenticated
            if (settings.profile == profile) settings.message = ""
        } catch (error: Exception) {
            if (settings.profile == profile) {
                val message = error.message ?: "Connection unavailable"
                settings.message = message
                status.value = "Saved on device · ${settings.message}"
                connectionState.value = when {
                    error is ApiException && error.code == 401 -> ConnectionState.SessionExpired(message)
                    error is ApiException && error.code == 403 -> ConnectionState.GatewayDenied(message)
                    error is ApiException && error.code == 404 || message.contains("protocol", true) -> ConnectionState.Incompatible(message)
                    message.contains("certificate", true) || message.contains("TLS", true) || message.contains("secure connection", true) -> ConnectionState.CertificateAttention(message)
                    else -> ConnectionState.Offline(message)
                }
            }
            throw error
        } finally {
            if (effectsChanged || acceptedThisSync.isNotEmpty()) reconcile()
        }
    }

    private suspend fun applySnapshot(profile: String, snapshot: JSONObject, acceptedThisSync: Set<String> = emptySet()) {
        val pending = store.pending(profile)
        var removedNote = false
        val incomingNotes = snapshot.optJSONArray("notes")?.objects().orEmpty()
        val incomingNoteIds = incomingNotes.map { it.optLong("id") }.toSet()
        val incomingNoteSyncIds = incomingNotes.map { it.text("syncId") }.toSet()
        val acceptedOwnedNotes = mutableSetOf<String>()
        for (key in acceptedThisSync.filter { it.startsWith("note:") }) {
            val syncId = key.removePrefix("note:")
            if (store.record(profile, "note", syncId)?.let { Note(JSONObject(it.payload)).owner == settings.userId } == true) {
                acceptedOwnedNotes += syncId
            }
        }
        for ((arrayName, kind) in listOf("notes" to "note", "reminders" to "reminder", "attachments" to "attachment")) {
            val incoming = snapshot.optJSONArray(arrayName)?.objects().orEmpty()
            val ids = incoming.map { it.text("syncId") }.toSet()
            for (row in store.list(profile, kind)) {
                val accepted = "$kind:${row.syncId}" in acceptedThisSync
                val local = runCatching { JSONObject(row.payload) }.getOrNull()
                val protectedByAcceptedOperation = accepted && when (kind) {
                    "note" -> local?.optLong("ownerUserId") == settings.userId
                    "reminder" -> {
                        val noteId = local?.optLong("noteId") ?: 0L
                        val noteSyncId = local?.text("noteSyncId").orEmpty()
                        noteId == 0L || noteId in incomingNoteIds || noteSyncId in incomingNoteSyncIds || noteSyncId in acceptedOwnedNotes
                    }
                    "attachment" -> (local?.optLong("noteId") ?: 0L) in incomingNoteIds
                    else -> false
                }
                val hasQueuedWork = pending.any { it.syncId == row.syncId && it.conflict == null }
                if (row.syncId !in ids && !protectedByAcceptedOperation && !hasQueuedWork) {
                    if (kind == "note") preserveRevokedNoteDrafts(profile, row.syncId)
                    store.remove(profile, kind, row.syncId)
                    if (kind == "note") removedNote = true
                    pending.filter { it.syncId == row.syncId }.forEach { store.enqueue(it.copy(state = OutboxState.CONFLICT,
                        conflict = JSONObject().put("error", "This item is no longer accessible.").toString())) }
                }
            }
            for (raw in incoming) {
                val id = raw.text("syncId")
                if (kind == "note" && "$kind:$id" !in acceptedThisSync) {
                    val pendingNote = pending.firstOrNull { it.type == "note.upsert" && it.syncId == id }
                    val local = store.record(profile, "note", id)?.let { Note(JSONObject(it.payload)) }
                    val remote = Note(raw)
                    if (pendingNote != null && local != null && remote.revision > (pendingNote.baseRevision ?: local.revision) &&
                        !EditorSnapshotPolicy.sameEditableContent(local, remote)) _incomingNoteSnapshots.tryEmit(ProfiledNoteSnapshot(profile, remote))
                }
                if (pending.none { it.syncId == id && it.conflict == null }) store.put(Record(profile, kind, id, raw.toString()))
            }
        }
        applyOccurrences(profile, snapshot.optJSONArray("occurrences") ?: JSONArray())
        store.cursor(SyncState(profile, snapshot.optLong("cursor")))
        if (removedNote) Media(app).clearProfile(profile)
    }

    private suspend fun remapReminderIdentity(profile: String, sourceSyncId: String, targetSyncId: String,
        serverId: Long, serverPayload: JSONObject?, hasPendingSuccessor: Boolean) {
        val source = store.record(profile, "reminder", sourceSyncId)
        if (source != null) {
            val saved = if (!hasPendingSuccessor && serverPayload != null) serverPayload.copyJson() else JSONObject(source.payload).apply {
                put("id", serverId).put("syncId", targetSyncId)
                serverPayload?.let { remote ->
                    if (!remote.isNull("noteId")) put("noteId", remote.optLong("noteId"))
                    if (!remote.isNull("scheduleVersion")) put("scheduleVersion", remote.optLong("scheduleVersion"))
                    if (!remote.isNull("scheduleAnchorAtUtc")) put("scheduleAnchorAtUtc", remote.optString("scheduleAnchorAtUtc"))
                }
            }
            if (sourceSyncId != targetSyncId) store.remove(profile, "reminder", sourceSyncId)
            store.put(Record(profile, "reminder", targetSyncId, saved.toString()))
        }
        if (sourceSyncId == targetSyncId) return

        for (operation in store.pending(profile)) {
            if (operation.type == "reminder.upsert" || operation.type == "reminder.delete") {
                if (operation.syncId == sourceSyncId) {
                    val payload = JSONObject(operation.payload).put("syncId", targetSyncId)
                    store.enqueue(operation.copy(syncId = targetSyncId, payload = payload.toString()))
                }
            } else if (operation.type == "reminder.action") {
                val payload = JSONObject(operation.payload)
                if (payload.text("reminderSyncId") != sourceSyncId) continue
                val occurrence = store.record(profile, "occurrence", operation.syncId)
                if (occurrence == null) {
                    store.enqueue(operation.copy(state = OutboxState.CONFLICT,
                        conflict = JSONObject().put("error", "Reminder identity changed while this action was pending.").toString()))
                    continue
                }
                val raw = JSONObject(occurrence.payload).put("syncId", targetSyncId)
                val newOccurrenceId = Recurrence.occurrenceId(targetSyncId, raw.text("dueAtUtc"), raw.optLong("scheduleVersion", 1))
                raw.put("occurrenceId", newOccurrenceId)
                payload.put("reminderSyncId", targetSyncId).put("occurrenceId", newOccurrenceId)
                store.remove(profile, "occurrence", operation.syncId)
                store.put(Record(profile, "occurrence", newOccurrenceId, raw.toString()))
                store.enqueue(operation.copy(syncId = newOccurrenceId, payload = payload.toString()))
            }
        }
    }

    private suspend fun preserveRevokedNoteDrafts(profile: String, noteSyncId: String) {
        val note = store.record(profile, "note", noteSyncId)?.let { JSONObject(it.payload) }
        val queued = store.pending(profile)
        val hasLocalDraft = queued.any { entry -> entry.syncId == noteSyncId ||
            (entry.type == "media.upload" && runCatching { JSONObject(entry.payload).text("noteSyncId") == noteSyncId }.getOrDefault(false)) }
        if (hasLocalDraft && note != null) store.put(Record(profile, "recovery", noteSyncId, note.toString()))
        val noteId = note?.optLong("id") ?: 0L
        val reminders = store.list(profile, "reminder").filter { row ->
            val raw = JSONObject(row.payload)
            (noteId > 0 && raw.optLong("noteId") == noteId) || raw.text("noteSyncId") == noteSyncId
        }
        val reminderIds = reminders.map { it.syncId }.toSet()
        val occurrences = store.list(profile, "occurrence").filter { row ->
            JSONObject(row.payload).text("syncId") in reminderIds
        }
        val attachments = if (noteId > 0) store.list(profile, "attachment").filter { row -> JSONObject(row.payload).optLong("noteId") == noteId } else emptyList()
        reminders.forEach { store.remove(profile, "reminder", it.syncId) }
        occurrences.forEach { store.remove(profile, "occurrence", it.syncId) }
        attachments.forEach { store.remove(profile, "attachment", it.syncId) }
        val relatedIds = reminderIds + occurrences.map { it.syncId } + attachments.map { it.syncId }
        for (entry in store.pending(profile)) {
            val mediaForNote = entry.type == "media.upload" && runCatching { JSONObject(entry.payload).text("noteSyncId") == noteSyncId }.getOrDefault(false)
            if (entry.syncId == noteSyncId || entry.syncId in relatedIds || mediaForNote) {
                store.enqueue(entry.copy(state = OutboxState.CONFLICT,
                    conflict = JSONObject().put("error", "This note is no longer accessible. Your local change is saved for recovery and will not be sent.").toString()))
            }
        }
    }

    private suspend fun applyOccurrences(profile: String, incoming: JSONArray): Boolean {
        val pending = store.pending(profile)
        val ids = incoming.objects().map { it.getString("occurrenceId") }.toSet()
        var changed = false
        for (row in store.list(profile, "occurrence")) {
            if (row.syncId !in ids && pending.none { it.syncId == row.syncId }) {
                store.remove(profile, "occurrence", row.syncId)
                changed = true
            }
        }
        for (raw in incoming.objects()) {
            val id = raw.getString("occurrenceId")
            if (pending.none { it.syncId == id } && store.record(profile, "occurrence", id)?.payload != raw.toString()) {
                store.put(Record(profile, "occurrence", id, raw.toString()))
                changed = true
            }
        }
        return changed
    }

    suspend fun resolve(entry: Outbox, resolution: ConflictResolution) = editMutex.withLock {
        val conflict = JSONObject(entry.conflict!!)
        val latest = conflict.optJSONObject("latest")
        database.withTransaction {
            when (entry.type) {
                "note.upsert" -> when (resolution) {
                    ConflictResolution.REPLACE_WITH_DRAFT -> {
                        require(latest != null) { "The server version is unavailable; save this draft as a copy instead." }
                        val merged = rebaseNoteDraft(Note(latest), Note(JSONObject(entry.payload)))
                        store.acknowledge(entry.operationId)
                        store.put(Record(entry.profile, "note", entry.syncId, merged.toString()))
                        store.enqueue(entry.copy(operationId = UUID.randomUUID().toString(), payload = merged.toString(),
                            baseRevision = latest.getLong("revision"), state = OutboxState.QUEUED, dependsOnOperationId = null, conflict = null,
                            attempted = false))
                        store.remove(entry.profile, "recovery", entry.syncId)
                    }
                    ConflictResolution.SAVE_AS_COPY -> {
                        recoverAsCopy(entry.profile, entry.syncId, JSONObject(entry.payload))
                    }
                    ConflictResolution.USE_SERVER, ConflictResolution.DISCARD -> {
                        store.acknowledge(entry.operationId)
                        if (latest != null) store.put(Record(entry.profile, "note", entry.syncId, latest.toString()))
                        else store.remove(entry.profile, "note", entry.syncId)
                        store.remove(entry.profile, "recovery", entry.syncId)
                        discardUploads(entry.profile, entry.syncId)
                    }
                }
                "reminder.upsert" -> when (resolution) {
                    ConflictResolution.REPLACE_WITH_DRAFT -> {
                        require(latest != null) { "The server schedule is unavailable; this reminder cannot be replaced safely." }
                        val draft = JSONObject(entry.payload).put("id", latest.optLong("id"))
                            .put("syncId", latest.text("syncId", entry.syncId)).put("userId", latest.optLong("userId"))
                        val latestVersion = latest.optLong("scheduleVersion", 1).coerceAtLeast(1)
                        draft.put("scheduleVersion", latestVersion + 1)
                        draft.put("scheduleAnchorAtUtc", draft.text("dueAtUtc", latest.text("dueAtUtc")))
                        store.acknowledge(entry.operationId)
                        store.put(Record(entry.profile, "reminder", entry.syncId, draft.toString()))
                        store.enqueue(entry.copy(operationId = UUID.randomUUID().toString(), payload = draft.toString(),
                            baseScheduleVersion = latestVersion, state = OutboxState.QUEUED,
                            dependsOnOperationId = null, conflict = null))
                        removeOccurrencesForReminder(entry.profile, entry.syncId)
                    }
                    ConflictResolution.USE_SERVER, ConflictResolution.DISCARD -> {
                        store.acknowledge(entry.operationId)
                        if (latest != null) store.put(Record(entry.profile, "reminder", entry.syncId, latest.toString()))
                        else store.remove(entry.profile, "reminder", entry.syncId)
                        removeOccurrencesForReminder(entry.profile, entry.syncId)
                    }
                    ConflictResolution.SAVE_AS_COPY -> error("Reminder conflicts cannot be converted into notes.")
                }
                "reminder.action", "note.view-state", "note.reorder" -> {
                    store.acknowledge(entry.operationId)
                    if (entry.type == "reminder.action") store.remove(entry.profile, "occurrence", entry.syncId)
                    if (entry.type == "note.view-state" && latest != null) store.put(Record(entry.profile, "note", entry.syncId, latest.toString()))
                }
                "media.upload" -> when (resolution) {
                    ConflictResolution.SAVE_AS_COPY -> {
                        val source = JSONObject(entry.payload).text("noteSyncId")
                        val draft = store.pending(entry.profile).firstOrNull { it.type == "note.upsert" && it.syncId == source }?.payload
                            ?: store.record(entry.profile, "recovery", source)?.payload
                        recoverAsCopy(entry.profile, source, draft?.let(::JSONObject), listOf(entry))
                    }
                    ConflictResolution.USE_SERVER, ConflictResolution.DISCARD ->
                        discardUploads(entry.profile, JSONObject(entry.payload).text("noteSyncId"), listOf(entry))
                    ConflictResolution.REPLACE_WITH_DRAFT -> error("Resolve this file conflict by saving a copy or discarding the upload.")
                }
                else -> {
                    store.acknowledge(entry.operationId)
                }
            }
        }
        if (entry.profile == settings.profile) changed()
    }

    private fun rebaseNoteDraft(latest: Note, draft: Note): JSONObject {
        val serverOwned = setOf("id", "syncId", "revision", "ownerUserId", "createdAt", "updatedAt", "sortOrder",
            "completedChecklistCollapsed", "lwwPhysicalMs", "lwwLogical", "lwwDeviceId", "lwwOperationId",
            "collaborators", "ownerDisplayName", "ownerUsername", "ownerAvatarDataUrl", "ownerAvatarPreset",
            "lastEditorUserId", "lastEditorDisplayName", "attachments", "isDemo")
        val merged = latest.raw.copyJson()
        val keys = draft.raw.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (!serverOwned.contains(key)) merged.put(key, draft.raw.get(key))
        }
        return merged
    }

    private suspend fun removeOccurrencesForReminder(profile: String, reminderSyncId: String) {
        for (row in store.list(profile, "occurrence")) {
            if (JSONObject(row.payload).text("syncId") == reminderSyncId) store.remove(profile, "occurrence", row.syncId)
        }
    }

    suspend fun preserveDraftForRecovery(note: Note, profile: String = settings.profile) = editMutex.withLock {
        database.withTransaction {
            store.put(Record(profile, "recovery", note.syncId, note.raw.toString()))
            val existing = store.pending(profile).firstOrNull { it.type == "note.upsert" && it.syncId == note.syncId }
            val inFlight = existing?.state == OutboxState.IN_FLIGHT
            val entry = if (existing != null && !inFlight) existing.copy(payload = note.raw.toString()) else Outbox(
                UUID.randomUUID().toString(), profile, "note.upsert", note.syncId, note.raw.toString(), note.revision,
                dependsOnOperationId = existing?.operationId
            )
            store.enqueue(entry.copy(state = OutboxState.CONFLICT,
                conflict = JSONObject().put("error", "This note is no longer accessible. Recover your saved draft as a new note.").toString()))
        }
    }

    suspend fun recoverDraftAsCopy(profile: String, syncId: String) = editMutex.withLock {
        val raw = store.record(profile, "recovery", syncId)?.payload
            ?: store.pending(profile).firstOrNull { it.type == "note.upsert" && it.syncId == syncId }?.payload
            ?: error("The local draft is no longer available.")
        database.withTransaction { recoverAsCopy(profile, syncId, JSONObject(raw)) }
        changed()
    }

    private suspend fun recoverAsCopy(profile: String, sourceSyncId: String, original: JSONObject?, extraUploads: List<Outbox> = emptyList()) {
        val recoveryUserId = profile.substringAfterLast('#').toLongOrNull() ?: settings.userId
        val copy = (original?.copyJson() ?: Note.create(settings.userId).raw).apply {
            put("syncId", "note-${UUID.randomUUID()}").put("id", -System.currentTimeMillis())
                .put("ownerUserId", recoveryUserId).put("revision", 0).put("pinned", false)
                .put("archived", false).put("trashed", false).put("collaborators", JSONArray())
            remove("ownerDisplayName"); remove("ownerUsername"); remove("ownerAvatarDataUrl"); remove("ownerAvatarPreset")
            remove("lastEditorUserId"); remove("lastEditorDisplayName")
            remove("attachments")
            optJSONArray("images")?.let { images ->
                put("images", JSONArray(images.objects().filterNot { isPrivateImageReference(profile, it.text("dataUrl")) }))
            }
            val body = text("noteBody")
            val imageTag = Regex("<img\\b[^>]*>", RegexOption.IGNORE_CASE)
            val sourceAttribute = Regex("""\bsrc\s*=\s*(['\"])(.*?)\1""", RegexOption.IGNORE_CASE)
            put("noteBody", imageTag.replace(body) { match ->
                val source = sourceAttribute.find(match.value)?.groupValues?.get(2).orEmpty()
                if (isPrivateImageReference(profile, source)) "" else match.value
            })
        }
        val targetSyncId = copy.getString("syncId")
        store.put(Record(profile, "note", targetSyncId, copy.toString()))
        val copyOperationId = UUID.randomUUID().toString()
        store.enqueue(Outbox(copyOperationId, profile, "note.upsert", targetSyncId, copy.toString(), baseRevision = 0))
        store.remove(profile, "recovery", sourceSyncId)
        for (pending in store.pending(profile).filter { it.type == "note.upsert" && it.syncId == sourceSyncId }) store.acknowledge(pending.operationId)
        rehomeUploads(profile, sourceSyncId, targetSyncId, copyOperationId, extraUploads)
    }

    private fun isPrivateImageReference(profile: String, source: String): Boolean {
        if (source.startsWith("/api/uploads/images/")) return true
        val target = runCatching { java.net.URI(source) }.getOrNull() ?: return false
        val origin = runCatching { java.net.URI(profile.substringBefore('#')) }.getOrNull() ?: return false
        fun port(uri: java.net.URI) = uri.port.takeIf { it >= 0 } ?: if (uri.scheme.equals("https", true)) 443 else 80
        return target.host != null && target.host.equals(origin.host, true) && port(target) == port(origin) &&
            target.path.orEmpty().startsWith("/api/uploads/images/")
    }

    private suspend fun rehomeUploads(profile: String, sourceSyncId: String, targetSyncId: String, targetOperationId: String, extraUploads: List<Outbox> = emptyList()) {
        val uploads = (store.pending(profile) + extraUploads).distinctBy { it.operationId }.filter {
            it.type == "media.upload" && runCatching { JSONObject(it.payload).text("noteSyncId") == sourceSyncId }.getOrDefault(false)
        }
        for (entry in uploads) {
            val payload = JSONObject(entry.payload).put("noteSyncId", targetSyncId)
            val file = payload.text("file")
            store.acknowledge(entry.operationId)
            store.enqueue(entry.copy(operationId = UUID.randomUUID().toString(), syncId = "$targetSyncId:$file", payload = payload.toString(),
                state = OutboxState.QUEUED, conflict = null, dependsOnOperationId = targetOperationId))
        }
    }

    private suspend fun discardUploads(profile: String, sourceSyncId: String, extraUploads: List<Outbox> = emptyList()) {
        for (entry in (store.pending(profile) + extraUploads).distinctBy { it.operationId }.filter {
            it.type == "media.upload" && runCatching { JSONObject(it.payload).text("noteSyncId") == sourceSyncId }.getOrDefault(false)
        }) {
            val file = runCatching { JSONObject(entry.payload).text("file") }.getOrDefault("")
            store.acknowledge(entry.operationId)
            if (file.isNotEmpty()) java.io.File(app.filesDir, "pending-media/$file").delete()
        }
        store.remove(profile, "recovery", sourceSyncId)
    }

    suspend fun shareUsers(): List<JSONObject> = JSONArray(api.call("/api/sharing/users")).objects()
    suspend fun setChecklistCollapsed(note: Note, collapsed: Boolean, profile: String = settings.profile) = editMutex.withLock {
        val raw = note.raw.copyJson().put("completedChecklistCollapsed", collapsed)
        val payload = JSONObject().put("completedChecklistCollapsed", collapsed).toString()
        database.withTransaction {
            require(store.record(profile, "note", note.syncId) != null) { "This note belongs to a different Kept profile." }
            val queued = store.queued(profile, "note.view-state", note.syncId)
            val conflicted = store.conflicted(profile, "note.view-state", note.syncId)
            val inFlight = store.inFlight(profile, "note.view-state", note.syncId)
            val noteCreation = store.pending(profile).lastOrNull { it.type == "note.upsert" && it.syncId == note.syncId }
            val previous = conflicted ?: queued
            val dependency = previous?.dependsOnOperationId ?: inFlight?.operationId
                ?: noteCreation?.takeIf { note.id <= 0 }?.operationId
            store.put(Record(profile, "note", note.syncId, raw.toString()))
            store.enqueue(previous?.copy(payload = payload, dependsOnOperationId = dependency)
                ?: Outbox(UUID.randomUUID().toString(), profile, "note.view-state", note.syncId, payload,
                    dependsOnOperationId = dependency))
        }
        if (profile == settings.profile) changed()
    }

    suspend fun share(note: Note, userIds: List<Long>) {
        val connection = settings.snapshot()
        require(store.record(connection.profile, "note", note.syncId) != null) { "This note belongs to a different Kept profile." }
        sync()
        if (settings.profile != connection.profile) error("The active Kept profile changed. Reopen the note before sharing it.")
        val saved = store.record(connection.profile, "note", note.syncId)?.let { Note(JSONObject(it.payload)) } ?: error("Save the note first")
        require(saved.id > 0) { "Connect to save this note before sharing it." }
        api.call("/api/notes/${saved.id}/collaborators", "PUT", JSONObject().put("userIds", JSONArray(userIds)), connection)
        if (settings.profile == connection.profile) sync()
    }

    suspend fun toggleChecklist(id: String, itemId: Long) {
        val note = note(id) ?: return
        if (note.locked) return
        val raw = note.raw.copyJson()
        raw.optJSONArray("checkBoxes")?.objects()?.find { it.optLong("id") == itemId }?.let { it.put("done", !it.optBoolean("done")) }
        save(Note(raw))
    }

    suspend fun attach(note: Note, file: JSONObject) = editMutex.withLock {
        val profile = settings.profile
        val key = "${note.syncId}:${file.getString("file")}" // Multiple uploads on one note remain separate.
        database.withTransaction {
            require(store.record(profile, "note", note.syncId) != null) { "This note belongs to a different Kept profile." }
            val noteCreation = store.pending(profile).lastOrNull { it.type == "note.upsert" && it.syncId == note.syncId }
            store.enqueue(Outbox(UUID.randomUUID().toString(), profile, "media.upload", key,
                file.copyJson().put("noteSyncId", note.syncId).toString(), dependsOnOperationId = noteCreation?.operationId))
        }
        changed()
    }

    fun presence(noteId: Long?) {
        joinedNote?.let { socket?.send(JSONObject().put("type", "leave-note").put("noteId", it).toString()) }
        joinedNote = noteId?.takeIf { it > 0 }
        joinedNote?.let { socket?.send(JSONObject().put("type", "join-note").put("noteId", it).toString()) }
    }

    /**
     * Records whether the app is visible and reconciles the realtime socket with that. The wanted state is stored
     * synchronously, so quick stop/start pairs resolve to the latest one whatever order the work is scheduled in.
     */
    fun setForeground(active: Boolean) {
        foreground = active
        app.scope.launch { settings.awaitReady(); applyForeground() }
    }

    suspend fun foreground(active: Boolean) {
        foreground = active
        applyForeground()
    }

    // One socket per connection snapshot: concurrent callers (start, login, reconnect) queue here and each re-reads
    // the wanted state, instead of all seeing no socket and opening one each.
    private suspend fun applyForeground(): Unit = socketMutex.withLock {
        if (!foreground) {
            reconnect?.cancel(); reconnect = null
            socket?.cancel(); socket = null; socketConnection = null
            return@withLock
        }
        val connection = settings.snapshot()
        if (connection.token.isEmpty()) return@withLock
        if (socket != null && socketConnection != connection) { socket?.cancel(); socket = null; socketConnection = null }
        if (socket != null) return@withLock
        withContext(Dispatchers.IO) {
            val request = api.request("/api/realtime", connection).build()
            socketConnection = connection
            socket = api.client(connection).newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (settings.snapshot() != connection || socketConnection != connection) return
                    joinedNote?.let { webSocket.send(JSONObject().put("type", "join-note").put("noteId", it).toString()) }
                }
                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (settings.snapshot() != connection || socketConnection != connection) return
                    val message = runCatching { JSONObject(text) }.getOrNull() ?: return
                    if (message.text("type") in setOf("notes-changed", "reminder-fired")) app.scope.launch { runCatching { sync() } }
                    if (message.text("type") == "presence-update") {
                        editors.value = editors.value + (message.optLong("noteId") to message.optJSONArray("activeEditors")?.objects().orEmpty().map { it.text("displayName", it.text("username")) })
                    }
                }
                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = disconnected(webSocket)
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = disconnected(webSocket)
                private fun disconnected(closed: WebSocket) {
                    synchronized(reconnectLock) {
                        // A socket that was already replaced or cancelled must not tear down its successor.
                        if (socket !== closed || socketConnection != connection) return
                        socket = null
                        socketConnection = null
                        if (!foreground) return
                        reconnect?.cancel()
                        reconnect = app.scope.launch { delay(5000); runCatching { applyForeground(); sync() } }
                    }
                }
            })
        }
    }

    suspend fun logout() = syncMutex.withLock { editMutex.withLock {
        foreground(false)
        val profile = settings.profile
        settings.token = ""
        settings.awaitWrites()
        app.reminders.cancelAll()
        Media(app).clearProfile(profile, pendingUploads = true)
        database.withTransaction { store.clearRecords(profile); store.clearOutbox(profile); store.clearDelivery(profile); store.clearCursor(profile) }
        SyncWorker.cancel(app)
        settings.userId = 0
        settings.awaitWrites()
        connectionState.value = ConnectionState.Configured
        app.refreshWidgets(app)
    } }
}
