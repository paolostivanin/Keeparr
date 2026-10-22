package dev.keeparr.android.ui.editor

import android.view.inputmethod.EditorInfo
import android.content.ComponentName
import android.content.Intent
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.data.Note
import dev.keeparr.android.data.copyJson
import dev.keeparr.android.data.html.HtmlMode
import dev.keeparr.android.ui.NoteEditorViewModel
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.LooperMode

@RunWith(RobolectricTestRunner::class)
@LooperMode(LooperMode.Mode.PAUSED)
class EditorToolbarTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var activity: ActivityScenario<ComponentActivity>
    private lateinit var app: KeeparrApplication
    private lateinit var vm: NoteEditorViewModel
    private lateinit var field: RichEditorState

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeeparrApplication
        app.scope.cancel()
        app.enqueueSync = {}
        // Register only in the test package manager; no test activity is added to the APK's manifest.
        shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        activity = ActivityScenario.launch(Intent(app, ComponentActivity::class.java))
    }

    @After fun tearDown() {
        activity.close()
        if (::vm.isInitialized) {
            runBlocking { vm.flushLocal() }
            vm.viewModelScope.cancel()
        }
        app.database.close()
    }

    private fun editor(checklist: Boolean = false) {
        val initial = Note.create(app.settings.userId, checklist).raw.put("id", 70).put("revision", 2)
        if (checklist) initial.put("checkBoxes", JSONArray().put(JSONObject().put("id", 1).put("data", "").put("done", false)))
        vm = NoteEditorViewModel(app.repository, Note(initial))
        field = RichEditorState(if (checklist) HtmlMode.Row else HtmlMode.Body, if (checklist) "row:1" else "body")
        val focus = RichEditorFocus()
        vm.trackFocus { focus.current?.key to focus.current?.selection() }
        activity.onActivity { it.setContent {
            val draft by vm.draft.collectAsStateWithLifecycle()
            val external by vm.externalEdits.collectAsStateWithLifecycle()
            val undo by vm.canUndo.collectAsStateWithLifecycle()
            val redo by vm.canRedo.collectAsStateWithLifecycle()
            val restore by vm.restore.collectAsStateWithLifecycle()
            MaterialTheme {
                CompositionLocalProvider(LocalRichEditorFocus provides focus) {
                    Column {
                        BasicTextField(draft.optString("noteTitle"),
                            onValueChange = { value -> vm.change("noteTitle") { it.put("noteTitle", value) } },
                            modifier = Modifier.testTag("title"))
                        RichTextField(field,
                            html = if (checklist) draft.getJSONArray("checkBoxes").getJSONObject(0).getString("data") else draft.optString("noteBody"),
                            externalEdits = external, colors = EditorColors(android.graphics.Color.BLACK, android.graphics.Color.BLUE), hint = "Note",
                            onHtmlChange = { html ->
                                if (checklist) vm.change("checkBoxes") { it.getJSONArray("checkBoxes").getJSONObject(0).put("data", html) }
                                else vm.change("noteBody") { it.put("noteBody", html) }
                            })
                        FormatToolbar(focus, undo, redo, onUndo = { vm.undo() }, onRedo = { vm.redo() },
                            onCommand = { vm.markStructural() }, contentColor = Color.Black)
                    }
                    LaunchedEffect(restore) {
                        restore?.let { hint ->
                            if (hint.focusKey == field.key && hint.selection != null) field.focus(hint.selection[0], hint.selection[1])
                            vm.consumeRestore(hint)
                        }
                    }
                }
            }
        } }
        compose.runOnIdle { field.view!!.requestFocus(); field.view!!.setSelection(0) }
    }

    private fun type(text: String) = compose.runOnIdle {
        field.view!!.onCreateInputConnection(EditorInfo())!!.commitText(text, 1)
    }

    private fun button(label: String) = compose.onNodeWithContentDescription(label).performScrollTo()

    @Test fun typingAndFormattingEnableTheToolbarAndSurviveSaveAcknowledgements() {
        editor()
        button("Undo").assertIsNotEnabled()
        button("Redo").assertIsNotEnabled()
        type("first")
        button("Undo").assertIsEnabled()
        compose.runOnIdle {
            val submitted = Note(vm.draft.value.copyJson())
            vm.acceptServerSnapshot(Note(submitted.raw.copyJson().put("revision", 3)), submitted)
            vm.applyIncoming(Note(vm.draft.value.copyJson().put("updatedAt", "server time")))
        }
        button("Undo").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("", field.plainText()) }
        button("Redo").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("first", field.plainText()) }
        button("Bulleted list").assertIsEnabled().performClick()
        button("Bulleted list").assertIsSelected().assertTextEquals("•")
        compose.runOnIdle { assertEquals("<ul><li>first</li></ul>", vm.draft.value.optString("noteBody")) }
        button("Undo").performClick()
        compose.runOnIdle { assertEquals("first", field.currentHtml()) }
        button("Redo").performClick()
        compose.runOnIdle { assertEquals("<ul><li>first</li></ul>", field.currentHtml()) }
        type("\n")
        type("second")
        compose.runOnIdle { assertEquals("<ul><li>first</li><li>second</li></ul>", vm.draft.value.optString("noteBody")) }
    }

    @Test fun titleAndChecklistTypingAreUndoableAndANewEditDropsRedo() {
        editor(checklist = true)
        compose.onNodeWithTag("title").performTextInput("Shopping")
        button("Undo").assertIsEnabled().performClick()
        compose.onNodeWithTag("title").assertTextEquals("")
        button("Redo").assertIsEnabled().performClick()
        compose.onNodeWithTag("title").assertTextEquals("Shopping")
        compose.runOnIdle { field.view!!.requestFocus() }
        type("milk")
        button("Undo").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("", field.plainText()) }
        button("Redo").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals("milk", field.plainText()) }
        button("Undo").performClick()
        type("bread")
        button("Redo").assertIsNotEnabled()
        compose.runOnIdle { assertEquals("bread", vm.draft.value.getJSONArray("checkBoxes").getJSONObject(0).getString("data")) }
    }
}
