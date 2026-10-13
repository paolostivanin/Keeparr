@file:OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
package dev.keeparr.android.ui.editor

import android.graphics.Rect
import android.view.inputmethod.InputMethodManager
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import dev.keeparr.android.data.html.EmbedSpan
import dev.keeparr.android.data.html.HtmlMode
import dev.keeparr.android.data.html.NoteHtml
import dev.keeparr.android.ui.applyNoteColors
import kotlinx.coroutines.launch

/** What the formatting toolbar can ask of the focused field. */
enum class EditorCommand { H1, H2, Normal, Bullet, Indent, Outdent, Bold, Italic, Underline, Clear }

/**
 * The plain holder behind one editable field. It lives outside composition: the Android view reports into it, and
 * composition only reads [formatting] (for the toolbar) and calls [focus]. Nothing in the view's `update` block reads
 * Compose state except the colors and the external-edit counter, so typing never rebinds the text (fixes A21).
 */
class RichEditorState(val mode: HtmlMode, val key: String) {
    internal var view: KeeparrEditText? = null
    private var original = ""
    private var originalCanonical = ""
    private var emitted = ""
    internal var seenExternal = Long.MIN_VALUE
    internal var onHtml: (String) -> Unit = {}
    internal var onEvent: (() -> Unit)? = null

    /** Toolbar states of the current selection (`b`, `i`, `u`, `h1`, `h2`, `bullet`, `quote`). */
    var formatting by mutableStateOf<Set<String>>(emptySet())
        private set

    /** What would be stored right now: the loaded string while nothing changed, the written form after an edit. */
    fun currentHtml(): String? = view?.let { NoteHtml.commit(original, originalCanonical, it.text, mode) }

    internal fun load(html: String) {
        original = html
        originalCanonical = NoteHtml.canonical(html, mode)
        emitted = html
    }

    internal fun documentChanged() {
        val html = currentHtml() ?: return
        refreshFormatting()
        if (html != emitted) { emitted = html; onHtml(html) }
        onEvent?.invoke()
    }

    /** Drops what is shown and shows [html] instead, as when another device or an undo changed the field. */
    internal fun reset(html: String, keepSelection: Boolean = true) {
        val view = view ?: return
        load(html)
        view.setDocument(NoteHtml.parse(html, mode), keepSelection)
        refreshFormatting()
    }

    fun refreshFormatting() {
        val view = view ?: return
        formatting = view.controller.formattingAt(view.text, view.selectionStart.coerceAtLeast(0), view.selectionEnd.coerceAtLeast(0))
    }

    fun run(command: EditorCommand) {
        val view = view ?: return
        val a = view.selectionStart.coerceAtLeast(0)
        val b = view.selectionEnd.coerceAtLeast(0)
        val active = formatting
        view.edit { text ->
            val c = view.controller
            when (command) {
                EditorCommand.Bold -> c.toggleInline(text, "b", a, b)
                EditorCommand.Italic -> c.toggleInline(text, "i", a, b)
                EditorCommand.Underline -> c.toggleInline(text, "u", a, b)
                EditorCommand.H1 -> c.setLeaf(text, a, b, if ("h1" in active) "div" else "h1")
                EditorCommand.H2 -> c.setLeaf(text, a, b, if ("h2" in active) "div" else "h2")
                EditorCommand.Normal -> c.setLeaf(text, a, b, "div")
                EditorCommand.Bullet -> c.toggleBullet(text, a, b)
                EditorCommand.Indent -> c.indent(text, a, b)
                EditorCommand.Outdent -> c.outdent(text, a, b)
                EditorCommand.Clear -> c.clear(text, a, b)
            }
        }
    }

    /** Brings the field into focus with the caret at [caret] (the end for null) and opens the keyboard. */
    fun focus(caret: Int? = null, selectionEnd: Int? = null) {
        val view = view ?: return
        view.requestFocus()
        val length = view.text.length
        val start = (caret ?: length).coerceIn(0, length)
        view.setSelection(start, (selectionEnd ?: start).coerceIn(0, length))
        view.post { view.context.getSystemService(InputMethodManager::class.java)?.showSoftInput(view, InputMethodManager.SHOW_IMPLICIT) }
    }

    fun selection(): IntArray? = view?.let { intArrayOf(it.selectionStart.coerceAtLeast(0), it.selectionEnd.coerceAtLeast(0)) }

    fun textLength(): Int = view?.text?.length ?: 0

    /** Plain text of the field, as shown. */
    fun plainText(): String = view?.text?.toString().orEmpty()
}

/** Tracks which field the toolbar talks to. The title (and nothing focused) has no formatting commands. */
class RichEditorFocus {
    var current by mutableStateOf<RichEditorState?>(null)
        internal set
    internal fun focused(state: RichEditorState) { current = state; state.refreshFormatting() }
    internal fun blurred(state: RichEditorState) { if (current === state) current = null }
    fun clear() { current = null }
}

val LocalRichEditorFocus = compositionLocalOf { RichEditorFocus() }

@Composable
fun rememberRichEditorState(mode: HtmlMode, key: String): RichEditorState = remember(mode, key) { RichEditorState(mode, key) }

/** Colors of the editable view, from the note's foreground. */
class EditorColors(val text: Int, val link: Int)

/**
 * A body or checklist-row editor. [html] is what the note stores; [externalEdits] changes when something other than typing
 * replaced it (another device, undo, a structural checklist operation), which is the only time the text is reset.
 */
@Composable
fun RichTextField(
    state: RichEditorState,
    html: String,
    externalEdits: Long,
    colors: EditorColors,
    hint: String,
    modifier: Modifier = Modifier,
    textSizeSp: Float = 16f,
    minLines: Int = 1,
    embeds: EmbedBinder? = null,
    onHtmlChange: (String) -> Unit,
    onSplit: ((left: String, rest: List<String>, caret: Int) -> Unit)? = null,
    onBackspaceAtStart: (() -> Boolean)? = null,
    onEmbedTap: ((EmbedSpan, Int, Boolean) -> Unit)? = null,
    onImageContent: ((android.net.Uri, String) -> Unit)? = null,
    onSelectionUpdated: (() -> Unit)? = null
) {
    val focus = LocalRichEditorFocus.current
    val scope = rememberCoroutineScope()
    val requester = remember { BringIntoViewRequester() }
    state.onHtml = onHtmlChange
    state.onEvent = onSelectionUpdated
    AndroidView(
        factory = { context ->
            KeeparrEditText(context, state.mode).also { view ->
                state.view = view
                state.load(html)
                state.seenExternal = externalEdits
                view.setDocument(NoteHtml.parse(html, state.mode))
                view.onDocumentChanged = { state.documentChanged(); embeds?.bind(view) }
                view.onSelectionUpdated = { _, _ -> state.refreshFormatting(); onSelectionUpdated?.invoke() }
                view.onCaretRect = { rect: Rect ->
                    scope.launch { requester.bringIntoView(androidx.compose.ui.geometry.Rect(rect.left.toFloat(), rect.top.toFloat(), rect.right.toFloat(), rect.bottom.toFloat())) }
                }
                view.setOnFocusChangeListener { _, hasFocus -> if (hasFocus) focus.focused(state) else focus.blurred(state) }
                embeds?.bind(view)
            }
        },
        modifier = modifier.bringIntoViewRequester(requester),
        update = { view ->
            state.view = view
            view.textSize = textSizeSp
            view.hint = hint
            view.minLines = minLines
            view.applyNoteColors(colors.text, colors.link)
            view.onEmbedTap = onEmbedTap
            view.onImageContent = onImageContent
            view.controller.onSplit = { left, rest, caret ->
                // The view still shows the typed line break and this runs inside its text watcher, so the reset to the left
                // part and the split of the row wait until the change is complete.
                view.post {
                    state.reset(left, keepSelection = false)
                    onSplit?.invoke(left, rest, caret)
                }
            }
            view.onBackspaceAtStart = onBackspaceAtStart
            if (externalEdits != state.seenExternal) {
                state.seenExternal = externalEdits
                if (NoteHtml.canonical(html, state.mode) != NoteHtml.serialize(view.text, state.mode)) state.reset(html)
                else state.load(html)
                embeds?.bind(view)
            }
        },
        onRelease = { view -> if (state.view === view) state.view = null; focus.blurred(state) }
    )
}
