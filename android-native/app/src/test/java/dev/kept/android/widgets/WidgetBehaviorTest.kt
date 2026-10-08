package dev.kept.android.widgets

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Parcel
import android.widget.FrameLayout
import android.widget.RemoteViews
import android.widget.TextView
import androidx.room.Room
import dev.kept.android.KeptApplication
import dev.kept.android.MainActivity
import dev.kept.android.data.*
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
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf

@RunWith(RobolectricTestRunner::class)
class WidgetBehaviorTest {
    private class Profile(override var userId: Long = 11L) : ConnectionProfile {
        override var origin = "https://one.example.test"
        override var alias = ""
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

    private class Offline : NativeApi {
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

    private lateinit var app: KeptApplication
    private lateinit var profile: Profile
    private lateinit var repository: KeptRepository

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeptApplication
        app.scope.coroutineContext.cancel()
        app.database.close()
        app.scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        profile = Profile()
        app.settings = profile
        app.database = Room.inMemoryDatabaseBuilder(app, KeptDatabase::class.java).allowMainThreadQueries().build()
        app.reminders = NoReminders()
        app.refreshWidgets = {}
        app.refreshWidgetScope = { _, _ -> }
        app.enqueueSync = {}
        repository = KeptRepository(app, app.database, profile, Offline())
        app.repository = repository
        app.getSharedPreferences("widgets", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @After fun tearDown() {
        app.database.close()
        app.scope.coroutineContext.cancel()
    }

    private fun configure(widgetId: Int, filter: String, profileKey: String = profile.profile) {
        app.getSharedPreferences("widgets", Context.MODE_PRIVATE).edit().putString("filter_$widgetId", filter)
            .putString("profile_$widgetId", profileKey).commit()
    }

    private fun note(order: Double, id: Long = order.toLong(), configure: Note.() -> Unit = {}) =
        Note.create(profile.userId).also { it.raw.put("id", id).put("revision", 1).put("sortOrder", order).put("noteTitle", "n$order"); configure(it) }

    private fun store(vararg notes: Note, profileKey: String = profile.profile) = runBlocking {
        notes.forEach { app.database.store().put(Record(profileKey, "note", it.syncId, it.raw.toString())) }
    }

    private fun factory(widgetId: Int) = NotesWidgetFactory(app, widgetId).also { it.onDataSetChanged() }

    private fun RemoteViews.bytes(): Int {
        val parcel = Parcel.obtain()
        writeToParcel(parcel, 0)
        return parcel.dataSize().also { parcel.recycle() }
    }

    @Test fun aLargeCollectionIsServedCompleteInAppOrderOneBoundedRowAtATime() {
        val notes = (1..3000).map { note(it.toDouble()) }
        store(*notes.toTypedArray())
        configure(7, "home")
        val factory = factory(7)

        assertEquals("a large collection is not cut down to a few recent notes", 3000, factory.count)
        val expected = notes.sortedByDescending { it.order }
        assertEquals(expected.first().syncId, factory.loadedNoteAt(0))
        assertEquals(expected.last().syncId, factory.loadedNoteAt(2999))
        assertEquals("every row has its own id", 3000, (0 until 3000).map { factory.getItemId(it) }.toSet().size)
        assertTrue(factory.hasStableIds())
    }

    private fun NotesWidgetFactory.loadedNoteAt(position: Int): String {
        val views = getViewAt(position)!!
        val text = views.apply(app, FrameLayout(app)).findViewById<TextView>(dev.kept.android.R.id.row_title).text.toString()
        return notesByTitle[text]!!
    }
    private val notesByTitle get() = runBlocking { app.database.store().list(profile.profile, "note") }
        .associate { JSONObject(it.payload).getString("noteTitle") to it.syncId }

    @Test fun eachRowParcelStaysSmallEvenForHugeNotes() {
        val huge = note(1.0) { raw.put("noteBody", "<p>" + "x".repeat(1_000_000) + "</p>").put("noteTitle", "t".repeat(100_000)) }
        val checklist = note(2.0) { raw.put("isCbox", true).put("checkBoxes", JSONArray((1..300).map {
            JSONObject().put("id", it).put("data", "item ".repeat(1000)).put("done", false) })) }
        store(huge, checklist)
        configure(7, "home"); configure(8, "note:${checklist.syncId}")

        val home = factory(7)
        (0 until home.count).forEach { assertTrue("row $it is ${home.getViewAt(it)!!.bytes()} bytes", home.getViewAt(it)!!.bytes() < 16 * 1024) }
        val single = factory(8)
        assertEquals("the header plus every checklist item", 301, single.count)
        listOf(0, 1, 150, 300).forEach { assertTrue(single.getViewAt(it)!!.bytes() < 16 * 1024) }
    }

    @Test fun rowIdentityIgnoresTheNumericIdAndSeparatesNotesFromItems() {
        val temporary = note(5.0, id = -1_700_000_000_000L)
        store(temporary)
        configure(7, "home")
        val before = factory(7).getItemId(0)
        store(Note(temporary.raw.copyJson().put("id", 912).put("revision", 2)))
        val after = factory(7).getItemId(0)
        assertEquals("server acceptance must not change the row identity", before, after)

        val same = (1..2).map { note(it.toDouble(), id = -1L) } // equal temporary ids from the same millisecond
        store(*same.toTypedArray())
        val ids = (0 until factory(7).count).map { factory(7).getItemId(it) }
        assertEquals(ids.size, ids.toSet().size)
        assertNotEquals(widgetRowId("a"), widgetRowId("a", "1"))
        assertNotEquals(widgetRowId("a", "1"), widgetRowId("a1"))
    }

    @Test fun singleNoteRowsKeepUniqueIdsForDuplicateOrMissingItemIds() {
        val checklist = note(1.0) { raw.put("isCbox", true).put("checkBoxes", JSONArray()
            .put(JSONObject().put("id", 4).put("data", "a")).put(JSONObject().put("id", 4).put("data", "b"))
            .put(JSONObject().put("data", "c")).put(JSONObject().put("data", "d"))) }
        store(checklist)
        configure(7, "note:${checklist.syncId}")
        val factory = factory(7)
        val ids = (0 until factory.count).map { factory.getItemId(it) }
        assertEquals(5, ids.size)
        assertEquals(5, ids.toSet().size)
    }

    @Test fun widgetsOnlyShowTheActiveProfilesVisibleNotesAndFollowOrderAndFilters() {
        val visible = note(2.0) { raw.put("labels", JSONArray().put(JSONObject().put("name", "work").put("added", true))) }
        val other = note(3.0)
        val archived = note(4.0) { raw.put("archived", true).put("labels", JSONArray().put("work")) }
        val trashed = note(5.0) { raw.put("trashed", true) }
        store(visible, other, archived, trashed)
        store(note(9.0), profileKey = "https://two.example.test#11")
        configure(1, "home"); configure(2, "label:work"); configure(3, "home", profileKey = "https://two.example.test#11"); configure(4, "pinned")

        assertEquals(2, factory(1).count)
        assertEquals("the first row is the newest by manual order", other.syncId, factory(1).loadedNoteAt(0))
        assertEquals(1, factory(2).count)
        assertEquals("a widget made under another profile shows nothing for this one", 0, factory(3).count)
        assertEquals(0, factory(4).count)

        profile.token = ""
        assertEquals("signed out", 0, factory(1).count)
    }

    @Test fun tapsToggleOnlyIdentifiableItemsOfUnlockedNotes() {
        val checklist = note(1.0) { raw.put("isCbox", true).put("checkBoxes", JSONArray()
            .put(JSONObject().put("id", 4).put("data", "a")).put(JSONObject().put("data", "no id"))) }
        val locked = Note(checklist.raw.copyJson().put("locked", true))
        val rows = listOf(Row(checklist), Row(checklist, checklist.items[0], 0), Row(checklist, checklist.items[1], 1), Row(locked, locked.items[0], 0))
        val intents = rows.map(::widgetFillIn)
        assertTrue(intents.all { it.getStringExtra("noteSyncId") == checklist.syncId })
        assertFalse(intents[0].hasExtra("itemId"))
        assertEquals(4L, intents[1].getLongExtra("itemId", -1))
        assertFalse("no id: open the note instead", intents[2].hasExtra("itemId"))
        assertFalse("locked content is never toggled", intents[3].hasExtra("itemId"))
    }

    @Test fun aWidgetToggleIsAnOrdinaryLocalEditWithOutboxAndNoAppUi() = runBlocking {
        val checklist = note(1.0) { raw.put("isCbox", true).put("checkBoxes", JSONArray()
            .put(JSONObject().put("id", 4).put("data", "a").put("done", false))) }
        store(checklist)

        val activity = Robolectric.buildActivity(WidgetActionActivity::class.java, Intent().putExtra("noteSyncId", checklist.syncId)
            .putExtra("itemId", 4L).putExtra("widgetToggle", true)).create().get()
        withTimeout(5000) { while (app.database.store().pending(profile.profile).isEmpty()) delay(10) }

        assertTrue(activity.isFinishing)
        assertNull("no app UI was started", shadowOf(activity).nextStartedActivity)
        assertTrue(repository.note(checklist.syncId)!!.items.single().optBoolean("done"))
        val queued = app.database.store().pending(profile.profile).single()
        assertEquals("note.upsert", queued.type)
        assertTrue(JSONObject(queued.payload).getJSONArray("checkBoxes").getJSONObject(0).getBoolean("done"))
    }

    @Test fun tappingARowOpensThatNoteInTheApp() {
        val target = note(1.0)
        store(target)
        val activity = Robolectric.buildActivity(WidgetActionActivity::class.java, Intent().putExtra("noteSyncId", target.syncId)).create().get()
        val started = shadowOf(activity).nextStartedActivity
        assertEquals(MainActivity::class.java.name, started.component!!.className)
        assertEquals(target.syncId, started.getStringExtra("noteSyncId"))
        assertTrue(activity.isFinishing)
    }

    @Test fun aStaleToggleCannotOverwriteALaterEditOfTheSameNote() = runBlocking {
        val checklist = note(1.0) { raw.put("isCbox", true).put("noteTitle", "old").put("checkBoxes", JSONArray()
            .put(JSONObject().put("id", 4).put("data", "a").put("done", false))) }
        store(checklist)
        repository.save(Note(checklist.raw.copyJson().put("noteTitle", "edited in the editor")))
        repository.toggleChecklist(checklist.syncId, 4)
        val saved = repository.note(checklist.syncId)!!
        assertEquals("edited in the editor", saved.title)
        assertTrue(saved.items.single().optBoolean("done"))
        repository.toggleChecklist(checklist.syncId, 999) // unknown item: nothing is written
        assertEquals(saved.raw.toString(), repository.note(checklist.syncId)!!.raw.toString())
    }

    @Test fun createIntentsAreDistinctPerWidgetAndKindSoTheirExtrasCannotBeOverwritten() {
        val ids = listOf(5, 10002, 20005)
        val intents = ids.flatMap { id -> listOf(false, true).map { quickCreateIntent(app, id, it) } }
        for (a in intents.indices) for (b in intents.indices) if (a != b)
            assertFalse("$a vs $b", intents[a].filterEquals(intents[b]))
        assertTrue(quickCreateIntent(app, 5, true).getBooleanExtra("createChecklist", false))
        assertFalse(quickCreateIntent(app, 5, true).getBooleanExtra("createNote", true))
    }
}
