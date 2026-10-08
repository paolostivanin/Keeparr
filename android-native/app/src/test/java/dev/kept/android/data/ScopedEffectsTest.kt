package dev.kept.android.data

import androidx.room.Room
import dev.kept.android.KeptApplication
import dev.kept.android.reminders.ReminderController
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
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class EffectScopeTest {
    @Test fun aSingleNoteWidgetOnlyDependsOnItsNoteWhileCollectionsDependOnMembershipAndOrder() {
        val one = EffectScope.note("a")
        assertTrue(one.affectsWidget("note:a"))
        assertFalse(one.affectsWidget("note:b"))
        assertTrue(one.affectsWidget("home") && one.affectsWidget("label:x") && one.affectsWidget("pinned"))
        val order = EffectScope(order = true)
        assertTrue(order.affectsWidget("home"))
        assertFalse("reordering never changes a single note", order.affectsWidget("note:a"))
        assertFalse(EffectScope(alarms = true).touchesWidgets)
        assertTrue(EffectScope.FULL.affectsWidget("note:a"))
    }

    @Test fun mergingKeepsEveryDependencyAndEmptyScopesStayEmpty() {
        val merged = EffectScope.note("a") + EffectScope(notes = setOf("b"), alarms = true) + EffectScope()
        assertEquals(setOf("a", "b"), merged.notes)
        assertTrue(merged.alarms)
        assertFalse(merged.order || merged.full)
        assertTrue((EffectScope() + EffectScope()).isEmpty)
        assertTrue(EffectScope(notes = setOf("a")).let { it + EffectScope() === it })
    }

    @Test fun burstsMergeIntoOneWidgetPassAndAlarmsAreNeverDelayed() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val passes = CopyOnWriteArrayList<EffectScope>()
        val alarms = AtomicInteger()
        val dispatcher = EffectDispatcher(scope, quietMillis = 80, maxDelayMillis = 1000, alarms = { alarms.incrementAndGet() }, widgets = { passes += it })
        repeat(10) { dispatcher.request(EffectScope.note("n$it")) }
        dispatcher.request(EffectScope(alarms = true))
        withTimeout(500) { while (alarms.get() == 0) delay(5) }
        assertTrue("alarm reconciliation does not wait for the widget quiet period", passes.isEmpty())
        withTimeout(2000) { while (passes.isEmpty()) delay(10) }
        delay(150)
        assertEquals(1, passes.size)
        assertEquals((0 until 10).map { "n$it" }.toSet(), passes.single().notes)
        assertFalse("alarms are not repeated through widgets", passes.single().alarms)
        scope.cancel()
    }

    @Test fun continuousEditsCannotStarveWidgetsPastTheMaximumDelay() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val flushedAt = CopyOnWriteArrayList<Long>()
        val dispatcher = EffectDispatcher(scope, quietMillis = 100, maxDelayMillis = 300, alarms = {}, widgets = { flushedAt += System.nanoTime() })
        val start = System.nanoTime()
        var i = 0
        while ((System.nanoTime() - start) / 1_000_000 < 900) { dispatcher.request(EffectScope.note("n${i++}")); delay(40) }
        assertTrue("quiet period alone would never fire during a 40 ms edit stream", flushedAt.size >= 2)
        assertTrue((flushedAt.first() - start) / 1_000_000 < 600)
        scope.cancel()
    }
}

@RunWith(RobolectricTestRunner::class)
class ScopedEffectsRepositoryTest {
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

    private class Api : NativeApi {
        var handler: suspend (String) -> String = { error("offline") }
        override fun client(connection: ConnectionSnapshot?) = OkHttpClient()
        override fun request(path: String, connection: ConnectionSnapshot?): Request.Builder = error("offline")
        override suspend fun call(path: String, method: String, body: JSONObject?, connection: ConnectionSnapshot?): String = handler(path)
        override suspend fun login(origin: String, username: String, password: String, totp: String, gatewayHeaders: String) = JSONObject()
        override suspend fun testConnection(origin: String, headers: String) = ""
    }

    private class CountingReminders : ReminderController {
        val reconciles = AtomicInteger()
        override fun precise() = true
        override fun notificationsAllowed() = true
        override fun now() = java.time.Instant.EPOCH
        override suspend fun reconcile() { reconciles.incrementAndGet() }
        override suspend fun resetAlarmRegistry() {}
        override suspend fun deliver(key: String, occurrence: JSONObject) = Unit
        override suspend fun act(key: String, occurrence: JSONObject, state: String, snoozeUntil: String?) = false
        override fun cancelAll() = Unit
        override fun testNotification() = Unit
        override fun cancelNotification(key: String) = Unit
    }

    private lateinit var app: KeptApplication
    private lateinit var repository: KeptRepository
    private lateinit var profile: Profile
    private lateinit var reminders: CountingReminders
    private val api = Api()
    private val scoped = CopyOnWriteArrayList<EffectScope>()
    private val fullRefreshes = AtomicInteger()
    private val syncRequests = AtomicInteger()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeptApplication
        app.scope.coroutineContext.cancel()
        app.database.close()
        app.scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        profile = Profile()
        app.settings = profile
        app.database = Room.inMemoryDatabaseBuilder(app, KeptDatabase::class.java).allowMainThreadQueries().build()
        reminders = CountingReminders()
        app.reminders = reminders
        app.refreshWidgets = { fullRefreshes.incrementAndGet() }
        app.refreshWidgetScope = { _, scope -> scoped += scope }
        app.enqueueSync = { syncRequests.incrementAndGet() }
        repository = KeptRepository(app, app.database, profile, api)
        app.repository = repository
    }

    @After fun tearDown() {
        app.database.close()
        app.scope.coroutineContext.cancel()
    }

    private suspend fun awaitWidgets(count: Int = 1) {
        withTimeoutOrNull(4000) { while (scoped.size < count) delay(10) } ?: error("no widget pass")
    }

    private suspend fun settle() { delay(500) }

    private suspend fun seed(note: Note = Note.create(profile.userId).also { it.raw.put("id", 5).put("revision", 1) }): Note {
        repository.store.put(Record(profile.profile, "note", note.syncId, note.raw.toString()))
        return note
    }

    @Test fun editingOneNoteRefreshesOnlyThatNotesWidgetsAndLeavesAlarmsAlone() = runBlocking {
        val note = seed()
        repository.save(Note(note.raw.copyJson().put("noteTitle", "Edited")))
        awaitWidgets()
        settle()
        assertEquals(1, scoped.size)
        assertEquals(setOf(note.syncId), scoped.single().notes)
        assertFalse(scoped.single().affectsWidget("note:another"))
        assertEquals(0, reminders.reconciles.get())
        assertEquals(0, fullRefreshes.get())
    }

    @Test fun aSaveBurstProducesOneWidgetPassWithEveryChangedNote() = runBlocking {
        val notes = (1..6).map { seed(Note.create(profile.userId).also { n -> n.raw.put("id", it).put("revision", 1) }) }
        notes.forEach { repository.save(Note(it.raw.copyJson().put("noteTitle", "x"))) }
        awaitWidgets()
        settle()
        assertEquals(1, scoped.size)
        assertEquals(notes.map { it.syncId }.toSet(), scoped.single().notes)
    }

    @Test fun archivingAlsoReplansAlarms() = runBlocking {
        val note = seed()
        repository.save(Note(note.raw.copyJson().put("archived", true)))
        withTimeoutOrNull(2000) { while (reminders.reconciles.get() == 0) delay(10) } ?: error("alarms were not reconciled")
        assertEquals(1, reminders.reconciles.get())
    }

    @Test fun savingAnUnchangedSyncedNoteWritesAndNotifiesNothing() = runBlocking {
        val note = seed()
        repository.save(Note(note.raw.copyJson()), synchronize = true)
        settle()
        assertTrue(repository.store.pending(profile.profile).isEmpty())
        assertEquals(0, syncRequests.get())
        assertTrue(scoped.isEmpty())
    }

    @Test fun savingAnUnchangedUnsentNoteKeepsItsSingleQueuedOperation() = runBlocking {
        val note = Note.create(profile.userId)
        repository.save(note)
        val first = repository.store.pending(profile.profile).single()
        val requests = syncRequests.get()
        awaitWidgets(); scoped.clear()
        repository.save(Note(JSONObject(repository.store.record(profile.profile, "note", note.syncId)!!.payload)))
        settle()
        assertEquals(first.operationId, repository.store.pending(profile.profile).single().operationId)
        assertEquals(requests, syncRequests.get())
        assertTrue(scoped.isEmpty())
    }

    @Test fun reorderingToTheCurrentOrderAndTrashingTrashedNotesAreNoOps() = runBlocking {
        val a = seed(Note.create(profile.userId).also { it.raw.put("id", 1).put("revision", 1).put("sortOrder", 300.0) })
        val b = seed(Note.create(profile.userId).also { it.raw.put("id", 2).put("revision", 1).put("sortOrder", 200.0) })
        repository.reorder(listOf(a.syncId, b.syncId))
        assertTrue(repository.store.pending(profile.profile).isEmpty())
        assertEquals(300.0, repository.note(a.syncId)!!.raw.getDouble("sortOrder"), 0.0)

        repository.reorder(listOf(b.syncId, a.syncId))
        assertEquals(1, repository.store.pending(profile.profile).size)
        awaitWidgets()
        assertTrue(scoped.single().order)
        assertTrue("an order change refreshes collections only", scoped.single().notes.isEmpty())

        repository.setTrashed(listOf(a.syncId), true)
        val queued = repository.store.pending(profile.profile).size
        repository.setTrashed(listOf(a.syncId), true)
        assertEquals(queued, repository.store.pending(profile.profile).size)
    }

    @Test fun reminderChangesRefreshTheirNoteAndAlarmsAndRepeatsAreSkipped() = runBlocking {
        val note = seed()
        repository.setReminder(note, "2031-01-01T09:00:00.000Z", "UTC", null)
        awaitWidgets()
        withTimeoutOrNull(2000) { while (reminders.reconciles.get() == 0) delay(10) } ?: error("alarms were not reconciled")
        assertEquals(setOf(note.syncId), scoped.single().notes)
        val reminderId = repository.store.list(profile.profile, "reminder").single().syncId
        val queued = repository.store.pending(profile.profile).size

        repository.dismissReminder(reminderId)
        repository.dismissReminder(reminderId)
        assertEquals("a repeated dismissal queues nothing more", queued, repository.store.pending(profile.profile).size)

        repository.setChecklistCollapsed(note, true)
        val afterCollapse = repository.store.pending(profile.profile).size
        repository.setChecklistCollapsed(note, true)
        assertEquals(afterCollapse, repository.store.pending(profile.profile).size)
    }

    private fun changesPage(vararg notes: Note) = JSONObject().put("cursor", 13).put("hasMore", false).put("changes", JSONArray(notes.map {
        JSONObject().put("resourceType", "note").put("resourceSyncId", it.syncId).put("operation", "upsert").put("payload", it.raw)
    })).toString()

    private fun syncApi(page: () -> String) {
        api.handler = { path -> when {
            path.startsWith("/api/sync/changes?") -> page()
            path == "/api/native/reminders/occurrences" -> "[]"
            else -> error("Unexpected request $path")
        } }
    }

    @Test fun anIncrementalPageReconcilesOnlyTheChangedNoteAndSkipsAlarms() = runBlocking {
        val changed = seed(); val other = seed(Note.create(profile.userId).also { it.raw.put("id", 6).put("revision", 1) })
        repository.store.cursor(SyncState(profile.profile, 12))
        syncApi { changesPage(Note(changed.raw.copyJson().put("noteTitle", "From another device").put("revision", 2)), other) }

        repository.sync()

        assertEquals(1, scoped.size)
        assertEquals("the identical row is not a change", setOf(changed.syncId), scoped.single().notes)
        assertEquals(0, reminders.reconciles.get())
        assertEquals(0, fullRefreshes.get())
    }

    @Test fun anUnchangedSyncAndAnUnchangedSnapshotDoNothing() = runBlocking {
        val note = seed()
        repository.store.cursor(SyncState(profile.profile, 12))
        syncApi { changesPage(note) }
        repository.sync()
        assertTrue(scoped.isEmpty() && fullRefreshes.get() == 0 && reminders.reconciles.get() == 0)

        repository.store.clearCursor(profile.profile)
        api.handler = { path -> when (path) {
            "/api/sync/bootstrap" -> JSONObject().put("cursor", 20).put("notes", JSONArray().put(note.raw)).toString()
            "/api/native/reminders/occurrences" -> "[]"
            else -> error("Unexpected request $path")
        } }
        repository.sync()
        assertTrue("bootstrapping identical data is not a recovery need", scoped.isEmpty() && fullRefreshes.get() == 0 && reminders.reconciles.get() == 0)
    }

    @Test fun aRemoteArchiveOrRemovalAlsoReplansAlarms() = runBlocking {
        val note = seed()
        repository.store.cursor(SyncState(profile.profile, 12))
        syncApi { changesPage(Note(note.raw.copyJson().put("archived", true).put("revision", 2))) }
        repository.sync()
        assertEquals(1, reminders.reconciles.get())
        assertEquals(setOf(note.syncId), scoped.single().notes)
    }

    @Test fun reorderingWritesAndQueuesOnlyTheMovedNoteAndKeepsTheWholeOrderForOlderServers() = runBlocking {
        val notes = (1..200).map { Note.create(profile.userId).also { n -> n.raw.put("id", it).put("revision", 1).put("sortOrder", 1_700_000_000_000.0 - it * 1000) } }
        notes.forEach { seed(it) }
        val ids = notes.map { it.syncId }.toMutableList()
        ids.add(2, ids.removeAt(50)) // one note dragged 48 places up
        val before = notes.associate { it.syncId to repository.note(it.syncId)!!.raw.toString() }

        repository.reorder(ids)

        val changedNotes = notes.filter { repository.note(it.syncId)!!.raw.toString() != before.getValue(it.syncId) }
        assertEquals(listOf(notes[50].syncId), changedNotes.map { it.syncId })
        val payload = JSONObject(repository.store.pending(profile.profile).single().payload)
        assertEquals(ids, payload.getJSONArray("syncIds").let { a -> List(a.length()) { a.getString(it) } })
        val positions = payload.getJSONArray("positions")
        assertEquals(1, positions.length())
        assertEquals(notes[50].syncId, positions.getJSONObject(0).getString("syncId"))
        assertEquals(repository.note(notes[50].syncId)!!.raw.getDouble("sortOrder"), positions.getJSONObject(0).getDouble("sortOrder"), 0.0)
        val stored = repository.note(notes[50].syncId)!!.order
        assertTrue(stored < notes[1].order && stored > notes[2].order)
    }

    @Test fun queuedReordersMergeTheirPositionsLatestWinsAndAnUnchangedOrderQueuesNothing() = runBlocking {
        val notes = (1..4).map { Note.create(profile.userId).also { n -> n.raw.put("id", it).put("revision", 1).put("sortOrder", 400.0 - it * 100) } }
        notes.forEach { seed(it) }
        val (a, b, c, d) = notes.map { it.syncId }

        repository.reorder(listOf(a, b, c, d))
        assertTrue(repository.store.pending(profile.profile).isEmpty())

        repository.reorder(listOf(a, c, b, d))
        repository.reorder(listOf(c, a, b, d))

        val payload = JSONObject(repository.store.pending(profile.profile).single().payload)
        val positions = payload.getJSONArray("positions").let { p -> (0 until p.length()).associate { p.getJSONObject(it).getString("syncId") to p.getJSONObject(it).getDouble("sortOrder") } }
        assertEquals("c moved twice (once between a and b, then above a): one position, the latest", setOf(c), positions.keys)
        assertEquals(301.0, positions.getValue(c), 0.0)
        val orders = listOf(a, b, c, d).associateWith { repository.note(it)!!.order }
        val order = orders.keys.sortedByDescending { orders.getValue(it) }
        assertEquals(listOf(c, a, b, d), order)
        assertEquals("the queued positions are exactly what is stored locally", positions.getValue(c), repository.note(c)!!.order, 0.0)
    }
}
