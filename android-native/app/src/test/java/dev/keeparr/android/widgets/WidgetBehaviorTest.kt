package dev.keeparr.android.widgets

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Parcel
import android.widget.FrameLayout
import android.widget.RemoteViews
import android.widget.TextView
import androidx.room.Room
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.MainActivity
import dev.keeparr.android.R as AppR
import dev.keeparr.android.data.*
import dev.keeparr.android.reminders.ReminderController
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
        override var themeMode = ThemeMode.System
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

    private lateinit var app: KeeparrApplication
    private lateinit var profile: Profile
    private lateinit var repository: KeeparrRepository

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeeparrApplication
        app.scope.coroutineContext.cancel()
        app.database.close()
        app.scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        profile = Profile()
        app.settings = profile
        app.database = Room.inMemoryDatabaseBuilder(app, KeeparrDatabase::class.java).allowMainThreadQueries().build()
        app.reminders = NoReminders()
        app.refreshWidgets = {}
        app.refreshWidgetScope = { _, _ -> }
        app.refreshWidgetStatus = {}
        app.enqueueSync = {}
        app.scheduleSync = {}
        app.refreshNow = {}
        repository = KeeparrRepository(app, app.database, profile, Offline())
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
        val text = views.apply(app, FrameLayout(app)).findViewById<TextView>(dev.keeparr.android.R.id.row_title).text.toString()
        return notesByTitle[text]!!
    }
    private val notesByTitle get() = runBlocking { app.database.store().list(profile.profile, "note") }
        .associate { JSONObject(it.payload).getString("noteTitle") to it.syncId }

    @Test fun aNoteWithCollaboratorsShowsTheSharedIconLikeTheOverview() {
        val shared = note(2.0) { raw.put("collaborators", JSONArray().put(JSONObject().put("id", 5L))) }
        val unshared = note(1.0) { raw.put("collaborators", JSONArray()) }
        store(shared, unshared)
        configure(7, "home")
        val factory = factory(7)

        fun sharedIconVisibility(position: Int) = factory.getViewAt(position)!!.apply(app, FrameLayout(app))
            .findViewById<android.view.View>(dev.keeparr.android.R.id.row_shared).visibility
        assertEquals(shared.syncId, factory.getItemId(0).let { id -> listOf(shared, unshared).first { widgetRowId(it.syncId) == id }.syncId })
        assertEquals(android.view.View.VISIBLE, sharedIconVisibility(0))
        assertEquals(android.view.View.GONE, sharedIconVisibility(1))
    }

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

    private fun checklistNote(vararg items: Pair<String, Boolean>, configure: Note.() -> Unit = {}) = note(1.0) {
        raw.put("isCbox", true).put("checkBoxes", JSONArray(items.mapIndexed { index, (text, done) ->
            JSONObject().put("id", index + 1).put("data", text).put("done", done) })); configure(this)
    }

    private fun render(row: Row, single: Boolean = false) = buildRow(app, row, emptyMap(), single).apply(app, FrameLayout(app))
    private fun android.view.View.checkLines() = (findViewById<android.view.ViewGroup>(AppR.id.row_checks))

    @Test fun aChecklistCardDrawsIconRowsInsteadOfTextGlyphs() {
        val view = render(Row(checklistNote("Milk" to true, "Eggs" to false)))
        val lines = view.checkLines()
        assertEquals(android.view.View.VISIBLE, lines.visibility)
        assertEquals(listOf("Milk", "Eggs"), (0 until lines.childCount).map { lines.getChildAt(it).findViewById<TextView>(AppR.id.check_line_text).text.toString() })
        assertEquals(listOf("Complete", "Incomplete"), (0 until lines.childCount).map { lines.getChildAt(it).findViewById<android.view.View>(AppR.id.check_line_icon).contentDescription })
        assertEquals("the items are not repeated as body text", android.view.View.GONE, view.findViewById<android.view.View>(AppR.id.row_body).visibility)
        listOf(AppR.id.row_body, AppR.id.row_title).forEach { assertFalse(view.findViewById<TextView>(it).text.contains("☑") || view.findViewById<TextView>(it).text.contains("☐")) }
    }

    @Test fun aChecklistCardShowsAtMostAsManyRowsAsACardHasLines() {
        val view = render(Row(checklistNote(*(1..20).map { "item $it" to false }.toTypedArray())))
        assertEquals(WIDGET_CARD_MAX_LINES, view.checkLines().childCount)
    }

    @Test fun aRecycledRowViewDoesNotKeepThePreviousNotesChecklistRows() {
        val parent = FrameLayout(app)
        val view = buildRow(app, Row(checklistNote("Milk" to true, "Eggs" to false)), emptyMap(), false).apply(app, parent)
        assertEquals(2, view.checkLines().childCount)
        buildRow(app, Row(checklistNote("Bread" to false)), emptyMap(), false).reapply(app, view)
        assertEquals("rows are replaced, not accumulated", 1, view.checkLines().childCount)
        buildRow(app, Row(note(2.0)), emptyMap(), false).reapply(app, view)
        assertEquals(0, view.checkLines().childCount)
        assertEquals(android.view.View.GONE, view.checkLines().visibility)
    }

    @Test fun aSingleNoteChecklistItemRowShowsTheItemTextWithoutAGlyphAndDescribesTheWholeRow() {
        val checklist = checklistNote("Milk" to true, "Eggs" to false)
        val view = render(Row(checklist, checklist.items[0], 0), single = true)
        assertEquals("Milk", view.findViewById<TextView>(AppR.id.checklist_item_row).text.toString())
        val content = view.findViewById<android.view.View>(AppR.id.checklist_item_content)
        assertEquals("Complete: Milk. Toggle checklist item", content.contentDescription)
        assertFalse("the state is an icon now, not a text prefix", view.findViewById<TextView>(AppR.id.checklist_item_row).text.contains("☑"))
        assertTrue("the description and tap target are the row, which contains the icon", (content as android.view.ViewGroup).findViewById<android.view.View>(AppR.id.checklist_item_check) != null)
    }

    private fun title(view: android.view.View) = view.findViewById<TextView>(AppR.id.row_title).currentTextColor
    private fun colored(hex: String) = note(1.0) { raw.put("bgColor", hex) }

    @Test fun aNoteWithoutAColorFollowsTheWidgetColorsAndAColoredNoteKeepsItsOwn() {
        assertEquals(app.getColor(AppR.color.widget_text), title(render(Row(note(1.0)))))
        assertEquals(0xFF202124.toInt(), app.getColor(AppR.color.widget_text))
        assertEquals(NotePalette.textColor(0xFF5B0000.toInt()), title(render(Row(colored("#5B0000")))))
        assertEquals(0xFF202124.toInt(), title(render(Row(colored("#FFF8B8")))))
    }

    @Test fun aRowCarriesTheLightAndTheDarkVariantAndLetsTheHostPick() {
        val cream = WidgetColors(app).card("#FFF8B8")
        assertEquals(WidgetColor(0xFFFFF8B8.toInt(), 0xFF7C4A03.toInt()), cream)
        assertEquals(WidgetColor(0xFF202124.toInt(), 0xFFE8EAED.toInt()), WidgetColors(app).text("#FFF8B8").let {
            // Text on the light variant is dark, on the dark variant light.
            WidgetColor(it.light, it.dark)
        })
        val noColor = WidgetColors(app)
        assertEquals(WidgetColor(0xFFFFFFFF.toInt(), 0xFF303134.toInt()), noColor.card(""))
        assertEquals(WidgetColor(0xFF202124.toInt(), 0xFFE8EAED.toInt()), noColor.text(""))
    }

    @org.robolectric.annotation.Config(qualifiers = "night")
    @Test fun underSystemModeANightHostGetsTheDarkVariantOfAColoredNote() {
        profile.themeMode = ThemeMode.System
        assertEquals(0xFFE8EAED.toInt(), title(render(Row(colored("#FFF8B8")))))
        assertEquals(0xFFE8EAED.toInt(), title(render(Row(note(1.0)))))
        assertEquals(0xFF303134.toInt(), app.getColor(AppR.color.widget_note_card))
    }

    @Test fun underSystemModeADayHostGetsTheLightVariantOfAColoredNote() {
        profile.themeMode = ThemeMode.System
        assertEquals(0xFF202124.toInt(), title(render(Row(colored("#FFF8B8")))))
    }

    @org.robolectric.annotation.Config(qualifiers = "night")
    @Test fun aForcedLightModeIgnoresASystemNightHost() {
        profile.themeMode = ThemeMode.Light
        assertEquals(0xFF202124.toInt(), title(render(Row(colored("#FFF8B8")))))
        assertEquals("the default card too", 0xFF202124.toInt(), title(render(Row(note(1.0)))))
    }

    @Test fun aForcedDarkModeIgnoresASystemDayHost() {
        profile.themeMode = ThemeMode.Dark
        assertEquals(0xFFE8EAED.toInt(), title(render(Row(colored("#FFF8B8")))))
        assertEquals("the default card too", 0xFFE8EAED.toInt(), title(render(Row(note(1.0)))))
        val checklist = checklistNote("Milk" to false)
        assertEquals(0xFFE8EAED.toInt(), render(Row(checklist, checklist.items[0], 0), single = true)
            .findViewById<TextView>(AppR.id.checklist_item_row).currentTextColor)
    }

    @Test fun aForcedModeAlsoColorsTheFrame() {
        fun status(mode: ThemeMode): Int {
            val views = RemoteViews(app.packageName, AppR.layout.notes_widget).also { applyFrameColors(app, it, mode) }
            return views.apply(app, FrameLayout(app)).findViewById<TextView>(AppR.id.widget_status).currentTextColor
        }
        assertEquals(0xFFBDC1C6.toInt(), status(ThemeMode.Dark))
        assertEquals(0xFF6C6250.toInt(), status(ThemeMode.Light))
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

    private fun statusView(pill: Pill?) = RemoteViews(app.packageName, AppR.layout.notes_widget)
        .also { NotesWidget.applyPill(app, it, pill) }.apply(app, FrameLayout(app)).findViewById<TextView>(AppR.id.widget_status)

    @Test fun theStatusPillShowsItsShortTextAndDescribesTheFullSentence() {
        val pill = Pill("Offline · 06:12", "Keeparr could not sync since 06:12. Tap to try again.", PillAction.REFRESH)

        val shown = statusView(pill)
        assertEquals(android.view.View.VISIBLE, shown.visibility)
        assertEquals("Offline · 06:12", shown.text.toString())
        assertEquals(pill.description, shown.contentDescription.toString())
        assertEquals("no problem, no pill", android.view.View.GONE, statusView(null).visibility)
    }

    @Test fun theRefreshPillBroadcastsToTheWidgetAndTheOtherPillOpensTheApp() {
        val refresh = shadowOf(NotesWidget.pillClick(app, PillAction.REFRESH))
        assertTrue(refresh.isBroadcastIntent)
        assertEquals(NotesWidget.REFRESH, refresh.savedIntent.action)
        assertEquals(NotesWidget::class.java.name, refresh.savedIntent.component!!.className)

        val open = shadowOf(NotesWidget.pillClick(app, PillAction.OPEN_APP))
        assertTrue(open.isActivityIntent)
        assertEquals(MainActivity::class.java.name, open.savedIntent.component!!.className)
        assertFalse("tapping the pill is not creating a note", open.savedIntent.getBooleanExtra("createNote", false))
    }

    @Test fun theRefreshBroadcastStartsAnImmediateSyncForASignedInUser() {
        val ran = java.util.concurrent.CountDownLatch(1)
        app.refreshNow = { ran.countDown() }

        NotesWidget().onReceive(app, Intent(app, NotesWidget::class.java).setAction(NotesWidget.REFRESH))

        assertTrue(ran.await(5, java.util.concurrent.TimeUnit.SECONDS))
    }

    @Test fun addingOrUpdatingAWidgetSyncsSoItCatchesUpAfterABootOrAnUpdate() {
        val queued = java.util.concurrent.CountDownLatch(1)
        val scheduled = java.util.concurrent.CountDownLatch(1)
        app.enqueueSync = { queued.countDown() }
        app.scheduleSync = { scheduled.countDown() }
        val widget = NotesWidget()

        widget.onEnabled(app)
        widget.onUpdate(app, android.appwidget.AppWidgetManager.getInstance(app), IntArray(0))

        assertTrue(scheduled.await(5, java.util.concurrent.TimeUnit.SECONDS))
        assertTrue(queued.await(5, java.util.concurrent.TimeUnit.SECONDS))
    }
}
