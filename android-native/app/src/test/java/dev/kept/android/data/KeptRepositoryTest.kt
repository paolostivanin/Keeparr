package dev.kept.android.data

import android.app.PendingIntent
import android.util.Base64
import androidx.room.Room
import androidx.room.withTransaction
import dev.kept.android.KeptApplication
import dev.kept.android.ui.NoteEditorViewModel
import dev.kept.android.reminders.ReminderController
import dev.kept.android.reminders.ReminderAlarmScheduler
import dev.kept.android.reminders.ReminderNotificationSink
import dev.kept.android.reminders.ReminderScheduler
import kotlinx.coroutines.cancel
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.flow.collect
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class KeptRepositoryTest {
    private lateinit var app: KeptApplication
    private lateinit var profile: FakeProfile
    private lateinit var repository: KeptRepository

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeptApplication
        app.scope.coroutineContext.cancel()
        app.database.close()
        profile = FakeProfile("https://one.example.test", 11)
        app.settings = profile
        app.database = Room.inMemoryDatabaseBuilder(app, KeptDatabase::class.java).allowMainThreadQueries().build()
        app.reminders = FakeReminderController()
        app.refreshWidgets = {}
        app.enqueueSync = {}
        repository = KeptRepository(app, app.database, profile, FakeNativeApi())
        app.repository = repository
    }

    @After fun tearDown() {
        app.database.close()
        app.scope.coroutineContext.cancel()
    }

    @Test fun localEditsAndOutboxAreCommittedTogetherAndUnsentEditsCoalesce() = runBlocking {
        val original = Note.create(profile.userId)
        repository.save(original)
        val first = repository.store.pending(profile.profile).single()
        assertEquals(0L, first.baseRevision)
        assertEquals(original.syncId, repository.store.record(profile.profile, "note", original.syncId)?.syncId)

        val secondDraft = original.raw.copyJson().put("noteTitle", "Edited offline")
        repository.save(Note(secondDraft))
        val pending = repository.store.pending(profile.profile).single()
        assertEquals("a known-unsent operation may be coalesced in place", first.operationId, pending.operationId)
        assertEquals(first.createdAt, pending.createdAt)
        assertEquals("Edited offline", JSONObject(pending.payload).getString("noteTitle"))
        assertEquals(0L, pending.baseRevision)
    }

    @Test fun reminderWritesDoNotReparseOrReemitTheNoteCollection() = runBlocking {
        val note = Note.create(profile.userId)
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        val initial = CompletableDeferred<List<Note>>()
        val emissions = AtomicInteger()
        val collector = launch {
            repository.notes().collect { value ->
                emissions.incrementAndGet()
                initial.complete(value)
            }
        }
        assertEquals(listOf(note.syncId), withTimeoutOrNull(2000) { initial.await() }?.map { it.syncId })

        repository.store.put(Record(profile.profile, "reminder", "reminder-1", "{\"syncId\":\"reminder-1\"}"))
        delay(150)

        assertEquals("unrelated Room rows do not trigger note decoding/projection emissions", 1, emissions.get())
        collector.cancel()
    }

    @Test fun oneNoteWriteReusesDecodedObjectsForUnchangedRows() = runBlocking {
        val first = Note.create(profile.userId)
        val unchanged = Note.create(profile.userId)
        repository.store.put(Record(profile.profile, "note", first.syncId, first.raw.toString()))
        repository.store.put(Record(profile.profile, "note", unchanged.syncId, unchanged.raw.toString()))
        val initial = CompletableDeferred<List<Note>>()
        val updated = CompletableDeferred<List<Note>>()
        val collector = launch {
            repository.notes().collect { value ->
                if (!initial.isCompleted) initial.complete(value) else updated.complete(value)
            }
        }
        val original = withTimeoutOrNull(2_000) { initial.await() } ?: error("initial note projection did not emit")

        repository.store.put(Record(profile.profile, "note", first.syncId,
            first.raw.copyJson().put("noteTitle", "Changed only one row").toString()))
        val next = withTimeoutOrNull(2_000) { updated.await() } ?: error("updated note projection did not emit")

        assertSame("Unchanged documents should reuse their decoded model object.",
            original.first { it.syncId == unchanged.syncId }, next.first { it.syncId == unchanged.syncId })
        collector.cancel()
    }

    @Test fun bulkTrashQueuesOwnedNotesAndRestoreClearsTheirTrashedState() = runBlocking {
        val notes = listOf(
            Note(Note.create(profile.userId).raw.put("noteTitle", "First").put("bgColor", "#5b2121")),
            Note(Note.create(profile.userId).raw.put("noteTitle", "Second").put("bgColor", "#fddcbb"))
        )
        notes.forEach { repository.store.put(Record(profile.profile, "note", it.syncId, it.raw.toString())) }

        repository.setTrashed(notes.map { it.syncId }, true)

        assertTrue(notes.all { repository.note(it.syncId)!!.trashed })
        assertEquals(listOf("#5b2121", "#fddcbb"), notes.map { repository.note(it.syncId)!!.raw.getString("bgColor") })
        assertEquals(2, repository.store.pending(profile.profile).count { it.type == "note.upsert" })
        repository.setTrashed(notes.map { it.syncId }, false)
        assertTrue(notes.all { !repository.note(it.syncId)!!.trashed })
        assertEquals(listOf("#5b2121", "#fddcbb"), notes.map { repository.note(it.syncId)!!.raw.getString("bgColor") })
        assertTrue(repository.store.pending(profile.profile).all { !JSONObject(it.payload).optBoolean("trashed") })
    }

    @Test fun rapidEditorChangesPersistTheLatestDraftBeforeRemoteSync() = runBlocking {
        val original = Note(Note.create(profile.userId).raw.put("id", 55).put("revision", 4))
        repository.save(original, synchronize = false)
        val editor = NoteEditorViewModel(repository, original)
        val initialGeneration = editor.draftGeneration.value
        editor.change { it.put("noteTitle", "First keystroke") }
        editor.change { it.put("noteTitle", "Latest draft") }
        assertEquals(initialGeneration + 2, editor.draftGeneration.value)
        withTimeoutOrNull(5_000) {
            while (editor.localSaving.value) delay(10)
        } ?: error("local editor persistence did not finish")
        assertEquals("Latest draft", repository.note(original.syncId)?.title)
        assertEquals("Latest draft", JSONObject(repository.store.pending(profile.profile).single().payload).getString("noteTitle"))
        editor.flushAndQueueSync()
        assertTrue("queueing is not an acknowledgement", editor.dirty.value)

        editor.applyIncoming(Note(editor.draft.value.copyJson().put("revision", 5).put("noteTitle", "Web version")))
        assertEquals("Latest draft", editor.draft.value.getString("noteTitle"))
        assertEquals("Web version", editor.incoming.value?.title)
        val acceptedSnapshot = Note(editor.draft.value.copyJson().put("revision", 5).put("updatedAt", "accepted"))
        editor.applyIncoming(acceptedSnapshot)
        assertTrue("a cached draft with a newer local revision is not an acknowledgement", editor.dirty.value)
        editor.acceptServerSnapshot(acceptedSnapshot)
        assertTrue("accepted snapshots advance the effect generation", editor.draftGeneration.value > initialGeneration + 2)
        assertEquals(null, editor.incoming.value)
        assertFalse(editor.dirty.value)
        assertEquals(5L, editor.draft.value.getLong("revision"))
    }

    @Test fun hasContentIgnoresBlankMarkupButCountsRealContent() {
        fun note(edit: (JSONObject) -> Unit = {}) = Note(Note.create(profile.userId).raw.also(edit))
        assertFalse(note().hasContent)
        assertFalse(note { it.put("noteBody", "<div><br></div>") }.hasContent)
        assertFalse(note { it.put("noteBody", "<p dir=\"ltr\"></p>") }.hasContent)
        assertFalse(note { it.put("isCbox", true).put("checkBoxes", JSONArray().put(JSONObject().put("id", 1).put("data", ""))) }.hasContent)
        assertTrue(note { it.put("noteTitle", "Title") }.hasContent)
        assertTrue(note { it.put("noteBody", "<div>text</div>") }.hasContent)
        assertTrue(note { it.put("isCbox", true).put("checkBoxes", JSONArray().put(JSONObject().put("id", 1).put("data", "milk"))) }.hasContent)
        assertTrue(note { it.put("images", JSONArray().put(JSONObject().put("id", "img"))) }.hasContent)
        assertTrue(note { it.put("labels", JSONArray().put(JSONObject().put("name", "Home").put("added", true))) }.hasContent)
    }

    @Test fun closingAnEmptyNewNoteDiscardsItAndItsQueuedUpsert() = runBlocking {
        val created = Note.create(profile.userId)
        repository.save(created)
        NoteEditorViewModel(repository, created).finish()
        assertEquals(null, repository.note(created.syncId))
        assertTrue(repository.store.pending(profile.profile).isEmpty())
    }

    @Test fun closingANewNoteWithContentKeepsIt() = runBlocking {
        val created = Note.create(profile.userId)
        repository.save(created)
        val editor = NoteEditorViewModel(repository, created)
        editor.change { it.put("noteTitle", "Groceries") }
        editor.finish()
        assertEquals("Groceries", repository.note(created.syncId)?.title)
        assertEquals("Groceries", JSONObject(repository.store.pending(profile.profile).single().payload).getString("noteTitle"))
    }

    @Test fun closingANewNoteThatSyncedBeforeBeingEmptiedMovesItToTrash() = runBlocking {
        val created = Note.create(profile.userId)
        repository.save(created)
        val editor = NoteEditorViewModel(repository, created)
        editor.change { it.put("noteTitle", "Typed") }
        editor.flushAndQueueSync()
        withTimeoutOrNull(5_000) { while (editor.localSaving.value) delay(10) } ?: error("local editor persistence did not finish")
        val sent = repository.store.pending(profile.profile).single()
        repository.store.acknowledge(sent.operationId)
        val accepted = Note(JSONObject(sent.payload).put("id", 90).put("revision", 1))
        repository.store.put(Record(profile.profile, "note", created.syncId, accepted.raw.toString()))
        editor.acceptServerSnapshot(accepted)
        editor.change { it.put("noteTitle", "") }
        editor.finish()
        assertTrue(repository.note(created.syncId)!!.trashed)
    }

    @Test fun closingAnEmptyNewNoteWithAReminderKeepsIt() = runBlocking {
        val created = Note.create(profile.userId)
        repository.save(created)
        repository.setReminder(created, "2030-01-01T09:00:00Z", "UTC", null)
        NoteEditorViewModel(repository, created).finish()
        assertFalse(repository.note(created.syncId)!!.trashed)
    }

    @Test fun acceptedServerCanonicalizationDoesNotKeepTheEditorDirty() = runBlocking {
        val initial = Note(JSONObject().put("id", 56).put("syncId", "canonical-editor").put("revision", 3)
            .put("ownerUserId", profile.userId).put("noteTitle", "Before").put("noteBody", "<b>rich</b>")
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray()))
        repository.store.put(Record(profile.profile, "note", initial.syncId, initial.raw.toString()))
        val editor = NoteEditorViewModel(repository, initial)
        editor.change { it.put("noteTitle", "Edited") }
        withTimeoutOrNull(5_000) { while (editor.localSaving.value) delay(10) }
            ?: error("editor draft did not persist")
        val submitted = Note(editor.draft.value.copyJson())
        val canonical = Note(submitted.raw.copyJson().put("revision", 4).put("noteBody", "<p dir=\"ltr\"><b>rich</b></p>"))

        editor.acceptServerSnapshot(canonical, submitted)

        assertEquals(canonical.body, editor.draft.value.getString("noteBody"))
        assertFalse(editor.dirty.value)
    }

    @Test fun noteUploadAndSuccessorEditHaveExplicitOutboxDependencies() = runBlocking {
        val note = Note.create(profile.userId)
        repository.save(note)
        val create = repository.store.pending(profile.profile).single()
        val media = JSONObject().put("file", "staged-one").put("name", "one.txt").put("mime", "text/plain")
        repository.attach(note, media)
        val upload = repository.store.pending(profile.profile).single { it.type == "media.upload" }
        assertEquals(create.operationId, upload.dependsOnOperationId)

        repository.store.markInFlight(create.operationId)
        repository.save(Note(note.raw.copyJson().put("noteTitle", "Edited after upload was queued")))
        val successor = repository.store.pending(profile.profile).single { it.type == "note.upsert" && it.state == OutboxState.QUEUED }
        assertNotEquals(create.operationId, successor.operationId)
        assertEquals(upload.operationId, successor.dependsOnOperationId)
        assertNull(repository.store.nextSendable(profile.profile))

        repository.store.acknowledge(create.operationId)
        repository.store.unblockDependents(profile.profile, create.operationId, 1, null)
        assertEquals(upload.operationId, repository.store.nextSendable(profile.profile)?.operationId)
        repository.store.markInFlight(upload.operationId)
        repository.store.acknowledge(upload.operationId)
        repository.store.unblockDependents(profile.profile, upload.operationId, 2, null)
        val next = repository.store.nextSendable(profile.profile)
        assertEquals(successor.operationId, next?.operationId)
        assertEquals(2L, next?.baseRevision)
    }

    @Test fun offlineNoteReminderAndTwoUploadsFlushInDependencyOrder() = runBlocking {
        profile.token = "test-session"
        val uploadOrder = mutableListOf<String>()
        val uploader = object : MediaUploadPort {
            override suspend fun upload(entry: Outbox, repository: KeptRepository): JSONObject {
                val payload = JSONObject(entry.payload)
                val note = repository.note(payload.text("noteSyncId"))!!
                check(note.id > 0) { "note must be accepted before its media" }
                uploadOrder += payload.text("file")
                return JSONObject().put("kind", "attachment").put("id", uploadOrder.size).put("syncId", "attachment-${payload.text("file")}")
                    .put("noteId", note.id).put("noteSyncId", note.syncId).put("noteRevision", note.revision + 1)
                    .put("originalName", payload.text("name")).put("mimeType", payload.text("mime"))
            }
        }
        val local = Note.create(profile.userId)
        val serverNote = local.raw.copyJson().put("id", 81).put("revision", 1)
        val api = FakeNativeApi()
        api.callHandler = { path, _, body ->
            when {
                path == "/api/sync/mutations" -> {
                    val mutation = body!!.getJSONArray("mutations").getJSONObject(0)
                    when (mutation.text("type")) {
                        "note.upsert" -> JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true).put("id", 81)
                            .put("resourceType", "note").put("syncId", local.syncId)))
                            .put("snapshot", JSONObject().put("notes", JSONArray().put(serverNote)).put("reminders", JSONArray())
                                .put("attachments", JSONArray()).put("occurrences", JSONArray()).put("cursor", 0)).toString()
                        "reminder.upsert" -> {
                            val payload = mutation.getJSONObject("payload").copyJson().put("id", 91).put("noteId", 81)
                            JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true).put("id", 91)
                                .put("resourceType", "reminder").put("syncId", payload.text("syncId")).put("payload", payload)))
                                .put("snapshot", JSONObject().put("notes", JSONArray().put(serverNote)).put("reminders", JSONArray().put(payload))
                                    .put("attachments", JSONArray()).put("occurrences", JSONArray()).put("cursor", 0)).toString()
                        }
                        else -> error("Unexpected mutation ${mutation.text("type")}")
                    }
                }
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }
        repository = KeptRepository(app, app.database, profile, api, uploader)
        app.repository = repository
        repository.save(local)
        repository.setReminder(local, "2030-01-01T09:00:00Z", "UTC", null)
        val reminderSyncId = repository.store.list(profile.profile, "reminder").single().syncId
        repository.attach(local, JSONObject().put("file", "file-one").put("name", "one.txt").put("mime", "text/plain"))
        repository.attach(local, JSONObject().put("file", "file-two").put("name", "two.txt").put("mime", "text/plain"))

        repository.sync()

        assertEquals(setOf("file-one", "file-two"), uploadOrder.toSet())
        assertEquals(0, repository.store.pending(profile.profile).size)
        val syncedNote = repository.note(local.syncId)!!
        assertEquals(3L, syncedNote.revision)
        assertEquals(2, syncedNote.raw.getJSONArray("attachments").length())
        assertNotNull(repository.store.record(profile.profile, "reminder", reminderSyncId))
    }

    @Test fun recordsAndOutboxArePartitionedByConnectionProfile() = runBlocking {
        val first = Note.create(profile.userId)
        repository.save(first)
        val firstProfile = profile.profile

        profile.origin = "https://two.example.test"
        profile.userId = 22
        val second = Note.create(profile.userId)
        repository.save(second)

        assertNotNull(repository.store.record(firstProfile, "note", first.syncId))
        assertNotNull(repository.store.record(profile.profile, "note", second.syncId))
        assertEquals(1, repository.store.pending(firstProfile).size)
        assertEquals(1, repository.store.pending(profile.profile).size)
    }

    @Test fun aNoopSyncDoesNotReconcileRemindersOrRefreshWidgets() = runBlocking {
        profile.token = "test-session"
        repository.store.cursor(SyncState(profile.profile, 12))
        val api = FakeNativeApi().apply {
            callHandler = { path, _, _ ->
                when {
                    path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray())
                        .put("cursor", 12).put("hasMore", false).toString()
                    path == "/api/native/reminders/occurrences" -> "[]"
                    else -> error("Unexpected request $path")
                }
            }
        }
        repository = KeptRepository(app, app.database, profile, api)
        app.repository = repository
        var widgetRefreshes = 0
        app.refreshWidgets = { widgetRefreshes++ }
        val reminderController = app.reminders as FakeReminderController

        repository.sync()

        assertEquals(0, widgetRefreshes)
        assertEquals(0, reminderController.reconcileCalls)
    }

    @Test fun anEditorFromThePreviousAccountCannotQueueItsDraftUnderTheNewProfile() = runBlocking {
        val note = Note.create(profile.userId)
        val previousProfile = profile.profile
        repository.save(note, synchronize = false, profile = previousProfile)
        profile.userId = 22

        val result = runCatching { repository.save(Note(note.raw.copyJson().put("noteTitle", "Old account draft")),
            synchronize = true, profile = previousProfile) }

        assertTrue(result.isFailure)
        assertNotNull(repository.store.record(previousProfile, "note", note.syncId))
        assertNull(repository.store.record(profile.profile, "note", note.syncId))
        assertEquals(1, repository.store.pending(previousProfile).size)
        assertTrue(repository.store.pending(profile.profile).isEmpty())
    }

    @Test fun aLaterOfflineRepeatOccurrenceCanBeDeliveredWithoutServerOccurrence() = runBlocking {
        profile.token = "test-session"
        val due = "2030-01-01T09:00:00.000Z"
        val reminder = JSONObject().put("syncId", "offline-repeat").put("id", 4).put("noteId", 0)
            .put("dueAtUtc", due).put("timezone", "UTC").put("repeatRule", "{\"type\":\"daily\"}")
            .put("scheduleVersion", 1).put("status", "pending")
        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        val alarmBackend = FakeAlarms()
        val notificationSink = FakeNotifications()
        val now = Instant.parse("2030-01-01T09:01:00Z")
        val scheduler = ReminderScheduler(app, Clock.fixed(now, ZoneOffset.UTC), alarmBackend, notificationSink)
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()

        scheduler.reconcile()
        val entry = registry.all.entries.first { it.key.contains("2030-01-02T09:00:00.000Z") }
        val futureOccurrence = JSONObject(entry.value as String)
        scheduler.deliver(entry.key, futureOccurrence)

        assertEquals(1, notificationSink.delivered.size)
        assertEquals("2030-01-02T09:00:00.000Z", notificationSink.delivered.single().text("dueAtUtc"))
    }

    @Test fun multipleMissedDailyOccurrencesAreRecoveredAfterOfflineDays() = runBlocking {
        profile.token = "test-session"
        val due = "2030-01-01T09:00:00.000Z"
        val reminder = JSONObject().put("syncId", "multi-day-offline").put("id", 5).put("noteId", 0)
            .put("dueAtUtc", due).put("scheduleAnchorAtUtc", due).put("timezone", "UTC")
            .put("repeatRule", "{\"type\":\"daily\"}").put("scheduleVersion", 1).put("status", "pending")
        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        val alarmBackend = FakeAlarms()
        val notificationSink = FakeNotifications()
        val now = Instant.parse("2030-01-04T10:00:00Z")
        val scheduler = ReminderScheduler(app, Clock.fixed(now, ZoneOffset.UTC), alarmBackend, notificationSink)
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()

        scheduler.reconcile()
        val missed = registry.all.entries.map { it.key to JSONObject(it.value as String) }
            .filter { Instant.parse(it.second.text("dueAtUtc")).isBefore(now) || Instant.parse(it.second.text("dueAtUtc")) == now }
        assertTrue("three or more daily occurrences should be recovered", missed.size >= 3)
        missed.forEach { (key, occurrence) -> scheduler.deliver(key, occurrence) }

        assertTrue(notificationSink.delivered.size >= 3)
        assertTrue(notificationSink.delivered.map { it.text("occurrenceId") }.distinct().size >= 3)
    }

    @Test fun longOfflineCatchUpGroupsOlderOccurrencesAndKeepsRecentDeliveriesBounded() = runBlocking {
        profile.token = "test-session"
        val due = "2030-01-01T09:00:00.000Z"
        val reminder = JSONObject().put("syncId", "bounded-catch-up").put("id", 51).put("noteId", 0)
            .put("dueAtUtc", due).put("scheduleAnchorAtUtc", due).put("timezone", "UTC")
            .put("repeatRule", "{\"type\":\"daily\"}").put("scheduleVersion", 1).put("status", "pending")
        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        val notifications = FakeNotifications()
        val scheduler = ReminderScheduler(app, Clock.fixed(Instant.parse("2030-01-20T10:00:00Z"), ZoneOffset.UTC), FakeAlarms(), notifications)
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()

        scheduler.reconcile()
        assertEquals(1, notifications.catchUpSummaries.size)
        assertEquals(13, notifications.catchUpSummaries.single().getInt("count"))
        assertEquals("seven individual catch-ups plus the next future occurrence", 8, registry.all.size)
        scheduler.reconcile()
        assertEquals("the same expired window is summarized only once", 1, notifications.catchUpSummaries.size)
    }

    @Test fun expiredOfflineSnoozeIsAcknowledgedWithoutSchedulingADuplicate() = runBlocking {
        profile.token = "test-session"
        val due = "2030-01-01T09:00:00.000Z"
        val snoozeUntil = "2030-01-01T09:10:00.000Z"
        val reminder = JSONObject().put("syncId", "expired-snooze").put("id", 6).put("noteId", 0)
            .put("dueAtUtc", due).put("scheduleAnchorAtUtc", due).put("timezone", "UTC")
            .put("status", "pending").put("scheduleVersion", 1)
        val occurrenceId = Recurrence.occurrenceId(reminder.getString("syncId"), due, 1)
        val occurrence = reminder.copyJson().put("occurrenceId", occurrenceId).put("state", "snoozed").put("snoozeUntil", snoozeUntil)
        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        repository.store.put(Record(profile.profile, "occurrence", occurrenceId, occurrence.toString()))
        val scheduler = ReminderScheduler(app, Clock.fixed(Instant.parse("2030-01-01T09:20:00Z"), ZoneOffset.UTC), FakeAlarms(), FakeNotifications())
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()

        scheduler.reconcile()

        val deliveryKey = "$occurrenceId/v1"
        val profilePrefix = java.security.MessageDigest.getInstance("SHA-256").digest(profile.profile.toByteArray())
            .take(8).joinToString("") { "%02x".format(it) }
        val snoozeKey = "$profilePrefix/$deliveryKey/snooze/$snoozeUntil"
        assertEquals(1, repository.store.wasDelivered(profile.profile, snoozeKey))
        assertTrue(registry.all.keys.none { it.contains("/snooze/$snoozeUntil") })
    }

    @Test fun notificationDenialDoesNotScheduleOrFalselyMarkDeliveryAndExactDenialFallsBack() = runBlocking {
        profile.token = "test-session"
        val now = Instant.parse("2030-01-01T08:00:00Z")
        val due = "2030-01-01T09:00:00.000Z"
        val reminder = JSONObject().put("syncId", "permission-check").put("id", 7).put("noteId", 0)
            .put("dueAtUtc", due).put("scheduleAnchorAtUtc", due).put("timezone", "UTC").put("status", "pending").put("scheduleVersion", 1)
        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()
        val deniedAlarms = FakeAlarms()
        val deniedNotifications = FakeNotifications().apply { allowed = false }
        val deniedScheduler = ReminderScheduler(app, Clock.fixed(now, ZoneOffset.UTC), deniedAlarms, deniedNotifications)

        deniedScheduler.reconcile()
        assertTrue(deniedAlarms.scheduled.isEmpty())
        assertTrue(deniedNotifications.delivered.isEmpty())
        assertEquals(0, repository.store.wasDelivered(profile.profile, "permission-check@2030-01-01T09:00:00.000Z#v1/v1"))

        val fallbackAlarms = FakeAlarms().apply { exactThrows = true }
        val fallbackScheduler = ReminderScheduler(app, Clock.fixed(now, ZoneOffset.UTC), fallbackAlarms, FakeNotifications())
        fallbackScheduler.reconcile()
        assertEquals(1, fallbackAlarms.inexactSchedules)
        assertEquals(1, fallbackAlarms.exactAttempts)
    }

    @Test fun staleReminderActionAndQueuedAlarmAreRejectedAfterScheduleVersionChanges() = runBlocking {
        profile.token = "test-session"
        val due = "2030-01-01T09:00:00.000Z"
        val reminder = JSONObject().put("syncId", "stale-action").put("id", 8).put("noteId", 0)
            .put("dueAtUtc", due).put("scheduleAnchorAtUtc", due).put("timezone", "UTC")
            .put("status", "pending").put("scheduleVersion", 1)
        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        val alarms = FakeAlarms()
        val notifications = FakeNotifications()
        val scheduler = ReminderScheduler(app, Clock.fixed(Instant.parse("2030-01-01T09:01:00Z"), ZoneOffset.UTC), alarms, notifications)
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()
        scheduler.reconcile()
        val (key, raw) = registry.all.entries.single().let { it.key to JSONObject(it.value as String) }
        scheduler.deliver(key, raw)
        assertEquals(1, notifications.delivered.size)
        assertTrue(scheduler.act(key, raw, "dismissed", null))
        assertEquals("reminder.action", repository.store.pending(profile.profile).single().type)

        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.copyJson()
            .put("scheduleVersion", 2).put("dueAtUtc", "2030-01-02T09:00:00.000Z").toString()))
        registry.edit().putString(key, raw.toString()).commit()
        scheduler.deliver(key, raw)
        assertFalse(scheduler.act(key, raw, "dismissed", null))
        assertEquals(1, notifications.delivered.size)
        assertEquals(1, repository.store.pending(profile.profile).size)
    }

    @Test fun archiveOrTrashBeforeDispatchCancelsLinkedReminderWithoutLeakingContent() = runBlocking {
        profile.token = "test-session"
        val due = "2030-01-01T09:00:00.000Z"
        val archivedNote = Note(JSONObject().put("id", 61).put("syncId", "archive-before-alarm").put("ownerUserId", profile.userId)
            .put("noteTitle", "Archived private note").put("archived", false).put("trashed", false))
        val trashedNote = Note(JSONObject().put("id", 62).put("syncId", "trash-before-alarm").put("ownerUserId", profile.userId)
            .put("noteTitle", "Trashed private note").put("archived", false).put("trashed", false))
        repository.store.put(Record(profile.profile, "note", archivedNote.syncId, archivedNote.raw.toString()))
        repository.store.put(Record(profile.profile, "note", trashedNote.syncId, trashedNote.raw.toString()))
        for ((id, note) in listOf(archivedNote, trashedNote).map { it.id to it }) {
            val reminder = JSONObject().put("id", 70 + id).put("syncId", "reminder-${note.syncId}").put("noteId", id)
                .put("noteSyncId", note.syncId).put("dueAtUtc", due).put("scheduleAnchorAtUtc", due)
                .put("timezone", "UTC").put("status", "pending").put("scheduleVersion", 1)
            repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        }
        val notifications = FakeNotifications()
        val scheduler = ReminderScheduler(app, Clock.fixed(Instant.parse("2030-01-01T09:01:00Z"), ZoneOffset.UTC), FakeAlarms(), notifications)
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()
        scheduler.reconcile()
        val queued = registry.all.entries.map { it.key to JSONObject(it.value as String) }
        assertEquals(2, queued.size)
        repository.store.put(Record(profile.profile, "note", archivedNote.syncId, archivedNote.raw.copyJson().put("archived", true).toString()))
        repository.store.put(Record(profile.profile, "note", trashedNote.syncId, trashedNote.raw.copyJson().put("trashed", true).toString()))

        queued.forEach { (key, raw) -> scheduler.deliver(key, raw) }

        assertTrue(notifications.delivered.isEmpty())
        assertTrue(registry.all.isEmpty())
    }

    @Test fun localDeliveryReconcilesWithServerOccurrenceWithoutAnotherNotification() = runBlocking {
        profile.token = "test-session"
        val due = "2030-01-01T09:00:00.000Z"
        val reminder = JSONObject().put("syncId", "server-fired-same-occurrence").put("id", 89).put("noteId", 0)
            .put("dueAtUtc", due).put("scheduleAnchorAtUtc", due).put("timezone", "UTC").put("status", "pending").put("scheduleVersion", 1)
        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        val notifications = FakeNotifications()
        val scheduler = ReminderScheduler(app, Clock.fixed(Instant.parse("2030-01-01T09:01:00Z"), ZoneOffset.UTC), FakeAlarms(), notifications)
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()
        scheduler.reconcile()
        val (key, occurrence) = registry.all.entries.single().let { it.key to JSONObject(it.value as String) }
        scheduler.deliver(key, occurrence)
        val occurrenceId = occurrence.getString("occurrenceId")
        repository.store.put(Record(profile.profile, "occurrence", occurrenceId,
            occurrence.copyJson().put("state", "pending").toString()))

        scheduler.reconcile()

        assertEquals(1, notifications.delivered.size)
        assertTrue(registry.all.isEmpty())
    }

    @Test fun rebootAlarmResetRebuildsFromPersistedReminderState() = runBlocking {
        profile.token = "test-session"
        val reminder = JSONObject().put("syncId", "reboot-recovery").put("id", 10).put("noteId", 0)
            .put("dueAtUtc", "2030-01-01T09:00:00.000Z").put("scheduleAnchorAtUtc", "2030-01-01T09:00:00.000Z")
            .put("timezone", "UTC").put("status", "pending").put("scheduleVersion", 1)
        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        val alarms = FakeAlarms()
        val scheduler = ReminderScheduler(app, Clock.fixed(Instant.parse("2030-01-01T08:00:00Z"), ZoneOffset.UTC), alarms, FakeNotifications())
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()

        scheduler.reconcile()
        val scheduledKey = registry.all.keys.single()
        scheduler.resetAlarmRegistry()
        assertTrue(registry.all.isEmpty())
        assertTrue(alarms.scheduled.isEmpty())
        scheduler.reconcile()

        assertEquals(setOf(scheduledKey), registry.all.keys)
        assertEquals(1, alarms.scheduled.size)
    }

    @Test fun notificationCrashWindowRetriesWithTheSameDeterministicIdentity() = runBlocking {
        profile.token = "test-session"
        val due = "2030-01-01T09:00:00.000Z"
        val reminder = JSONObject().put("syncId", "notification-crash-window").put("id", 9).put("noteId", 0)
            .put("dueAtUtc", due).put("scheduleAnchorAtUtc", due).put("timezone", "UTC").put("status", "pending").put("scheduleVersion", 1)
        repository.store.put(Record(profile.profile, "reminder", reminder.getString("syncId"), reminder.toString()))
        val notifications = FakeNotifications().apply { failAfterShow = true }
        val scheduler = ReminderScheduler(app, Clock.fixed(Instant.parse("2030-01-01T09:01:00Z"), ZoneOffset.UTC), FakeAlarms(), notifications)
        val registry = app.getSharedPreferences("scheduled_alarms", 0)
        registry.edit().clear().commit()

        scheduler.reconcile()
        val first = registry.all.entries.single().let { it.key to JSONObject(it.value as String) }
        runCatching { scheduler.deliver(first.first, first.second) }
        assertEquals(0, repository.store.wasDelivered(profile.profile, first.first))
        notifications.failAfterShow = false
        scheduler.reconcile()
        val retry = registry.all.entries.single().let { it.key to JSONObject(it.value as String) }
        assertEquals(first.first, retry.first)
        scheduler.deliver(retry.first, retry.second)

        assertEquals(listOf(first.first, first.first), notifications.shownKeys)
        assertEquals(1, repository.store.wasDelivered(profile.profile, first.first))
    }

    @Test fun bootstrapCannotDeleteAnAcceptedLocalReminderWhenItsSnapshotOmitsIt() = runBlocking {
        profile.token = "test-session"
        val reminderId = "local-reminder-before-bootstrap"
        val payload = JSONObject().put("syncId", reminderId).put("id", -1).put("noteId", JSONObject.NULL)
            .put("userId", profile.userId).put("dueAtUtc", "2030-01-01T09:00:00Z").put("timezone", "UTC")
            .put("status", "pending").put("scheduleVersion", 1)
        repository.store.put(Record(profile.profile, "reminder", reminderId, payload.toString()))
        repository.store.enqueue(Outbox("create-reminder", profile.profile, "reminder.upsert", reminderId, payload.toString(), baseScheduleVersion = 0))
        val fakeApi = repository.api as FakeNativeApi
        fakeApi.callHandler = { path, _, _ ->
            when (path) {
                "/api/sync/mutations" -> JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true)
                    .put("resourceType", "reminder").put("syncId", reminderId).put("id", 99))).toString()
                "/api/sync/bootstrap" -> JSONObject().put("notes", JSONArray()).put("reminders", JSONArray())
                    .put("attachments", JSONArray()).put("occurrences", JSONArray()).put("cursor", 0).toString()
                "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }

        repository.sync()

        assertNotNull(repository.store.record(profile.profile, "reminder", reminderId))
    }

    @Test fun acceptedReminderUsesTheServerCanonicalSyncId() = runBlocking {
        profile.token = "test-session"
        val localId = "device-reminder-id"
        val serverId = "canonical-reminder-id"
        val payload = JSONObject().put("id", -1).put("syncId", localId).put("noteId", JSONObject.NULL)
            .put("userId", profile.userId).put("dueAtUtc", "2030-01-01T09:00:00Z").put("timezone", "UTC")
            .put("repeatRule", JSONObject.NULL).put("status", "pending").put("scheduleVersion", 1)
        val accepted = payload.copyJson().put("id", 88).put("syncId", serverId).put("scheduleAnchorAtUtc", "2030-01-01T09:00:00Z")
        repository.store.put(Record(profile.profile, "reminder", localId, payload.toString()))
        repository.store.enqueue(Outbox("create-with-canonical-id", profile.profile, "reminder.upsert", localId, payload.toString()))
        repository.store.cursor(SyncState(profile.profile, 0))
        (repository.api as FakeNativeApi).callHandler = { path, _, _ ->
            when {
                path == "/api/sync/mutations" -> JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true)
                    .put("resourceType", "reminder").put("syncId", serverId).put("id", 88).put("payload", accepted))).toString()
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }

        repository.sync()

        assertEquals(null, repository.store.record(profile.profile, "reminder", localId))
        assertEquals(88L, JSONObject(repository.store.record(profile.profile, "reminder", serverId)!!.payload).getLong("id"))
        assertEquals(0, repository.store.pending(profile.profile).size)
    }

    @Test fun locallyPersistedDraftAndOutboxSurviveDatabaseReopen() = runBlocking {
        val databaseName = "kept-draft-reopen-${UUID.randomUUID()}.sqlite"
        val firstDatabase = Room.databaseBuilder(app, KeptDatabase::class.java, databaseName)
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3).build()
        val note = Note.create(profile.userId).raw.put("noteTitle", "Durable local draft")
        firstDatabase.withTransaction {
            firstDatabase.store().put(Record(profile.profile, "note", note.getString("syncId"), note.toString()))
            firstDatabase.store().enqueue(Outbox("durable-draft", profile.profile, "note.upsert", note.getString("syncId"), note.toString(), baseRevision = 0))
        }
        firstDatabase.close()

        val reopened = Room.databaseBuilder(app, KeptDatabase::class.java, databaseName)
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3).build()
        assertEquals("Durable local draft", JSONObject(reopened.store().record(profile.profile, "note", note.getString("syncId"))!!.payload).getString("noteTitle"))
        assertEquals("durable-draft", reopened.store().pending(profile.profile).single().operationId)
        reopened.close()
        app.deleteDatabase(databaseName)
        Unit
    }

    @Test fun checklistCollapseSurvivesRoomReopenAndSynchronizesAsPerUserState() = runBlocking {
        val databaseName = "kept-view-state-${UUID.randomUUID()}.sqlite"
        app.database.close()
        val firstDatabase = Room.databaseBuilder(app, KeptDatabase::class.java, databaseName)
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3).build()
        app.database = firstDatabase
        repository = KeptRepository(app, firstDatabase, profile, FakeNativeApi())
        app.repository = repository
        val note = Note(JSONObject().put("id", 102).put("syncId", "durable-view-state").put("revision", 3)
            .put("ownerUserId", profile.userId).put("noteTitle", "Checklist").put("isCbox", true)
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray()))
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.setChecklistCollapsed(note, true)
        firstDatabase.close()

        val reopened = Room.databaseBuilder(app, KeptDatabase::class.java, databaseName)
            .addMigrations(MIGRATION_1_2, MIGRATION_2_3).build()
        app.database = reopened
        profile.token = "test-session"
        repository = KeptRepository(app, reopened, profile, FakeNativeApi())
        app.repository = repository
        reopened.store().cursor(SyncState(profile.profile, 0))
        val syncPayload = note.raw.copyJson().put("completedChecklistCollapsed", true)
        (repository.api as FakeNativeApi).callHandler = { path, _, body ->
            when {
                path == "/api/sync/mutations" -> {
                    val mutation = body!!.getJSONArray("mutations").getJSONObject(0)
                    assertEquals("note.view-state", mutation.getString("type"))
                    JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true).put("resourceType", "note-view-state")
                        .put("syncId", note.syncId).put("id", note.id))).put("snapshot", JSONObject()
                        .put("notes", JSONArray().put(syncPayload)).put("reminders", JSONArray()).put("attachments", JSONArray())
                        .put("occurrences", JSONArray()).put("cursor", 0)).toString()
                }
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }

        assertEquals("note.view-state", reopened.store().pending(profile.profile).single().type)
        assertTrue(JSONObject(reopened.store().record(profile.profile, "note", note.syncId)!!.payload).getBoolean("completedChecklistCollapsed"))
        repository.sync()
        assertTrue(reopened.store().pending(profile.profile).isEmpty())
        assertTrue(JSONObject(reopened.store().record(profile.profile, "note", note.syncId)!!.payload).getBoolean("completedChecklistCollapsed"))
        reopened.close()
        app.deleteDatabase(databaseName)
        app.database = Room.inMemoryDatabaseBuilder(app, KeptDatabase::class.java).allowMainThreadQueries().build()
        repository = KeptRepository(app, app.database, profile, FakeNativeApi())
        app.repository = repository
    }

    @Test fun revokedNoteRemovesDependentLocalResourcesButKeepsRecoveryDrafts() = runBlocking {
        profile.token = "test-session"
        val noteId = "revoked-shared-note"
        val reminderId = "personal-reminder"
        val occurrenceId = "personal-reminder@2030-01-01T09:00:00.000Z#v1"
        val note = JSONObject().put("id", 71).put("syncId", noteId).put("revision", 2).put("ownerUserId", profile.userId)
            .put("noteTitle", "Local private draft").put("noteBody", "Recover this body").put("checkBoxes", JSONArray()).put("images", JSONArray())
        val reminder = JSONObject().put("syncId", reminderId).put("noteId", 71).put("noteSyncId", noteId).put("status", "pending")
        val occurrence = JSONObject().put("occurrenceId", occurrenceId).put("syncId", reminderId).put("scheduleVersion", 1)
        val attachment = JSONObject().put("syncId", "attachment-1").put("noteId", 71)
        repository.store.put(Record(profile.profile, "note", noteId, note.toString()))
        repository.store.put(Record(profile.profile, "reminder", reminderId, reminder.toString()))
        repository.store.put(Record(profile.profile, "occurrence", occurrenceId, occurrence.toString()))
        repository.store.put(Record(profile.profile, "attachment", "attachment-1", attachment.toString()))
        repository.store.enqueue(Outbox("note-draft", profile.profile, "note.upsert", noteId, note.toString(), baseRevision = 2))
        repository.store.enqueue(Outbox("reminder-edit", profile.profile, "reminder.upsert", reminderId, reminder.toString(), baseScheduleVersion = 1))
        repository.store.cursor(SyncState(profile.profile, 0))
        (repository.api as FakeNativeApi).callHandler = { path, _, _ ->
            when {
                path == "/api/sync/mutations" -> JSONObject().put("results", JSONArray().put(JSONObject().put("ok", false)
                    .put("status", 403).put("error", "Note not accessible"))).toString()
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray().put(JSONObject()
                    .put("resourceType", "note").put("resourceSyncId", noteId).put("operation", "delete")))
                    .put("cursor", 1).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }

        repository.sync()

        assertEquals(null, repository.store.record(profile.profile, "note", noteId))
        assertEquals("Recover this body", JSONObject(repository.store.record(profile.profile, "recovery", noteId)!!.payload).getString("noteBody"))
        assertEquals(null, repository.store.record(profile.profile, "reminder", reminderId))
        assertEquals(null, repository.store.record(profile.profile, "occurrence", occurrenceId))
        assertEquals(null, repository.store.record(profile.profile, "attachment", "attachment-1"))
        assertTrue(repository.store.pending(profile.profile).all { it.conflict != null })
    }

    @Test fun acceptedExistingNoteRevisionIsPublishedToRoomForTheOpenEditor() = runBlocking {
        profile.token = "test-session"
        val note = Note(JSONObject().put("id", 55).put("syncId", "existing-note").put("revision", 7)
            .put("ownerUserId", profile.userId).put("noteTitle", "Saved locally").put("noteBody", "Body")
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray()))
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.enqueue(Outbox("edit-existing", profile.profile, "note.upsert", note.syncId, note.raw.toString(), baseRevision = 7))
        repository.store.cursor(SyncState(profile.profile, 0))
        (repository.api as FakeNativeApi).callHandler = { path, _, _ ->
            when {
                path == "/api/sync/mutations" -> JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true)
                    .put("resourceType", "note").put("syncId", note.syncId).put("id", note.id))).toString()
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }

        repository.sync()

        val accepted = repository.store.record(profile.profile, "note", note.syncId)!!.let { Note(JSONObject(it.payload)) }
        assertEquals(8L, accepted.revision)
        assertEquals(note.id, accepted.id)
        assertEquals(0, repository.store.pending(profile.profile).size)
    }

    @Test fun titleEditSyncRetainsUnsupportedRichContentAndUnknownFields() = runBlocking {
        profile.token = "test-session"
        val richItem = "<a href=\"https://example.test/item\"><b>Rich item</b></a>"
        val drawing = JSONObject().put("id", "drawing").put("dataUrl", "data:image/svg+xml;base64,PHN2Zy8+")
        val attachment = JSONObject().put("syncId", "future-attachment").put("originalName", "future.txt")
            .put("mimeType", "text/plain").put("futureFlag", true)
        val note = Note(JSONObject().put("id", 91).put("syncId", "opaque-content").put("revision", 3)
            .put("ownerUserId", profile.userId).put("noteTitle", "Before")
            .put("noteBody", "<table><tr><td>Unsupported body</td></tr></table>")
            .put("isCbox", true).put("checkBoxes", JSONArray().put(JSONObject().put("id", 1).put("data", richItem)))
            .put("images", JSONArray().put(drawing)).put("attachments", JSONArray().put(attachment)).put("labels", JSONArray())
            .put("futureField", JSONObject().put("schema", 9).put("metadata", JSONArray().put("keep"))))
        repository.save(note, synchronize = false)
        repository.save(Note(note.raw.copyJson().put("noteTitle", "After")), synchronize = false)
        repository.store.cursor(SyncState(profile.profile, 0))
        var transmitted: JSONObject? = null
        (repository.api as FakeNativeApi).callHandler = { path, _, body ->
            when {
                path == "/api/sync/mutations" -> {
                    transmitted = body!!.getJSONArray("mutations").getJSONObject(0).getJSONObject("payload").copyJson()
                    val accepted = transmitted!!.copyJson().put("revision", 4)
                    JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true).put("resourceType", "note")
                        .put("syncId", note.syncId).put("id", note.id))).put("snapshot", JSONObject()
                        .put("notes", JSONArray().put(accepted)).put("reminders", JSONArray()).put("attachments", JSONArray())
                        .put("occurrences", JSONArray()).put("cursor", 0)).toString()
                }
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }

        repository.sync()

        assertEquals("After", transmitted!!.getString("noteTitle"))
        assertEquals(note.body, transmitted!!.getString("noteBody"))
        assertEquals(richItem, transmitted!!.getJSONArray("checkBoxes").getJSONObject(0).getString("data"))
        assertEquals(drawing.toString(), transmitted!!.getJSONArray("images").getJSONObject(0).toString())
        assertEquals(attachment.toString(), transmitted!!.getJSONArray("attachments").getJSONObject(0).toString())
        assertTrue(transmitted!!.getJSONObject("futureField").getJSONArray("metadata").optString(0) == "keep")
        val stored = repository.note(note.syncId)!!
        assertEquals(note.body, stored.body)
        assertEquals(richItem, stored.items.single().getString("data"))
        assertEquals(drawing.toString(), stored.raw.getJSONArray("images").getJSONObject(0).toString())
        assertEquals(attachment.toString(), stored.raw.getJSONArray("attachments").getJSONObject(0).toString())
        assertEquals(note.raw.getJSONObject("futureField").toString(), stored.raw.getJSONObject("futureField").toString())
    }

    @Test fun inlineDrawingSvgCanBeRenderedForAnExistingNotePreview() = runBlocking {
        val svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"8\" height=\"8\"><rect width=\"8\" height=\"8\" fill=\"#f00\"/></svg>"
        val dataUrl = "data:image/svg+xml;base64," + Base64.encodeToString(svg.toByteArray(), Base64.NO_WRAP)
        val bitmap = Media(app).preview(dataUrl)
        assertNotNull(bitmap)
        assertEquals(8, bitmap!!.width)
        assertEquals(8, bitmap.height)
    }

    @Test fun expiredSessionRetainsCachedNotesAndPendingDraftsForReauthentication() = runBlocking {
        profile.token = "expired-session"
        val note = Note.create(profile.userId)
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.enqueue(Outbox("offline-edit", profile.profile, "note.upsert", note.syncId, note.raw.toString(), baseRevision = 0))
        (repository.api as FakeNativeApi).callHandler = { _, _, _ -> throw ApiException(401, "Session expired") }

        runCatching { repository.sync() }

        assertNotNull(repository.store.record(profile.profile, "note", note.syncId))
        assertEquals("offline-edit", repository.store.pending(profile.profile).single().operationId)
        assertTrue(repository.connectionState.value is ConnectionState.SessionExpired)
        assertTrue(profile.message.isNotBlank())
    }

    @Test fun logoutCleanupDeletesOnlyTheActiveProfilesPendingUploadFiles() = runBlocking {
        val folder = java.io.File(app.filesDir, "pending-media").apply { mkdirs() }
        val currentFile = java.io.File(folder, "current-profile-upload").apply { writeText("current") }
        val otherFile = java.io.File(folder, "other-profile-upload").apply { writeText("other") }
        repository.store.enqueue(Outbox("current-upload", profile.profile, "media.upload", "current-note:file",
            JSONObject().put("file", currentFile.name).put("noteSyncId", "current-note").toString()))
        repository.store.enqueue(Outbox("other-upload", "${profile.origin}#22", "media.upload", "other-note:file",
            JSONObject().put("file", otherFile.name).put("noteSyncId", "other-note").toString()))

        Media(app).clearProfile(profile.profile, pendingUploads = true)

        assertFalse(currentFile.exists())
        assertTrue(otherFile.exists())
    }

    @Test fun mediaCacheEvictionNeverDeletesAnotherProfilesCache() {
        val folder = java.io.File(app.cacheDir, "media-eviction-test").apply { mkdirs() }
        val oldOwn = java.io.File(folder, "profileA_old").apply { writeBytes(ByteArray(4)); setLastModified(1) }
        val currentOwn = java.io.File(folder, "profileA_current").apply { writeBytes(ByteArray(4)); setLastModified(3) }
        val otherProfile = java.io.File(folder, "profileB_cached").apply { writeBytes(ByteArray(10)); setLastModified(2) }

        evictProfileCache(folder, "profileA", currentOwn, maxBytes = 5)

        assertTrue(currentOwn.exists())
        assertTrue(otherProfile.exists())
        assertTrue("old cache for this profile is evicted first", !oldOwn.exists())
        folder.deleteRecursively()
    }

    @Test fun openingAndSavingAnUnchangedReminderKeepsItsScheduleVersion() = runBlocking {
        val note = Note(JSONObject().put("id", 71).put("syncId", "reminded-note").put("ownerUserId", profile.userId)
            .put("noteTitle", "Keep time unchanged").put("noteBody", "").put("isCbox", false))
        val reminderId = "existing-schedule"
        val reminder = JSONObject().put("id", 9).put("syncId", reminderId).put("noteId", note.id).put("noteSyncId", note.syncId)
            .put("userId", profile.userId).put("dueAtUtc", "2030-01-01T09:00:00.000Z").put("timezone", "UTC")
            .put("repeatRule", "{\"type\":\"daily\",\"moveToTopOnTrigger\":true}").put("scheduleVersion", 4).put("status", "pending")
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.put(Record(profile.profile, "reminder", reminderId, reminder.toString()))

        repository.setReminder(note, "2030-01-01T09:00:00Z", "UTC", "{\"type\":\"daily\",\"moveToTopOnTrigger\":true}")

        val operation = repository.store.pending(profile.profile).single()
        assertEquals(4L, operation.baseScheduleVersion)
        assertEquals(4, JSONObject(operation.payload).getInt("scheduleVersion"))
        assertEquals("UTC", JSONObject(operation.payload).getString("timezone"))
        assertTrue(JSONObject(JSONObject(operation.payload).getString("repeatRule")).getBoolean("moveToTopOnTrigger"))
    }

    @Test fun checklistCollapseQueuesDurablePerUserStateWithoutAContentMutation() = runBlocking {
        profile.token = "test-session"
        val note = Note(JSONObject().put("id", 101).put("syncId", "collapsed-view-state").put("revision", 6)
            .put("ownerUserId", profile.userId).put("noteTitle", "Shared content").put("noteBody", "Body")
            .put("isCbox", true).put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray()))
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.cursor(SyncState(profile.profile, 0))
        repository.setChecklistCollapsed(note, true)
        val operation = repository.store.pending(profile.profile).single()
        assertEquals("note.view-state", operation.type)
        assertEquals(true, JSONObject(operation.payload).getBoolean("completedChecklistCollapsed"))
        assertTrue(repository.store.pending(profile.profile).none { it.type == "note.upsert" })

        (repository.api as FakeNativeApi).callHandler = { path, _, body ->
            when {
                path == "/api/sync/mutations" -> {
                    val mutation = body!!.getJSONArray("mutations").getJSONObject(0)
                    assertEquals("note.view-state", mutation.getString("type"))
                    val accepted = note.raw.copyJson().put("completedChecklistCollapsed", true)
                    JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true).put("resourceType", "note-view-state")
                        .put("syncId", note.syncId).put("id", note.id))).put("snapshot", JSONObject()
                        .put("notes", JSONArray().put(accepted)).put("reminders", JSONArray()).put("attachments", JSONArray())
                        .put("occurrences", JSONArray()).put("cursor", 0)).toString()
                }
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }

        repository.sync()

        assertTrue(repository.store.pending(profile.profile).isEmpty())
        val synced = Note(JSONObject(repository.store.record(profile.profile, "note", note.syncId)!!.payload))
        assertEquals("Shared content", synced.title)
        assertTrue(synced.raw.getBoolean("completedChecklistCollapsed"))
    }

    @Test fun resolvingReminderConflictNeverWritesReminderPayloadIntoNotes() = runBlocking {
        val reminderId = "reminder-conflict"
        val local = JSONObject().put("id", 12).put("syncId", reminderId).put("userId", profile.userId)
            .put("dueAtUtc", "2030-01-01T09:00:00.000Z").put("scheduleAnchorAtUtc", "2030-01-01T09:00:00.000Z")
            .put("timezone", "UTC").put("repeatRule", "{\"type\":\"daily\"}").put("scheduleVersion", 4).put("status", "pending")
        val latest = local.copyJson().put("scheduleVersion", 5).put("dueAtUtc", "2030-01-02T09:00:00.000Z")
        val conflict = Outbox("reminder-conflict-op", profile.profile, "reminder.upsert", reminderId, local.toString(),
            baseScheduleVersion = 4, conflict = JSONObject().put("status", 409).put("latest", latest).toString(), state = OutboxState.CONFLICT)
        repository.store.put(Record(profile.profile, "reminder", reminderId, local.toString()))
        repository.store.enqueue(conflict)

        repository.resolve(conflict, ConflictResolution.REPLACE_WITH_DRAFT)

        assertNull(repository.store.record(profile.profile, "note", reminderId))
        assertEquals("reminder.upsert", repository.store.pending(profile.profile).single().type)
        assertEquals(5L, repository.store.pending(profile.profile).single().baseScheduleVersion)
        val replacement = JSONObject(repository.store.pending(profile.profile).single().payload)
        assertEquals(6, replacement.getInt("scheduleVersion"))
        assertEquals("2030-01-01T09:00:00.000Z", replacement.getString("scheduleAnchorAtUtc"))
    }

    @Test fun noteConflictReplacementRebasesDraftOntoLatestServerMetadata() = runBlocking {
        val syncId = "replace-note-conflict"
        val draft = JSONObject().put("id", 44).put("syncId", syncId).put("revision", 5).put("ownerUserId", profile.userId)
            .put("noteTitle", "Local title").put("noteBody", "Local body").put("futureLocal", JSONObject().put("keep", true))
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray())
        val latest = JSONObject().put("id", 44).put("syncId", syncId).put("revision", 8).put("ownerUserId", profile.userId)
            .put("noteTitle", "Server title").put("noteBody", "Server body").put("futureServer", "preserve")
            .put("collaborators", JSONArray().put(JSONObject().put("id", 25))).put("completedChecklistCollapsed", true)
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray())
        val conflict = Outbox("replace-note-conflict-op", profile.profile, "note.upsert", syncId, draft.toString(), baseRevision = 5,
            conflict = JSONObject().put("status", 409).put("latest", latest).toString(), state = OutboxState.CONFLICT)
        repository.store.put(Record(profile.profile, "note", syncId, draft.toString()))
        repository.store.enqueue(conflict)

        repository.resolve(conflict, ConflictResolution.REPLACE_WITH_DRAFT)

        val replacement = repository.store.pending(profile.profile).single()
        val payload = JSONObject(replacement.payload)
        assertEquals(8L, replacement.baseRevision)
        assertEquals("Local title", payload.getString("noteTitle"))
        assertEquals("Local body", payload.getString("noteBody"))
        assertEquals("preserve", payload.getString("futureServer"))
        assertEquals(true, payload.getBoolean("completedChecklistCollapsed"))
        assertEquals(25, payload.getJSONArray("collaborators").getJSONObject(0).getInt("id"))
        assertEquals(true, payload.getJSONObject("futureLocal").getBoolean("keep"))
    }

    @Test fun choosingServerVersionDeletesOnlyItsPendingDraftFiles() = runBlocking {
        val syncId = "use-server-conflict"
        val local = JSONObject().put("id", 48).put("syncId", syncId).put("revision", 1).put("noteTitle", "Local")
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray())
        val latest = local.copyJson().put("revision", 2).put("noteTitle", "Server")
        val conflict = Outbox("use-server-conflict-op", profile.profile, "note.upsert", syncId, local.toString(), baseRevision = 1,
            conflict = JSONObject().put("status", 409).put("latest", latest).toString(), state = OutboxState.CONFLICT)
        val folder = java.io.File(app.filesDir, "pending-media").apply { mkdirs() }
        val ownFile = java.io.File(folder, "conflicted-profile-file").apply { writeText("current") }
        val otherFile = java.io.File(folder, "other-profile-file").apply { writeText("other") }
        repository.store.put(Record(profile.profile, "note", syncId, local.toString()))
        repository.store.enqueue(conflict)
        repository.store.enqueue(Outbox("use-server-upload", profile.profile, "media.upload", "$syncId:own",
            JSONObject().put("file", ownFile.name).put("noteSyncId", syncId).toString()))
        repository.store.enqueue(Outbox("other-profile-upload", "${profile.origin}#33", "media.upload", "other:file",
            JSONObject().put("file", otherFile.name).put("noteSyncId", "other").toString()))

        repository.resolve(conflict, ConflictResolution.USE_SERVER)

        assertEquals("Server", JSONObject(repository.store.record(profile.profile, "note", syncId)!!.payload).getString("noteTitle"))
        assertTrue(repository.store.pending(profile.profile).isEmpty())
        assertFalse(ownFile.exists())
        assertTrue(otherFile.exists())
    }

    @Test fun saveAsCopyResolutionRetainsRecoverableUploadsButDropsServerOnlyAttachments() = runBlocking {
        val syncId = "copy-conflict-source"
        val note = Note(JSONObject().put("id", 33).put("syncId", syncId).put("revision", 3)
            .put("ownerUserId", profile.userId).put("noteTitle", "Recover me")
            .put("noteBody", "Text<img src=\"/api/uploads/images/private.png\"><img src=\"data:image/png;base64,YWJj\">")
            .put("attachments", JSONArray().put(JSONObject().put("id", 8).put("originalName", "server-only.txt")))
            .put("images", JSONArray().put(JSONObject().put("id", "private").put("dataUrl", "/api/uploads/images/private.png"))
                .put(JSONObject().put("id", "inline").put("dataUrl", "data:image/png;base64,YWJj")))
            .put("checkBoxes", JSONArray()).put("labels", JSONArray()))
        repository.store.put(Record(profile.profile, "note", syncId, note.raw.toString()))
        val noteConflict = Outbox("copy-note-op", profile.profile, "note.upsert", syncId, note.raw.toString(), baseRevision = 2,
            conflict = JSONObject().put("error", "Note access was removed.").toString(), state = OutboxState.CONFLICT)
        val uploadFile = java.io.File(app.filesDir, "pending-media/recoverable-upload").apply { parentFile?.mkdirs(); writeText("file") }
        val upload = Outbox("copy-upload-op", profile.profile, "media.upload", "$syncId:${uploadFile.name}",
            JSONObject().put("file", uploadFile.name).put("name", "recoverable.txt").put("mime", "text/plain").put("noteSyncId", syncId).toString(),
            state = OutboxState.CONFLICT, conflict = JSONObject().put("error", "The parent note was revoked.").toString())
        repository.store.enqueue(noteConflict)
        repository.store.enqueue(upload)

        repository.resolve(noteConflict, ConflictResolution.SAVE_AS_COPY)

        val copied = repository.store.list(profile.profile, "note").map { JSONObject(it.payload) }.single { it.text("syncId") != syncId }
        assertEquals("Recover me", copied.getString("noteTitle"))
        assertFalse("server-only attachment records are not represented as copied files", copied.has("attachments"))
        assertFalse(copied.getString("noteBody").contains("/api/uploads/images/private.png"))
        assertTrue(copied.getString("noteBody").contains("data:image/png;base64,YWJj"))
        assertEquals(1, copied.getJSONArray("images").length())
        assertEquals("data:image/png;base64,YWJj", copied.getJSONArray("images").getJSONObject(0).getString("dataUrl"))
        val pendingUpload = repository.store.pending(profile.profile).single { it.type == "media.upload" }
        assertEquals(copied.getString("syncId"), JSONObject(pendingUpload.payload).getString("noteSyncId"))
        assertEquals(uploadFile.name, JSONObject(pendingUpload.payload).getString("file"))
        assertTrue(uploadFile.exists())
        assertEquals(0, repository.store.pending(profile.profile).count { it.syncId == syncId && it.type == "note.upsert" })
    }

    @Test fun localEditsCanBePersistedWhileARequestIsInFlight() = runBlocking {
        profile.token = "test-session"
        val note = Note(JSONObject().put("id", 71).put("syncId", "edit-during-sync").put("revision", 1)
            .put("ownerUserId", profile.userId).put("noteTitle", "Before").put("noteBody", "Body")
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray()))
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.enqueue(Outbox("in-flight-save", profile.profile, "note.upsert", note.syncId, note.raw.toString(), baseRevision = 1))
        repository.store.cursor(SyncState(profile.profile, 0))
        val requestStarted = CompletableDeferred<Unit>()
        val releaseResponse = CompletableDeferred<Unit>()
        (repository.api as FakeNativeApi).callHandler = { path, _, _ ->
            when {
                path == "/api/sync/mutations" -> {
                    requestStarted.complete(Unit)
                    releaseResponse.await()
                    val accepted = note.raw.copyJson().put("revision", 2)
                    JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true).put("id", note.id)))
                        .put("snapshot", JSONObject().put("notes", JSONArray().put(accepted)).put("reminders", JSONArray())
                            .put("attachments", JSONArray()).put("occurrences", JSONArray()).put("cursor", 0)).toString()
                }
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }
        val sync = launch { repository.sync() }
        requestStarted.await()
        val edit = async { repository.save(Note(note.raw.copyJson().put("noteTitle", "Typed during request"))) }
        val persistedBeforeResponse = withTimeoutOrNull(100) { edit.await(); true } ?: false
        releaseResponse.complete(Unit)
        sync.join()
        if (!persistedBeforeResponse) edit.await()
        assertTrue("network synchronization must not block local persistence", persistedBeforeResponse)
    }

    @Test fun editorRebasesAnInFlightEditOnlyOnItsAcceptedPredecessor() = runBlocking {
        profile.token = "test-session"
        val note = Note(JSONObject().put("id", 96).put("syncId", "editor-successor").put("revision", 7)
            .put("ownerUserId", profile.userId).put("noteTitle", "Base").put("noteBody", "")
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray()))
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.cursor(SyncState(profile.profile, 0))
        val editor = NoteEditorViewModel(repository, note)
        editor.change { it.put("noteTitle", "First accepted draft") }
        withTimeoutOrNull(5_000) { while (editor.localSaving.value) delay(10) }
            ?: error("first editor draft did not persist")

        val firstRequest = CompletableDeferred<Unit>()
        val releaseFirst = CompletableDeferred<Unit>()
        val secondRequest = CompletableDeferred<Unit>()
        val releaseSecond = CompletableDeferred<Unit>()
        var calls = 0
        fun response(payload: JSONObject, revision: Long) = JSONObject()
            .put("results", JSONArray().put(JSONObject().put("ok", true).put("resourceType", "note")
                .put("syncId", note.syncId).put("id", note.id)))
            .put("snapshot", JSONObject().put("notes", JSONArray().put(payload.copyJson().put("revision", revision)))
                .put("reminders", JSONArray()).put("attachments", JSONArray()).put("occurrences", JSONArray()).put("cursor", 0)).toString()
        (repository.api as FakeNativeApi).callHandler = { path, _, body ->
            when {
                path == "/api/sync/mutations" -> {
                    calls += 1
                    val mutation = body!!.getJSONArray("mutations").getJSONObject(0)
                    val payload = mutation.getJSONObject("payload")
                    if (calls == 1) {
                        firstRequest.complete(Unit)
                        releaseFirst.await()
                        response(payload, 8)
                    } else {
                        assertEquals("Later edits must use the accepted predecessor revision", 8L, mutation.getLong("baseRevision"))
                        secondRequest.complete(Unit)
                        releaseSecond.await()
                        response(payload, 9)
                    }
                }
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }

        val sync = launch(Dispatchers.IO) { repository.sync() }
        firstRequest.await()
        editor.change { it.put("noteTitle", "Later draft") }
        withTimeoutOrNull(5_000) { while (editor.localSaving.value) delay(10) }
            ?: error("later editor draft did not persist")
        releaseFirst.complete(Unit)
        secondRequest.await()
        withTimeoutOrNull(5_000) {
            while (editor.draft.value.optLong("revision") != 8L || !editor.dirty.value) delay(10)
        } ?: error("editor did not retain the later draft on the accepted predecessor")
        assertEquals("Later draft", editor.draft.value.getString("noteTitle"))
        releaseSecond.complete(Unit)
        sync.join()
        withTimeoutOrNull(5_000) { while (editor.dirty.value || editor.draft.value.optLong("revision") != 9L) delay(10) }
            ?: error("editor did not adopt the final accepted revision")
        assertEquals("Later draft", editor.draft.value.getString("noteTitle"))
    }

    @Test fun revisionConflictSurfacesIncomingNoteWithoutReplacingTheOpenDraft() = runBlocking {
        profile.token = "test-session"
        val note = Note(JSONObject().put("id", 97).put("syncId", "editor-conflict").put("revision", 4)
            .put("ownerUserId", profile.userId).put("noteTitle", "Base").put("noteBody", "")
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray()))
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.cursor(SyncState(profile.profile, 0))
        val editor = NoteEditorViewModel(repository, note)
        editor.change { it.put("noteTitle", "Local draft") }
        withTimeoutOrNull(5_000) { while (editor.localSaving.value) delay(10) }
            ?: error("local draft did not persist")
        val latest = note.raw.copyJson().put("revision", 5).put("noteTitle", "Web version")
        (repository.api as FakeNativeApi).callHandler = { path, _, _ ->
            when {
                path == "/api/sync/mutations" -> JSONObject().put("results", JSONArray().put(JSONObject()
                    .put("ok", false).put("status", 409).put("error", "changed elsewhere").put("latest", latest)))
                    .put("snapshot", JSONObject().put("notes", JSONArray().put(latest)).put("reminders", JSONArray())
                        .put("attachments", JSONArray()).put("occurrences", JSONArray()).put("cursor", 0)).toString()
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }

        repository.sync()
        withTimeoutOrNull(5_000) { while (editor.incoming.value == null) delay(10) }
            ?: error("incoming server version was not surfaced")
        assertEquals("Local draft", editor.draft.value.getString("noteTitle"))
        assertEquals("Web version", editor.incoming.value?.title)
        assertTrue(editor.dirty.value)
        assertTrue(repository.status.value.contains("attention"))
    }

    @Test fun successorEditWaitsForItsInFlightPredecessorAndUsesTheAcceptedRevision() = runBlocking {
        profile.token = "test-session"
        val note = Note(JSONObject().put("id", 88).put("syncId", "queued-successor").put("revision", 1)
            .put("ownerUserId", profile.userId).put("noteTitle", "Base").put("noteBody", "")
            .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray()))
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.enqueue(Outbox("predecessor", profile.profile, "note.upsert", note.syncId, note.raw.toString(), baseRevision = 1))
        repository.store.cursor(SyncState(profile.profile, 0))
        val requestStarted = CompletableDeferred<Unit>()
        val releaseFirstResponse = CompletableDeferred<Unit>()
        var secondBaseRevision = -1L
        var secondTitle = ""
        var calls = 0
        fun response(revision: Long, title: String) = JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true)
            .put("resourceType", "note").put("syncId", note.syncId).put("id", note.id))).put("snapshot", JSONObject()
            .put("notes", JSONArray().put(note.raw.copyJson().put("revision", revision).put("noteTitle", title)))
            .put("reminders", JSONArray()).put("attachments", JSONArray()).put("occurrences", JSONArray()).put("cursor", 0)).toString()
        (repository.api as FakeNativeApi).callHandler = { path, _, body ->
            when {
                path == "/api/sync/mutations" -> {
                    calls += 1
                    val mutation = body!!.getJSONArray("mutations").getJSONObject(0)
                    if (calls == 1) {
                        requestStarted.complete(Unit)
                        releaseFirstResponse.await()
                        response(2, "Base")
                    } else {
                        secondBaseRevision = mutation.getLong("baseRevision")
                        secondTitle = mutation.getJSONObject("payload").getString("noteTitle")
                        response(3, secondTitle)
                    }
                }
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }
        val sync = launch { repository.sync() }
        requestStarted.await()
        repository.save(Note(note.raw.copyJson().put("noteTitle", "Typed while request was running")))
        releaseFirstResponse.complete(Unit)
        sync.join()

        assertEquals(2, calls)
        assertEquals(2L, secondBaseRevision)
        assertEquals("Typed while request was running", secondTitle)
        assertEquals(3L, repository.note(note.syncId)?.revision)
    }

    private fun syncNote(id: Long, syncId: String, revision: Long, title: String = "Base") = Note(JSONObject().put("id", id)
        .put("syncId", syncId).put("revision", revision).put("ownerUserId", profile.userId).put("noteTitle", title).put("noteBody", "")
        .put("checkBoxes", JSONArray()).put("images", JSONArray()).put("labels", JSONArray()))

    // Accepts every note.upsert, records what was sent and answers with a snapshot of the sent note at base + 1.
    private fun acceptAllUpserts(sent: MutableList<JSONObject>) {
        (repository.api as FakeNativeApi).callHandler = { path, _, body ->
            when {
                path == "/api/sync/mutations" -> {
                    val mutation = body!!.getJSONArray("mutations").getJSONObject(0)
                    sent += mutation
                    val payload = mutation.getJSONObject("payload")
                    JSONObject().put("results", JSONArray().put(JSONObject().put("ok", true).put("resourceType", "note")
                        .put("syncId", mutation.getString("syncId")).put("id", payload.optLong("id", 1))))
                        .put("snapshot", JSONObject().put("notes", JSONArray().put(payload.copyJson().put("revision", mutation.getLong("baseRevision") + 1)))
                            .put("reminders", JSONArray()).put("attachments", JSONArray()).put("occurrences", JSONArray()).put("cursor", 0)).toString()
                }
                path.startsWith("/api/sync/changes?") -> JSONObject().put("changes", JSONArray()).put("cursor", 0).put("hasMore", false).toString()
                path == "/api/native/reminders/occurrences" -> "[]"
                else -> error("Unexpected request $path")
            }
        }
    }

    @Test fun syncReleasesAnEditQueuedBehindAnOperationThatNoLongerExists() = runBlocking {
        profile.token = "test-session"
        val note = syncNote(90, "orphaned-edit", 4, "Full text")
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.enqueue(Outbox("orphan", profile.profile, "note.upsert", note.syncId, note.raw.toString(),
            baseRevision = 1, dependsOnOperationId = "acknowledged-long-ago"))
        repository.store.cursor(SyncState(profile.profile, 0))
        val sent = mutableListOf<JSONObject>()
        acceptAllUpserts(sent)

        repository.sync()

        assertEquals(listOf("orphan"), sent.map { it.getString("operationId") })
        assertEquals("the stale base revision is replaced by the stored note's revision", 4L, sent.single().getLong("baseRevision"))
        assertTrue(repository.store.pending(profile.profile).isEmpty())
    }

    @Test fun editsAfterAFailedAttemptChainBehindTheSentOperationInsteadOfRewritingIt() = runBlocking {
        profile.token = "test-session"
        val note = syncNote(91, "retried-edit", 1, "Draft one")
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.enqueue(Outbox("first", profile.profile, "note.upsert", note.syncId, note.raw.toString(), baseRevision = 1))
        repository.store.cursor(SyncState(profile.profile, 0))
        (repository.api as FakeNativeApi).callHandler = { _, _, _ -> throw ApiException(503, "offline") }
        assertTrue(runCatching { repository.sync() }.isFailure)

        repository.save(Note(note.raw.copyJson().put("noteTitle", "Draft two")))

        val pending = repository.store.pending(profile.profile)
        val first = pending.single { it.operationId == "first" }
        assertTrue(first.attempted)
        assertEquals("Draft one", JSONObject(first.payload).getString("noteTitle"))
        val second = pending.single { it.operationId != "first" }
        assertEquals("first", second.dependsOnOperationId)
        assertEquals("Draft two", JSONObject(second.payload).getString("noteTitle"))

        val sent = mutableListOf<JSONObject>()
        acceptAllUpserts(sent)
        repository.sync()

        assertEquals(listOf("first", second.operationId), sent.map { it.getString("operationId") })
        assertEquals(listOf(1L, 2L), sent.map { it.getLong("baseRevision") })
        assertTrue(repository.store.pending(profile.profile).isEmpty())
    }

    @Test fun saveUsesTheAcceptedRevisionWhenTheEditorCopyIsStale() = runBlocking {
        profile.token = "test-session"
        val note = syncNote(92, "stale-editor", 1)
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        repository.store.enqueue(Outbox("accepted", profile.profile, "note.upsert", note.syncId, note.raw.toString(), baseRevision = 1))
        repository.store.cursor(SyncState(profile.profile, 0))
        acceptAllUpserts(mutableListOf())
        repository.sync()

        repository.save(Note(note.raw.copyJson().put("noteTitle", "Typed before the editor saw the acknowledgement")))

        assertEquals(2L, repository.store.pending(profile.profile).single().baseRevision)
        assertEquals(2L, repository.note(note.syncId)?.revision)
    }

    private class FakeProfile(override var origin: String, override var userId: Long) : ConnectionProfile {
        private val aliases = mutableMapOf<String, String>()
        private val gatewayHeaders = mutableMapOf<String, String>()
        override var alias: String
            get() = aliasFor(origin)
            set(value) = setAliasFor(origin, value)
        override fun aliasFor(server: String) = aliases[server.trimEnd('/')] ?: ""
        override fun setAliasFor(server: String, value: String) { aliases[server.trimEnd('/')] = value }
        override fun headersFor(server: String) = gatewayHeaders[server.trimEnd('/')] ?: ""
        override fun setHeadersFor(server: String, value: String) { gatewayHeaders[server.trimEnd('/')] = value }
        override val profile get() = "$origin#$userId"
        override var token = ""
        override var headers: String
            get() = headersFor(origin)
            set(value) = setHeadersFor(origin, value)
        override var message = ""
        override var darkMode = false
    }

    private class FakeNativeApi : NativeApi {
        var callHandler: (suspend (String, String, JSONObject?) -> String)? = null
        override fun client(connection: ConnectionSnapshot?) = OkHttpClient()
        override fun request(path: String, connection: ConnectionSnapshot?): Request.Builder = error("Network should not be used by local outbox tests")
        override suspend fun call(path: String, method: String, body: JSONObject?, connection: ConnectionSnapshot?): String =
            callHandler?.invoke(path, method, body) ?: error("Network should not be used by local outbox tests")
        override suspend fun login(origin: String, username: String, password: String, totp: String, gatewayHeaders: String) = JSONObject()
        override suspend fun testConnection(origin: String, headers: String) = "connected"
    }

    private class FakeReminderController : ReminderController {
        var reconcileCalls = 0
        override fun precise() = true
        override fun notificationsAllowed() = true
        override fun now() = java.time.Instant.EPOCH
        override suspend fun reconcile() { reconcileCalls++ }
        override suspend fun resetAlarmRegistry() = Unit
        override suspend fun deliver(key: String, occurrence: JSONObject) = Unit
        override suspend fun act(key: String, occurrence: JSONObject, state: String, snoozeUntil: String?) = false
        override fun cancelAll() = Unit
        override fun testNotification() = Unit
        override fun cancelNotification(key: String) = Unit
    }

    private class FakeAlarms : ReminderAlarmScheduler {
        val scheduled = mutableListOf<Pair<Long, PendingIntent>>()
        var exactAllowed = true
        var exactThrows = false
        var exactAttempts = 0
        var inexactSchedules = 0
        override fun canScheduleExactAlarms() = exactAllowed
        override fun scheduleExact(atMillis: Long, pendingIntent: PendingIntent) {
            exactAttempts++
            if (exactThrows) throw SecurityException("Exact alarm permission was revoked")
            scheduled += atMillis to pendingIntent
        }
        override fun scheduleInexact(atMillis: Long, pendingIntent: PendingIntent) { inexactSchedules++; scheduled += atMillis to pendingIntent }
        override fun cancel(pendingIntent: PendingIntent) { scheduled.removeAll { it.second == pendingIntent } }
    }

    private class FakeNotifications : ReminderNotificationSink {
        val delivered = mutableListOf<JSONObject>()
        val shownKeys = mutableListOf<String>()
        val catchUpSummaries = mutableListOf<JSONObject>()
        var allowed = true
        var failAfterShow = false
        override fun notificationsAllowed() = allowed
        override fun ensureChannel() = Unit
        override fun showTestNotification() = Unit
        override suspend fun show(occurrence: JSONObject, key: String, note: Note?): Boolean {
            shownKeys += key
            delivered += occurrence.copyJson()
            if (failAfterShow) error("Simulated process death after notification posting")
            return allowed
        }
        override suspend fun showCatchUpSummary(key: String, count: Int, firstDueAtUtc: String, lastDueAtUtc: String, note: Note?): Boolean {
            if (!allowed) return false
            catchUpSummaries += JSONObject().put("key", key).put("count", count).put("firstDueAtUtc", firstDueAtUtc).put("lastDueAtUtc", lastDueAtUtc)
            return true
        }
        override fun cancel(key: String) = Unit
        override fun cancelAll() = Unit
    }
}
