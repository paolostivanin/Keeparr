package dev.keeparr.android.ui.editor

import android.content.ClipData
import android.view.ContentInfo
import android.view.inputmethod.EditorInfo
import dev.keeparr.android.data.html.HtmlMode
import dev.keeparr.android.data.html.NoteHtml
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class KeeparrEditTextTest {
    private fun field(html: String, mode: HtmlMode = HtmlMode.Body) = KeeparrEditText(RuntimeEnvironment.getApplication(), mode).also {
        it.setDocument(NoteHtml.parse(html, mode))
    }

    private fun KeeparrEditText.html() = NoteHtml.serialize(text, mode)

    @Test fun theInputConnectionTurnsBackspaceAtALineStartIntoTheEditorRule() {
        val view = field("<div>x</div><ul><li>a</li></ul>")
        var changed = 0
        view.onDocumentChanged = { changed++ }
        view.setSelection(2)
        val connection = view.onCreateInputConnection(EditorInfo())!!
        assertTrue(connection.deleteSurroundingText(1, 0))
        assertEquals("<div>x</div><div>a</div>", view.html())
        assertEquals("the text was not deleted", "x\na", view.text.toString())
        assertTrue(changed > 0)
        // A second Backspace merges with the line above; a delete inside a line is left to the platform.
        assertTrue(connection.deleteSurroundingText(1, 0))
        assertEquals("<div>xa</div>", view.html())
        view.setSelection(2)
        connection.deleteSurroundingText(1, 0)
        assertEquals("x", view.text.toString())
    }

    @Test fun hardwareBackspaceAtALineStartAlsoRemovesTheBullet() {
        val view = field("<ul><li>a</li><li>b</li></ul>")
        view.setSelection(2)
        val down = android.view.KeyEvent(android.view.KeyEvent.ACTION_DOWN, android.view.KeyEvent.KEYCODE_DEL)
        assertTrue(view.dispatchKeyEvent(down))
        assertEquals("<ul><li>a</li></ul><div>b</div>", view.html())
    }

    @Test fun typedEnterAndTextGoThroughTheController() {
        val view = field("<ul><li>a</li></ul>")
        view.setSelection(1)
        val connection = view.onCreateInputConnection(EditorInfo())!!
        connection.commitText("\n", 1)
        connection.commitText("b", 1)
        assertEquals("<ul><li>a</li><li>b</li></ul>", view.html())
    }

    @Test fun composingTextIsNotSavedAsUnderline() {
        val view = field("")
        val connection = view.onCreateInputConnection(EditorInfo())!!
        connection.setComposingText("Buy", 1)
        connection.commitText("Buy ", 1)
        connection.setComposingText("milk", 1)
        assertFalse(view.html(), view.html().contains("<u>"))
        connection.finishComposingText()
        assertEquals("Buy milk", view.html())
    }

    @Test fun pasteInsertsPlainTextEvenFromStyledContent() {
        val view = field("<div>ab</div>")
        view.setSelection(1)
        val styled = ContentInfo.Builder(ClipData.newHtmlText("c", "red", "<h1><span style=\"color:red\">red</span></h1>"), ContentInfo.SOURCE_CLIPBOARD).build()
        assertTrue(view.performReceiveContent(styled) == null)
        assertEquals("<div>aredb</div>", view.html())
        val multi = ContentInfo.Builder(ClipData.newPlainText("c", "<b>x</b>\r\ny"), ContentInfo.SOURCE_CLIPBOARD).build()
        view.setSelection(0)
        assertNotNull(view.text)
        view.performReceiveContent(multi)
        assertEquals("<div>&lt;b&gt;x&lt;/b&gt;<br>yaredb</div>", view.html())
    }

    @Test fun anImagePasteIsHandedToTheImageHook() {
        val view = field("")
        var received: String? = null
        view.onImageContent = { uri, mime -> received = "$uri $mime" }
        val clip = ClipData("image", arrayOf("image/png"), ClipData.Item(android.net.Uri.parse("content://x/1.png")))
        view.performReceiveContent(ContentInfo.Builder(clip, ContentInfo.SOURCE_CLIPBOARD).build())
        assertEquals("content://x/1.png image/png", received)
    }

    @Test fun aRowReportsASplitInsteadOfKeepingTheLineBreak() {
        val view = field("<b>ab</b>cd", HtmlMode.Row)
        var split: Triple<String, List<String>, Int>? = null
        view.controller.onSplit = { left, rest, caret -> split = Triple(left, rest, caret) }
        view.setSelection(1)
        view.onCreateInputConnection(EditorInfo())!!.commitText("\n", 1)
        assertEquals(Triple("<b>a</b>", listOf("<b>b</b>cd"), 0), split)
    }

    @Test fun backspaceAtTheStartOfARowIsHandedToTheOwner() {
        val view = field("abc", HtmlMode.Row)
        var calls = 0
        view.onBackspaceAtStart = { calls++; true }
        view.setSelection(0)
        assertTrue(view.onCreateInputConnection(EditorInfo())!!.deleteSurroundingText(1, 0))
        assertEquals(1, calls)
        view.setSelection(2)
        view.onCreateInputConnection(EditorInfo())!!.deleteSurroundingText(1, 0)
        assertEquals(1, calls)
    }
}
