package dev.kept.android.data

import android.content.Context
import org.junit.Assert.*
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject
import android.text.Html
import android.widget.EditText
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import dev.kept.android.widgets.singleNoteWidgetChecklistItems
import dev.kept.android.widgets.boundedWidgetText
import dev.kept.android.ui.canReorderNotes
import dev.kept.android.ui.moveDraggedNote
import androidx.datastore.preferences.SharedPreferencesMigration
import androidx.datastore.preferences.preferencesDataStore
import android.util.Base64
import java.security.MessageDigest

private val Context.legacyMigrationStore by preferencesDataStore(name = "connection-migration-test",
    produceMigrations = { context -> listOf(SharedPreferencesMigration(context, "connection-migration-test")) })

@RunWith(RobolectricTestRunner::class)
class NativeContractTest {
    private val fixtures by lazy {
        val path = requireNotNull(System.getProperty("kept.native.fixture"))
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
    @Test fun widgetTextIsBoundedBeforeRemoteViewsSerialization() {
        assertEquals(128, boundedWidgetText("x".repeat(10_000), 128).length)
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
    @Test fun connectionSnapshotsAreImmutableAndRedactCredentialsFromDiagnostics() {
        val snapshot = ConnectionSnapshot("https://server.example.test", "cert-alias", 3,
            "{\"X-Gateway-Key\":\"gateway-secret\"}", 42, "session-secret")
        assertEquals("https://server.example.test#42", snapshot.profile)
        assertFalse(snapshot.toString().contains("session-secret"))
        assertFalse(snapshot.toString().contains("gateway-secret"))
        assertFalse(snapshot.toString().contains("cert-alias"))
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

        val reopened = ConnectionSettings(context)

        assertEquals("https://datastore.example.test#314", reopened.profile)
        assertEquals("stored-certificate", reopened.alias)
        assertEquals(settings.aliasRevisionFor(settings.origin), reopened.aliasRevisionFor(reopened.origin))
    }
    @Test fun legacySharedPreferencesMigrateIntoDataStoreWithoutChangingTheProfile() {
        val context = RuntimeEnvironment.getApplication()
        val origin = "https://legacy.example.test"
        val originKey = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(origin.toByteArray()), Base64.NO_WRAP)
        context.getSharedPreferences("connection-migration-test", Context.MODE_PRIVATE).edit()
            .putString("origin", origin).putLong("userId", 57).putString("alias_$originKey", "legacy-client-cert")
            .putBoolean("darkMode", true).commit()

        val settings = ConnectionSettings(context, context.legacyMigrationStore)

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
        val api = KeptApi(RuntimeEnvironment.getApplication(), settings)

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
    @Test fun editorAdoptsAcceptedServerIdentityWithoutReplacingLocalDraftContent() {
        val local = Note(JSONObject().put("id", -3).put("syncId", "new-note").put("revision", 0).put("noteTitle", "Draft"))
        val accepted = Note(JSONObject().put("id", 77).put("syncId", "new-note").put("revision", 1).put("noteTitle", "Draft"))
        val updated = EditorSnapshotPolicy.apply(local, accepted, dirty = true)!!
        assertEquals(77L, updated.id)
        assertEquals(1L, updated.revision)
        assertEquals("Draft", updated.title)
    }
}
