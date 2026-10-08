package dev.keeparr.android.data

import android.content.Context
import dev.keeparr.android.R
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject
import android.text.Html
import android.widget.EditText
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import dev.keeparr.android.widgets.singleNoteWidgetChecklistItems
import dev.keeparr.android.widgets.boundedWidgetText
import dev.keeparr.android.widgets.widgetForegroundColor
import dev.keeparr.android.widgets.widgetNoteBodyText
import dev.keeparr.android.BuildConfig
import dev.keeparr.android.ui.canReorderNotes
import dev.keeparr.android.ui.moveDraggedNote
import dev.keeparr.android.ui.searchVisibleNotes
import dev.keeparr.android.ui.buildHomeProjection
import androidx.datastore.preferences.SharedPreferencesMigration
import androidx.datastore.preferences.preferencesDataStore
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import android.util.Base64
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf

private val Context.legacyMigrationStore by preferencesDataStore(name = "connection-migration-test",
    produceMigrations = { context -> listOf(SharedPreferencesMigration(context, "connection-migration-test")) })

private class FailingSettingsDataStore : DataStore<Preferences> {
    override val data: Flow<Preferences> = flowOf(emptyPreferences())
    override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences): Preferences {
        throw IllegalStateException("Simulated settings storage failure")
    }
}

@RunWith(RobolectricTestRunner::class)
class NativeContractTest {
    private val fixtures by lazy {
        val path = requireNotNull(System.getProperty("keeparr.native.fixture"))
        JSONObject(java.io.File(path).readText())
    }
    private fun note(id: Long, order: Double, pinned: Boolean = false, binder: String = "") = Note(JSONObject()
        .put("id", id).put("syncId", "note-$id").put("sortOrder", order).put("pinned", pinned).put("binder", binder))
    @Test fun manualOrderIsSharedByWidgetsAndHome() {
        val notes = listOf(note(1, 80.0), note(2, 50.0, true), note(3, 100.0), note(4, 50.0, true), note(5, 1000.0, binder = "Work"))
        assertEquals(listOf(4L, 2L, 3L, 1L), NoteOrder.visible(notes).map { it.id })
        assertEquals(listOf(4L, 2L), NoteOrder.visible(notes, "pinned").map { it.id })
        assertEquals(listOf(5L), NoteOrder.visible(notes, "binder:Work").map { it.id })
    }
    @Test fun archivedAndTrashedNotesDoNotLeakIntoWidgetFilters() {
        val notes = listOf(note(1, 1.0, true), note(2, 2.0, true), note(3, 3.0, true))
        notes[1].raw.put("archived", true); notes[2].raw.put("trashed", true)
        assertEquals(listOf(1L), NoteOrder.visible(notes, "pinned").map { it.id })
    }
    @Test fun homeProjectionMovesCardParsingIntoTypedImmutableDisplayValues() {
        val note = Note(JSONObject().put("id", 4).put("syncId", "projected-note").put("noteTitle", "<b>Card title</b>")
            .put("noteBody", "<p>Card body</p>").put("bgColor", "#fce8e6").put("labels", JSONArray()
                .put(JSONObject().put("name", "Ideas").put("added", true))).put("collaborators", JSONArray().put(JSONObject())))

        val projection = buildHomeProjection(listOf(note), "home", "", emptyList())
        val card = projection.cards.single()

        assertEquals("Card title", card.title)
        assertEquals("Card body", card.bodyText)
        assertEquals(listOf("Ideas"), card.labels)
        assertTrue(card.shared)
        assertEquals(note, projection.notesBySyncId[note.syncId])
    }
    @Test fun unchangedBodyAndUnknownFieldsSurviveTitleEdits() {
        val content = fixtures.getJSONObject("content")
        val original = JSONObject().put("noteBody", content.getJSONArray("unsupportedHtml").getString(0))
            .put("futureField", content.getJSONObject("unknownNoteField"))
            .put("images", JSONArray().put(JSONObject().put("id", "drawing").put("dataUrl", content.getString("drawingDataUrl"))))
            .put("attachments", JSONArray().put(content.getJSONObject("attachmentMetadata")))
            .put("lockedNoteMetadata", content.getJSONObject("lockedNoteMetadata"))
            .put("checkBoxes", JSONArray().put(JSONObject().put("done", false).put("data", content.getJSONObject("structuredChecklistItem")))
                .put(content.getJSONObject("nestedChecklistItem")))
        val edit = original.copyJson().put("noteTitle", "New title")
        assertEquals(original.getString("noteBody"), edit.getString("noteBody"))
        assertEquals(content.getJSONObject("unknownNoteField").toString(), edit.getJSONObject("futureField").toString())
        assertEquals(content.getString("drawingDataUrl"), edit.getJSONArray("images").getJSONObject(0).getString("dataUrl"))
        assertEquals(content.getJSONObject("structuredChecklistItem").toString(), edit.getJSONArray("checkBoxes").getJSONObject(0).getJSONObject("data").toString())
        assertEquals(content.getJSONObject("nestedChecklistItem").toString(), edit.getJSONArray("checkBoxes").getJSONObject(1).toString())
        assertEquals(content.getJSONObject("attachmentMetadata").toString(), edit.getJSONArray("attachments").getJSONObject(0).toString())
        assertEquals(content.getJSONObject("lockedNoteMetadata").toString(), edit.getJSONObject("lockedNoteMetadata").toString())
        assertFalse(NoteFormat.editable(edit.getString("noteBody")))
        assertFalse(NoteFormat.editable("<img src=\"drawing.png\">"))
    }
    @Test fun occurrenceIdentityMatchesServerIsoMilliseconds() {
        assertEquals("r@2030-01-01T09:00:00.000Z#v3", Recurrence.occurrenceId("r", "2030-01-01T09:00:00Z", 3))
    }
    @Test fun occurrenceValidationUsesTheImmutableScheduleAnchorAfterCursorMoves() {
        assertTrue(Recurrence.isOccurrence("2030-01-01T09:00:00Z", "2030-01-04T09:00:00Z", "UTC", "{\"type\":\"daily\"}"))
        assertFalse(Recurrence.isOccurrence("2030-01-01T09:00:00Z", "2030-01-04T10:00:00Z", "UTC", "{\"type\":\"daily\"}"))
    }
    @Test fun nextReminderStatusIncludesSnoozeAndSkipsHandledOccurrence() {
        val due = "2030-01-01T09:00:00.000Z"
        val reminder = JSONObject().put("syncId", "status-repeat").put("dueAtUtc", due).put("scheduleAnchorAtUtc", due)
            .put("timezone", "UTC").put("repeatRule", "{\"type\":\"daily\"}").put("scheduleVersion", 3).put("status", "pending")
        val occurrence = reminder.copyJson().put("occurrenceId", Recurrence.occurrenceId("status-repeat", due, 3))
            .put("state", "snoozed").put("snoozeUntil", "2030-01-01T09:10:00Z")
        assertEquals(java.time.Instant.parse("2030-01-01T09:10:00Z"), ReminderPlanner.nextDelivery(
            listOf(reminder), listOf(occurrence), java.time.Instant.parse("2030-01-01T09:05:00Z")))
        assertEquals(java.time.Instant.parse("2030-01-02T09:00:00Z"), ReminderPlanner.nextDelivery(
            listOf(reminder), listOf(occurrence), java.time.Instant.parse("2030-01-01T09:20:00Z")))
    }
    @Test fun singleNoteWidgetExposesEveryChecklistItemAndHidesLockedContent() {
        val items = JSONArray()
        repeat(24) { index -> items.put(JSONObject().put("id", index + 1).put("data", "Item ${index + 1}").put("done", false)) }
        val note = Note(JSONObject().put("syncId", "widget-checklist").put("isCbox", true).put("checkBoxes", items))
        val rows = singleNoteWidgetChecklistItems(note)
        assertEquals(24, rows.size)
        assertEquals(24, rows.last().getInt("id"))
        assertTrue(singleNoteWidgetChecklistItems(Note(note.raw.copyJson().put("locked", true))).isEmpty())
    }
    @Test fun manualReorderIsDisabledForSearchAndFilteredViewsAndKeepsPinGroups() {
        assertTrue(canReorderNotes("home", ""))
        assertTrue(canReorderNotes("pinned", ""))
        assertFalse(canReorderNotes("label:Work", ""))
        assertFalse(canReorderNotes("home", "find me"))
        val pinnedFirst = Note(JSONObject().put("id", 1).put("syncId", "p1").put("pinned", true))
        val pinnedSecond = Note(JSONObject().put("id", 2).put("syncId", "p2").put("pinned", true))
        val other = Note(JSONObject().put("id", 3).put("syncId", "other").put("pinned", false))
        assertEquals(listOf("p2", "p1", "other"), moveDraggedNote(listOf(pinnedFirst, pinnedSecond, other), pinnedSecond, "p1"))
        assertEquals(null, moveDraggedNote(listOf(pinnedFirst, pinnedSecond, other), pinnedSecond, "other"))
    }
    @Test fun nativeSearchFiltersVisibleNotesWithoutMatchingLockedContent() {
        val notes = listOf(
            note(1, 3.0).copy(raw = note(1, 3.0).raw.put("noteTitle", "Milk list").put("noteBody", "Eggs")),
            note(2, 2.0).copy(raw = note(2, 2.0).raw.put("noteTitle", "Private milk").put("locked", true)),
            note(3, 1.0).copy(raw = note(3, 1.0).raw.put("noteTitle", "Archived milk").put("archived", true))
        )
        assertEquals(listOf(1L), searchVisibleNotes(notes, "home", "milk").map { it.id })
        assertEquals(listOf(3L), searchVisibleNotes(notes, "archive", "milk").map { it.id })
        assertEquals(listOf(1L, 2L), searchVisibleNotes(notes, "home", "").map { it.id })
    }
    @Test fun widgetTextIsBoundedBeforeRemoteViewsSerialization() {
        assertEquals(128, boundedWidgetText("x".repeat(10_000), 128).length)
    }
    @Test fun previewDecoderSamplesLargeBitmapsToTheRequestedBounds() {
        assertEquals(4, imageSampleSize(4000, 2000, 1000))
        assertEquals(2, imageSampleSize(1800, 900, 1000))
        assertEquals(1, imageSampleSize(600, 900, 1000))
        assertEquals(1, imageSampleSize(0, 900, 1000))
    }
    private fun measuredWidgetRow(body: String, title: String = ""): android.view.View {
        val context = RuntimeEnvironment.getApplication()
        val views = android.widget.RemoteViews(context.packageName, dev.keeparr.android.R.layout.widget_row)
        views.setTextViewText(dev.keeparr.android.R.id.row_title, title)
        views.setViewVisibility(dev.keeparr.android.R.id.row_title, if (title.isBlank()) android.view.View.GONE else android.view.View.VISIBLE)
        views.setTextViewText(dev.keeparr.android.R.id.row_body, body)
        views.setInt(dev.keeparr.android.R.id.row_body, "setMaxLines", dev.keeparr.android.widgets.WIDGET_CARD_MAX_LINES)
        val row = views.apply(context, android.widget.FrameLayout(context))
        val width = (320 * context.resources.displayMetrics.density).toInt()
        row.measure(android.view.View.MeasureSpec.makeMeasureSpec(width, android.view.View.MeasureSpec.EXACTLY),
            android.view.View.MeasureSpec.makeMeasureSpec(0, android.view.View.MeasureSpec.UNSPECIFIED))
        row.layout(0, 0, width, row.measuredHeight)
        return row
    }
    @Test fun widgetCardsGrowWithTheirTextAndStopAtTheLineLimit() {
        val one = measuredWidgetRow("One line").height
        val four = measuredWidgetRow("1\n2\n3\n4").height
        val six = measuredWidgetRow("1\n2\n3\n4\n5\n6").height
        val twenty = measuredWidgetRow((1..20).joinToString("\n")).height
        assertTrue("a short note gets a smaller card than a four-line note", one < four)
        assertTrue(four < six)
        assertEquals("longer notes are capped at the line limit", six, twenty)
    }
    @Test fun widgetCardsLeaveNoBlankSpaceBelowTheirLastLine() {
        for (body in listOf("One line", "1\n2\n3", (1..20).joinToString("\n"))) {
            val row = measuredWidgetRow(body, title = "Title")
            val content = (row as android.view.ViewGroup).getChildAt(1) as android.view.ViewGroup
            val lastText = row.findViewById<android.view.View>(dev.keeparr.android.R.id.row_body)
            assertEquals(lastText.bottom + content.paddingBottom, row.height)
        }
    }
    @Test fun widgetBodyTextHasNoBlankLinesOrEdgeWhitespace() {
        val note = Note(JSONObject().put("noteBody", "<p dir=\"ltr\">Milk</p>\n<p dir=\"ltr\">Eggs</p>\n"))
        assertEquals("Milk\nEggs", widgetNoteBodyText(note, single = false))
        val checklist = Note(JSONObject().put("isCbox", true).put("checkBoxes", JSONArray()
            .put(JSONObject().put("id", 1).put("done", true).put("data", "<p>Milk</p>"))
            .put(JSONObject().put("id", 2).put("done", false).put("data", "Eggs"))))
        assertEquals("☑ Milk\n☐ Eggs", widgetNoteBodyText(checklist, single = false))
    }
    @Test fun showCheckboxesSplitsAndroidAndWebBodiesIntoUncheckedItems() {
        val android = JSONObject().put("noteBody", "<p dir=\"ltr\">Milk &amp; eggs</p>\n<p dir=\"ltr\">Bread</p>\n")
        val androidItems = NoteFormat.showCheckboxes(android, 100)
        assertEquals(listOf("Milk &amp; eggs", "Bread"), androidItems.map { it.getString("data") })
        assertEquals(listOf(100L, 101L), androidItems.map { it.getLong("id") })
        assertTrue(android.getBoolean("isCbox")); assertEquals("", android.getString("noteBody"))
        assertTrue(androidItems.none { it.getBoolean("done") })

        val web = JSONObject().put("noteBody", "First<br><br>Second<div>Third<br>Fourth</div>&nbsp;<div><br></div>")
        assertEquals(listOf("First", "Second", "Third", "Fourth"), NoteFormat.showCheckboxes(web, 1).map { Html.fromHtml(it.getString("data"), 0).toString() })
        assertEquals(emptyList<JSONObject>(), NoteFormat.showCheckboxes(JSONObject().put("noteBody", "<p><br></p>"), 1))
    }
    @Test fun showCheckboxesKeepsExistingItemsAndNeverReusesTheirIds() {
        val raw = JSONObject().put("noteBody", "New line").put("checkBoxes", JSONArray()
            .put(JSONObject().put("id", 5).put("done", true).put("data", "Old")))
        NoteFormat.showCheckboxes(raw, 2)
        val items = raw.getJSONArray("checkBoxes").objects()
        assertEquals(listOf(5L, 6L), items.map { it.getLong("id") })
        assertTrue(items[0].getBoolean("done"))
    }
    @Test fun hideCheckboxesDropsCheckedItemsAndAppendsTheRestToTheBody() {
        val raw = JSONObject().put("isCbox", true).put("noteBody", "<div>Intro</div>").put("checkBoxes", JSONArray()
            .put(JSONObject().put("id", 1).put("done", true).put("data", "Done thing"))
            .put(JSONObject().put("id", 2).put("done", false).put("data", "Milk &amp; eggs").put("indentLevel", 2))
            .put(JSONObject().put("id", 3).put("done", false).put("data", "<p> </p>"))
            .put(JSONObject().put("id", 4).put("done", false).put("data", "Bread")))
        assertEquals(1, NoteFormat.checkedItemCount(raw.getJSONArray("checkBoxes").objects()))
        NoteFormat.hideCheckboxes(raw)
        assertEquals("<div>Intro</div><div>Milk &amp; eggs</div><div>Bread</div>", raw.getString("noteBody"))
        assertFalse(raw.getBoolean("isCbox")); assertEquals(0, raw.getJSONArray("checkBoxes").length())
        assertTrue("converted bodies stay editable in the native editor", NoteFormat.editable(raw.getString("noteBody")))
    }
    @Test fun hideCheckboxesIsOfferedOnlyWhenNoUncheckedItemWouldLoseContent() {
        val structured = JSONObject().put("id", 1).put("done", false).put("data", JSONObject().put("kind", "rich"))
        assertFalse(NoteFormat.canHideCheckboxes(listOf(structured)))
        assertTrue(NoteFormat.canHideCheckboxes(listOf(structured.copyJson().put("done", true))))
        assertTrue(NoteFormat.canHideCheckboxes(listOf(JSONObject().put("done", false).put("data", "Plain"))))
    }
    @Test fun noteWidgetChoosesReadableForegroundForDarkAndLightColors() {
        val darkRed = android.graphics.Color.parseColor("#5B0000")
        val lightYellow = android.graphics.Color.parseColor("#FFF8B8")
        assertTrue(android.graphics.Color.luminance(widgetForegroundColor(darkRed)) > .8f)
        assertTrue(android.graphics.Color.luminance(widgetForegroundColor(lightYellow)) < .2f)
    }
    @Test fun nativeNotePaletteMatchesTheKeeparrWebPalette() {
        assertEquals(listOf(
            "", "#cbf0f8", "#fddcbb", "#fdcfe8", "#fff8b8", "#d7aefb", "#fef7cc", "#e8d7ff",
            "#ccff90", "#ffd8b5", "#f8c7c0", "#e6f4d7", "#d2e3fc", "#ffb74d", "#abc4ff", "#ffc2d1",
            "#ffab91", "#a7ffeb", "#e6ee9c", "#efe0c8", "#c5cae9",
            "#5b2121", "#5b3a21", "#4a4a1a", "#1a4a1a", "#1a4a4a", "#1a2e4a", "#0f172a", "#2e1a4a",
            "#4a1a2e", "#3a211a", "#334155", "#282a5c", "#5c1a4a", "#5c4a14", "#144a5c"
        ), NotePalette.colors.map { it.hex })
    }
    @Test fun reminderDateTimeUsesTheRequestedLocalZoneAndShortFormat() {
        assertEquals("Jan 1 · 10:30 AM", ReminderFormat.dateTime("2030-01-01T09:30:00Z",
            java.time.ZoneId.of("Europe/Rome"), java.util.Locale.US))
    }
    @Test fun recurringReminderDisplaysItsNextUpcomingDate() {
        val reminder = JSONObject().put("syncId", "daily").put("dueAtUtc", "2030-01-01T09:00:00Z")
            .put("scheduleAnchorAtUtc", "2030-01-01T09:00:00Z").put("timezone", "UTC")
            .put("repeatRule", "{\"type\":\"daily\"}")
        assertEquals("2030-01-03T09:00:00.000Z", ReminderFormat.displayDueAt(reminder, java.time.Instant.parse("2030-01-03T00:00:00Z")))
    }
    @Test fun reminderIndexShowsTheNearestPendingReminderForEachNote() {
        val note = Note(JSONObject().put("id", 55).put("syncId", "note-55"))
        val later = JSONObject().put("syncId", "later").put("noteId", 55).put("status", "pending").put("dueAtUtc", "2030-01-02T09:00:00Z")
        val earlier = JSONObject().put("syncId", "earlier").put("noteSyncId", "note-55").put("status", "pending").put("dueAtUtc", "2030-01-01T09:00:00Z")
        val dismissed = JSONObject().put("syncId", "dismissed").put("noteSyncId", "note-55").put("status", "dismissed").put("dueAtUtc", "2030-01-01T08:00:00Z")
        assertEquals("earlier", ReminderFormat.indexByNote(listOf(note), listOf(later, earlier, dismissed))[note.syncId]?.text("syncId"))
    }
    @Test fun recurrenceMatchesSharedCrossLanguageFixtures() {
        val cases = fixtures.getJSONArray("recurrence")
        for (index in 0 until cases.length()) {
            val fixture = cases.getJSONObject(index)
            val actual = Recurrence.next(fixture.getString("dueAtUtc"), fixture.getString("timezone"),
                fixture.getJSONObject("rule").toString(), fixture.optString("anchorAtUtc", fixture.getString("dueAtUtc")))
            assertEquals(fixture.getString("id"), java.time.Instant.parse(fixture.getString("nextDueAtUtc")), java.time.Instant.parse(actual))
        }
    }
    @Test fun supportedHtmlFixturesAreEditableAndUnsupportedFixturesStayReadOnly() {
        val content = fixtures.getJSONObject("content")
        val supported = content.getJSONArray("supportedHtml")
        for (index in 0 until supported.length()) assertTrue(supported.getString(index), NoteFormat.editable(supported.getString(index)))
        val unsupported = content.getJSONArray("unsupportedHtml")
        for (index in 0 until unsupported.length()) assertFalse(unsupported.getString(index), NoteFormat.editable(unsupported.getString(index)))
        assertTrue(NoteFormat.editable(content.getString("richChecklistItem")))
    }
    @Test fun editingRichChecklistTextMustPreserveItsFormatting() {
        val richItem = fixtures.getJSONObject("content").getString("richChecklistItem")
        assertTrue(NoteFormat.checklistItemEditable(richItem))
        val edited = NoteFormat.editedChecklistItem(richItem, "Updated <item>") as String
        assertTrue(edited.contains("href=\"https://example.test/item\""))
        assertTrue(edited.contains("<b>Updated &lt;item&gt;</b>"))
        assertFalse(NoteFormat.checklistItemEditable("<b>first</b> and <i>second</i>"))
        assertEquals("<b>first</b> and <i>second</i>", NoteFormat.editedChecklistItem("<b>first</b> and <i>second</i>", "flat"))
        assertFalse(NoteFormat.checklistItemEditable(fixtures.getJSONObject("content").getJSONObject("structuredChecklistItem")))
    }
    @Test fun checklistToggleMoveAndIndentPreserveNestedAndUnknownItemData() {
        val original = JSONArray().put(JSONObject().put("id", 1).put("data", "First").put("done", false))
            .put(fixtures.getJSONObject("content").getJSONObject("nestedChecklistItem"))
        val toggled = ChecklistAdapter.setDone(original, 1, true)
        val nested = fixtures.getJSONObject("content").getJSONObject("nestedChecklistItem")
        assertEquals(nested.getJSONArray("children").toString(), toggled.getJSONObject(1).getJSONArray("children").toString())
        assertEquals(nested.getBoolean("futureFlag"), toggled.getJSONObject(1).getBoolean("futureFlag"))
        val indented = ChecklistAdapter.indent(toggled, 1, 1)
        assertEquals(3, indented.getJSONObject(1).getInt("indentLevel"))
        assertEquals(nested.getJSONArray("children").toString(), indented.getJSONObject(1).getJSONArray("children").toString())
        val reordered = ChecklistAdapter.move(indented, 1, 0)
        assertEquals(nested.getLong("id"), reordered.getJSONObject(0).getLong("id"))
        assertEquals("First", reordered.getJSONObject(1).getString("data"))
    }
    @Test fun styledTextWidgetRoundTripRetainsSupportedLinkMarkup() {
        val richHtml = fixtures.getJSONObject("content").getString("richChecklistItem")
        val editor = EditText(RuntimeEnvironment.getApplication())
        editor.setText(Html.fromHtml(richHtml, Html.FROM_HTML_MODE_COMPACT))
        val serialized = Html.toHtml(editor.text, Html.TO_HTML_PARAGRAPH_LINES_CONSECUTIVE)
        assertTrue(serialized.contains("href=\"https://example.test/item\""))
        assertTrue(serialized.contains("<b>") && serialized.contains("</b>") && serialized.contains("Rich item"))
        assertTrue(NoteFormat.editable(serialized))
    }
    @Test fun installedCertificateAliasIsScopedToTheServerOrigin() {
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication())
        settings.setAliasFor("https://first.example.test", "first-certificate")
        settings.setAliasFor("https://second.example.test", "second-certificate")
        assertEquals("first-certificate", settings.aliasFor("https://first.example.test/"))
        assertEquals("second-certificate", settings.aliasFor("https://second.example.test"))
        assertEquals("", settings.aliasFor("https://third.example.test"))
        val revision = settings.aliasRevisionFor("https://first.example.test")
        settings.setAliasFor("https://first.example.test", "first-certificate")
        assertTrue("reselecting the same alias invalidates cached TLS clients", settings.aliasRevisionFor("https://first.example.test") > revision)
    }
    @Test fun widgetPickerPreviewsUseTheMainAppIconAndNativeVersionIsV2() {
        val context = RuntimeEnvironment.getApplication()
        assertEquals(R.mipmap.ic_launcher, context.packageManager.getApplicationInfo(context.packageName, 0).icon)
        val androidNamespace = "http://schemas.android.com/apk/res/android"
        for (widgetXml in listOf(R.xml.notes_widget, R.xml.quick_create_widget)) {
            context.resources.getXml(widgetXml).use { parser ->
                while (parser.eventType != org.xmlpull.v1.XmlPullParser.START_TAG &&
                    parser.eventType != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) parser.next()
                assertEquals(R.mipmap.ic_launcher, parser.getAttributeResourceValue(androidNamespace, "previewImage", 0))
            }
        }
        assertEquals("2.0.1", BuildConfig.VERSION_NAME)
        assertEquals(3, BuildConfig.VERSION_CODE)
    }
    @Test fun connectionSnapshotsAreImmutableAndRedactCredentialsFromDiagnostics() {
        val snapshot = ConnectionSnapshot("https://server.example.test", "cert-alias", 3,
            "{\"X-Gateway-Key\":\"gateway-secret\"}", 42, "session-secret")
        assertEquals("https://server.example.test#42", snapshot.profile)
        assertFalse(snapshot.toString().contains("session-secret"))
        assertFalse(snapshot.toString().contains("gateway-secret"))
        assertFalse(snapshot.toString().contains("cert-alias"))
    }
    @Test fun connectionSettingsPublishOneImmutableProfileSnapshot() {
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication())
        settings.origin = "https://first.example.test"
        settings.userId = 42
        val captured = settings.snapshot()

        settings.origin = "https://second.example.test"
        settings.userId = 99

        assertEquals("https://first.example.test#42", captured.profile)
        assertEquals("https://second.example.test#99", settings.snapshot().profile)
    }
    @Test fun connectionSettingsExposePersistenceFailuresToTheUi() = runBlocking {
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication(), FailingSettingsDataStore())
        settings.setAliasFor("https://settings.example.test", "client-certificate")
        settings.awaitWrites()

        assertTrue(settings.writeError.value?.contains("could not be saved") == true)
        settings.clearWriteError()
        assertNull(settings.writeError.value)
    }
    @Test fun accountChangesRequireExplicitProfileConfirmation() {
        val active = ConnectionSnapshot("https://server.example.test", "", 0, "", 42, "expired-token")
        assertFalse(ConnectionProfilePolicy.requiresConfirmation(active, active.origin, active.userId))
        assertTrue(ConnectionProfilePolicy.requiresConfirmation(active, active.origin, 99))
        assertTrue(ConnectionProfilePolicy.requiresConfirmation(active, "https://other.example.test", active.userId))
        assertFalse(ConnectionProfilePolicy.requiresConfirmation(active.copy(userId = 0), active.origin, 99))
    }
    @Test fun serializedProtocolEnvelopeRetainsArbitraryDocumentFields() {
        val extension = fixtures.getJSONObject("content").getJSONObject("unknownNoteField")
        val mutation = JSONObject().put("type", "note.upsert").put("syncId", "future-note").put("operationId", "op-1")
            .put("payload", JSONObject().put("noteTitle", "Draft").put("futureField", extension))
        val envelope = NativeProtocol.mutationBatch(listOf(mutation))
        val decoded = envelope.getJSONArray("mutations").getJSONObject(0)
        assertEquals(extension.toString(), decoded.getJSONObject("payload").getJSONObject("futureField").toString())
        assertEquals("op-1", decoded.getString("operationId"))
        assertTrue(NativeProtocol.mutationBatch(listOf(mutation), includeSnapshot = false).getBoolean("includeSnapshot").not())
    }
    @Test fun redactedDiagnosticsIncludeCountsWithoutSecretsOrDocumentContent() {
        val sensitive = Outbox("operation", "profile", "note.upsert", "note", "SECRET NOTE BODY",
            conflict = "password-secret")
        val connection = ConnectionSnapshot("https://server.example.test", "private-alias", 2,
            "{\"X-Key\":\"gateway-secret\"}", 7, "session-secret")
        val report = RedactedDiagnostics.build("1.0", 35, "test device", connection, "Authenticated",
            3, 2, listOf(sensitive), true, false, false).toString()
        assertTrue(report.contains("\"pendingOperations\":1"))
        assertTrue(report.contains("\"clientCertificateSelected\":true"))
        assertFalse(report.contains("session-secret"))
        assertFalse(report.contains("gateway-secret"))
        assertFalse(report.contains("private-alias"))
        assertFalse(report.contains("SECRET NOTE BODY"))
        assertFalse(report.contains("password-secret"))
    }
    @Test fun connectionDataStoreReopensProfileSettingsWithoutChangingIdentity() {
        val context = RuntimeEnvironment.getApplication()
        val settings = ConnectionSettings(context)
        settings.origin = "https://datastore.example.test"
        settings.userId = 314
        settings.setAliasFor(settings.origin, "stored-certificate")
        runBlocking { settings.awaitWrites() }

        val reopened = ConnectionSettings(context)
        assertFalse("settings load asynchronously instead of blocking their constructor", reopened.ready.value)
        runBlocking { reopened.initialize() }

        assertEquals("https://datastore.example.test#314", reopened.profile)
        assertEquals("stored-certificate", reopened.alias)
        assertEquals(settings.aliasRevisionFor(settings.origin), reopened.aliasRevisionFor(reopened.origin))
        assertTrue(reopened.ready.value)
    }
    @Test fun legacySharedPreferencesMigrateIntoDataStoreWithoutChangingTheProfile() {
        val context = RuntimeEnvironment.getApplication()
        val origin = "https://legacy.example.test"
        val originKey = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(origin.toByteArray()), Base64.NO_WRAP)
        context.getSharedPreferences("connection-migration-test", Context.MODE_PRIVATE).edit()
            .putString("origin", origin).putLong("userId", 57).putString("alias_$originKey", "legacy-client-cert")
            .putBoolean("darkMode", true).commit()

        val settings = ConnectionSettings(context, context.legacyMigrationStore)
        runBlocking { settings.initialize() }

        assertEquals("$origin#57", settings.profile)
        assertEquals("legacy-client-cert", settings.aliasFor(origin))
        assertTrue(settings.darkMode)
    }
    @Test fun httpRequestUsesOneCapturedOriginTokenAndHeaderSnapshot() {
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication())
        settings.origin = "https://new.example.test"
        settings.userId = 9
        val snapshot = ConnectionSnapshot("https://first.example.test", "", 1,
            "{\"X-Gateway-Key\":\"first-gateway\"}", 8, "first-session")
        val api = KeeparrApi(RuntimeEnvironment.getApplication(), settings)

        val request = api.request("/api/notes", snapshot).build()

        assertEquals("https://first.example.test/api/notes", request.url.toString())
        assertEquals("Bearer first-session", request.header("Authorization"))
        assertEquals("first-gateway", request.header("X-Gateway-Key"))
        val firstClient = api.client(snapshot)
        val renewedAliasClient = api.client(snapshot.copy(aliasRevision = 2))
        assertNotSame("reselecting a certificate rebuilds the TLS client", firstClient, renewedAliasClient)
    }
    @Test fun cleanEditorAppliesIncomingNoteWhileDirtyEditorRetainsItsDraft() {
        val local = Note(JSONObject().put("id", 55).put("syncId", "shared").put("revision", 7).put("noteTitle", "Local base"))
        val incoming = Note(local.raw.copyJson().put("revision", 8).put("noteTitle", "Web edit"))
        assertEquals("Web edit", EditorSnapshotPolicy.apply(local, incoming, dirty = false)?.title)
        assertEquals(8L, EditorSnapshotPolicy.apply(local, incoming, dirty = false)?.revision)
        assertEquals(null, EditorSnapshotPolicy.apply(local.raw.copyJson().put("noteTitle", "Unsaved local draft").let(::Note), incoming, dirty = true))
    }
    @Test fun dirtyEditorAdoptsAcceptedRevisionOnlyWhenItsContentMatches() {
        val draft = Note(JSONObject().put("id", 55).put("syncId", "shared").put("revision", 7)
            .put("noteTitle", "Local draft").put("futureField", JSONObject().put("keep", true)))
        val accepted = Note(draft.raw.copyJson().put("revision", 8).put("updatedAt", "server-time"))
        assertEquals(8L, EditorSnapshotPolicy.apply(draft, accepted, dirty = true)?.revision)
        val externalEdit = Note(accepted.raw.copyJson().put("noteTitle", "Different server content"))
        assertEquals(null, EditorSnapshotPolicy.apply(draft, externalEdit, dirty = true))
    }
    @Test fun serverAttachmentMetadataDoesNotKeepAnAcceptedNoteDirty() {
        val draft = Note(JSONObject().put("id", 55).put("syncId", "with-attachment").put("revision", 7)
            .put("noteTitle", "Accepted title").put("attachments", JSONArray().put(JSONObject().put("syncId", "file-1"))))
        val accepted = Note(draft.raw.copyJson().put("revision", 8).put("isDemo", false).put("trashedAt", "")
            .also { it.remove("attachments") })
        assertTrue(EditorSnapshotPolicy.sameEditableContent(draft, accepted))
        assertEquals(8L, EditorSnapshotPolicy.apply(draft, accepted, dirty = true)?.revision)
    }
    @Test fun editorAdoptsAcceptedServerIdentityWithoutReplacingLocalDraftContent() {
        val local = Note(JSONObject().put("id", -3).put("syncId", "new-note").put("revision", 0).put("noteTitle", "Draft"))
        val accepted = Note(JSONObject().put("id", 77).put("syncId", "new-note").put("revision", 1).put("noteTitle", "Draft"))
        val updated = EditorSnapshotPolicy.apply(local, accepted, dirty = true)!!
        assertEquals(77L, updated.id)
        assertEquals(1L, updated.revision)
        assertEquals("Draft", updated.title)
    }

    @Test fun bodyTextShowsTheSameLinesTheWebShows() {
        // Block elements add no blank line of their own (the legacy Html flag did), but explicit blank lines stay.
        assertEquals("a\nb", NoteFormat.displayText("<div>a</div><div>b</div>"))
        assertEquals("a\nb", NoteFormat.displayText("<p dir=\"ltr\">a</p><p dir=\"ltr\">b</p>"))
        assertEquals("a\n\nb", NoteFormat.displayText("<div>a</div><div><br></div><div>b</div>"))
        // The web renders bodies with white-space: pre-wrap, so raw newlines are visible there.
        assertEquals("eth esterno\n\n• Centralina", NoteFormat.displayText("eth esterno\n\n• Centralina"))
        assertEquals("a\n\nb", NoteFormat.displayText("<div>a</div>\n<div>b</div>"))
        assertEquals("a\n\nb", NoteFormat.displayText("<p>a<br>\nb</p>"))
        assertEquals("a & b", NoteFormat.displayText("<div>a &amp; b</div>\n"))
    }

    @Test fun editorSerializationKeepsBlankLinesAndAddsNoStrayNewlines() {
        for (text in listOf("a\nb", "a\n\nb", "a\n\n\nb\nc", "single")) {
            val html = NoteFormat.serialize(android.text.SpannableStringBuilder(text))
            assertFalse("raw newlines render as extra blank lines on the web: $html", html.contains('\n'))
            assertEquals(text, NoteFormat.spanned(html).toString())
            assertEquals("the overview matches the editor", text, NoteFormat.displayText(html))
        }
        // Reloading and saving again must not grow the note.
        val once = NoteFormat.serialize(NoteFormat.spanned("<p>a</p><p>b</p>"))
        assertEquals(once, NoteFormat.serialize(NoteFormat.spanned(once)))
    }
}
