package dev.keeparr.android.data

import androidx.room.Room
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.reminders.ReminderController
import dev.keeparr.android.ui.NoteEditorViewModel
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class EditorHotPathTest {
    private class Profile : ConnectionProfile {
        override var origin = "https://one.example.test"
        override var alias = ""
        override var userId = 11L
        override var token = "token"
        override var headers = ""
        override var message = ""
        override var darkMode = false
        override fun aliasFor(server: String) = ""
        override fun setAliasFor(server: String, value: String) {}
        override fun headersFor(server: String) = ""
        override fun setHeadersFor(server: String, value: String) {}
        override val profile get() = "$origin#$userId"
    }

    private class OfflineApi : NativeApi {
        override fun client(connection: ConnectionSnapshot?) = OkHttpClient()
        override fun request(path: String, connection: ConnectionSnapshot?): Request.Builder = error("offline")
        override suspend fun call(path: String, method: String, body: JSONObject?, connection: ConnectionSnapshot?): String = error("offline")
        override suspend fun login(origin: String, username: String, password: String, totp: String, gatewayHeaders: String) = JSONObject()
        override suspend fun testConnection(origin: String, headers: String) = ""
    }

    private class NoReminders : ReminderController {
        override fun precise() = true
        override fun notificationsAllowed() = true
        override fun now() = java.time.Instant.EPOCH
        override suspend fun reconcile() {}
        override suspend fun resetAlarmRegistry() {}
        override suspend fun deliver(key: String, occurrence: JSONObject) = Unit
        override suspend fun act(key: String, occurrence: JSONObject, state: String, snoozeUntil: String?) = false
        override fun cancelAll() = Unit
        override fun testNotification() = Unit
        override fun cancelNotification(key: String) = Unit
    }

    private lateinit var app: KeeparrApplication
    private lateinit var repository: KeeparrRepository
    private lateinit var profile: Profile
    private val syncRequests = AtomicInteger()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeeparrApplication
        app.scope.coroutineContext.cancel()
        app.database.close()
        profile = Profile()
        app.settings = profile
        app.database = Room.inMemoryDatabaseBuilder(app, KeeparrDatabase::class.java).allowMainThreadQueries().build()
        app.reminders = NoReminders()
        app.refreshWidgets = {}
        app.enqueueSync = { syncRequests.incrementAndGet() }
        repository = KeeparrRepository(app, app.database, profile, OfflineApi())
        app.repository = repository
    }

    @After fun tearDown() {
        app.database.close()
        app.scope.coroutineContext.cancel()
    }

    private suspend fun editor(raw: JSONObject = Note.create(profile.userId).raw.put("id", 70).put("revision", 2)): Pair<NoteEditorViewModel, Note> {
        val note = Note(raw)
        repository.save(note, synchronize = false)
        syncRequests.set(0)
        return NoteEditorViewModel(repository, note) to note
    }

    private suspend fun NoteEditorViewModel.awaitIdle() {
        withTimeoutOrNull(5_000) { while (localSaving.value) delay(10) } ?: error("local persistence did not finish")
    }

    @Test fun aTypingBurstCommitsOnceWithTheLatestTextAndOneOutboxEntry() = runBlocking {
        val (vm, note) = editor()
        val baseline = vm.localWriteCount
        repeat(60) { vm.change("noteTitle") { json -> json.put("noteTitle", "typed $it") } }
        vm.awaitIdle()
        assertTrue("60 keystrokes should not produce 60 commits", vm.localWriteCount - baseline <= 2)
        assertEquals("typed 59", repository.note(note.syncId)?.title)
        assertEquals("typed 59", JSONObject(repository.store.pending(profile.profile).single().payload).getString("noteTitle"))
    }

    @Test fun continuousTypingStillCommitsWithinTheUnsavedBound() = runBlocking {
        val (vm, note) = editor()
        val start = System.nanoTime()
        var committedWhileTyping = false
        var i = 0
        while ((System.nanoTime() - start) / 1_000_000 < 1_800) {
            vm.change("noteTitle") { json -> json.put("noteTitle", "t${i++}") }
            delay(60)
            if (repository.note(note.syncId)?.title?.startsWith("t") == true) { committedWhileTyping = true; break }
        }
        assertTrue("an edit must reach local storage while typing continues", committedWhileTyping)
        val elapsedMs = (System.nanoTime() - start) / 1_000_000
        assertTrue("committed after $elapsedMs ms", elapsedMs <= NoteEditorViewModel.MAX_UNSAVED_MS + 600)
        vm.awaitIdle()
    }

    @Test fun flushingAnAlreadyCommittedDraftOnlyQueuesSyncWithoutRewriting() = runBlocking {
        val (vm, note) = editor()
        vm.change("noteTitle") { it.put("noteTitle", "Committed") }
        vm.awaitIdle()
        val writes = vm.localWriteCount
        vm.flushAndQueueSync()
        assertEquals(writes, vm.localWriteCount)
        assertEquals(1, syncRequests.get())
        assertTrue("queueing is not an acknowledgement", vm.dirty.value)
        assertEquals("Committed", repository.note(note.syncId)?.title)
    }

    @Test fun flushingBeforeTheDebounceWritesOnceAndThePendingWriteDoesNotDuplicateIt() = runBlocking {
        val (vm, note) = editor()
        val baseline = vm.localWriteCount
        vm.change("noteTitle") { it.put("noteTitle", "Closing now") }
        vm.flushAndQueueSync()
        delay(NoteEditorViewModel.LOCAL_SAVE_DEBOUNCE_MS + 300)
        assertEquals(baseline + 1, vm.localWriteCount)
        assertFalse(vm.localSaving.value)
        assertEquals("Closing now", repository.note(note.syncId)?.title)
    }

    @Test fun leavingTheForegroundCommitsTheDebouncedEditImmediately() = runBlocking {
        val (vm, note) = editor()
        vm.change("noteBody") { it.put("noteBody", "<b>unsaved</b>") }
        assertNotEquals("<b>unsaved</b>", repository.note(note.syncId)?.body)
        vm.flushLocal()
        assertEquals("<b>unsaved</b>", repository.note(note.syncId)?.body)
        assertEquals("a background flush does not start a network sync", 0, syncRequests.get())
        vm.awaitIdle()
    }

    @Test fun fieldEditsShareUntouchedContentAndNeverMutateThePreviousDraft() = runBlocking {
        val raw = Note.create(profile.userId).raw.put("id", 71).put("revision", 1)
            .put("images", JSONArray().put(JSONObject().put("id", "drawing").put("dataUrl", "data:image/png;base64," + "A".repeat(50_000))))
            .put("isCbox", true)
            .put("checkBoxes", JSONArray().put(JSONObject().put("id", 1).put("done", false).put("data", "milk")))
            .put("futureField", JSONObject().put("kept", true))
        val (vm, _) = editor(raw)
        val before = vm.draft.value

        vm.change("noteTitle") { it.put("noteTitle", "New title") }
        val afterTitle = vm.draft.value
        assertSame("a title edit does not copy the image payload", before.getJSONArray("images"), afterTitle.getJSONArray("images"))
        assertSame(before.getJSONArray("checkBoxes"), afterTitle.getJSONArray("checkBoxes"))
        assertEquals("", before.getString("noteTitle"))

        vm.change("checkBoxes") { it.getJSONArray("checkBoxes").getJSONObject(0).put("data", "oat milk") }
        val afterItem = vm.draft.value
        assertEquals("milk", afterTitle.getJSONArray("checkBoxes").getJSONObject(0).getString("data"))
        assertEquals("oat milk", afterItem.getJSONArray("checkBoxes").getJSONObject(0).getString("data"))
        assertSame(afterTitle.getJSONArray("images"), afterItem.getJSONArray("images"))
        assertTrue(afterItem.getJSONObject("futureField").getBoolean("kept"))

        vm.change { it.getJSONArray("images").getJSONObject(0).put("name", "full-copy") }
        assertFalse("an unnamed change copies everything", afterItem.getJSONArray("images").getJSONObject(0).has("name"))
        vm.awaitIdle()
        val stored = repository.note(Note(raw).syncId)!!
        assertEquals("oat milk", stored.items.single().getString("data"))
        assertEquals("full-copy", stored.raw.getJSONArray("images").getJSONObject(0).getString("name"))
        assertTrue(stored.raw.getJSONObject("futureField").getBoolean("kept"))
    }

    @Test fun savingNeverMutatesTheCallersNoteAndSerializesTheRevisionOverride() = runBlocking {
        val note = Note(Note.create(profile.userId).raw.put("id", 72).put("revision", 1))
        repository.save(note, synchronize = false)
        val raw = Note(note.raw.copyJson().put("revision", 0).put("noteTitle", "x"))
        val snapshot = raw.raw.toString()
        repository.save(raw, synchronize = false)
        assertEquals(snapshot, raw.raw.toString())
        assertEquals("x", repository.note(note.syncId)?.title)
    }

    @Test fun editableContentComparisonIgnoresServerFieldsWithoutTouchingEitherNote() {
        val a = Note(JSONObject().put("syncId", "s").put("noteTitle", "T").put("revision", 1).put("updatedAt", "x").put("attachments", JSONArray()))
        val b = Note(JSONObject().put("syncId", "s").put("noteTitle", "T").put("revision", 9).put("updatedAt", "y").put("collaborators", JSONArray().put(1)))
        val beforeA = a.raw.toString(); val beforeB = b.raw.toString()
        assertTrue(EditorSnapshotPolicy.sameEditableContent(a, b))
        assertFalse(EditorSnapshotPolicy.sameEditableContent(a, Note(b.raw.copyJson().put("noteTitle", "other"))))
        assertEquals(beforeA, a.raw.toString())
        assertEquals(beforeB, b.raw.toString())
    }
}
