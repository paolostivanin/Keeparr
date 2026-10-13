package dev.keeparr.android.ui.editor

import dev.keeparr.android.data.html.HtmlMode
import dev.keeparr.android.data.html.NoteHtml
import dev.keeparr.android.data.html.RichTextController
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class InlineImagesTest {
    private val staged = JSONObject().put("file", "f1").put("name", "pic \"1\".png").put("mime", "image/png")
    private val wrapper = "<div class=\"inline-note-image-wrap\" contenteditable=\"false\"><img class=\"inline-note-image\" src=\"/api/uploads/images/abc.png\" alt=\"pic\"></div>"

    @Test fun theWrapperIsTheExactStringTheWebWrites() {
        assertEquals(wrapper, InlineImages.wrapperHtml("/api/uploads/images/abc.png", "pic"))
        assertTrue(InlineImages.wrapperHtml("/a.png", "a \"b\" & c").contains("alt=\"a &quot;b&quot; &amp; c\""))
    }

    @Test fun anOnlineUploadBecomesAnInlineWrapper() = runBlocking {
        var queued = false
        val outcome = InlineImages.place(staged, { JSONObject().put("url", "/api/uploads/images/abc.png").put("name", "pic") }) { queued = true }
        assertEquals(wrapper, (outcome as InlineImages.Outcome.Inline).html)
        assertFalse(queued)
    }

    @Test fun aFailedUploadFallsBackToTheOutboxPath() = runBlocking {
        var queued = false
        val outcome = InlineImages.place(staged, { error("offline") }) { queued = true }
        assertTrue(outcome is InlineImages.Outcome.Queued)
        assertTrue(queued)
    }

    @Test fun onlyImageTypesAreInline() {
        assertTrue(InlineImages.isInlineImage(staged))
        assertFalse(InlineImages.isInlineImage(JSONObject().put("mime", "application/pdf")))
    }

    @Test fun insertingAtTheCaretWritesTheWebShapeAndRemovingTakesOnlyTheImage() {
        val doc = NoteHtml.parse("<div>before after</div>")
        val controller = RichTextController()
        controller.insertEmbed(doc, 7, wrapper)
        assertEquals("<div>before </div>$wrapper<div><br></div><div>after</div>", NoteHtml.serialize(doc))
        val at = doc.toString().indexOf('\uFFFC')
        assertTrue(controller.removeEmbedAt(doc, at))
        assertEquals("<div>before </div><div><br></div><div>after</div>", NoteHtml.serialize(doc))
        val empty = NoteHtml.parse("")
        controller.insertEmbed(empty, 0, wrapper)
        assertEquals("$wrapper<div><br></div>", NoteHtml.serialize(empty))
        assertEquals(wrapper + "<div><br></div>", NoteHtml.canonical(wrapper + "<div><br></div>"))
    }

    @Test fun imagesCannotBeInsertedIntoARow() {
        val row = NoteHtml.parse("x", HtmlMode.Row)
        RichTextController(HtmlMode.Row).insertEmbed(row, 1, wrapper)
        assertEquals("x", NoteHtml.serialize(row, HtmlMode.Row))
    }
}
