package dev.keeparr.android.data.html

import android.text.SpannableStringBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

internal fun applyBodyAction(html: String, selection: Pair<Int, Int>, action: String, controller: RichTextController = RichTextController()): SpannableStringBuilder {
    val doc = NoteHtml.parse(html)
    val (a, b) = selection
    val lo = minOf(a, b); val hi = maxOf(a, b)
    when {
        action == "enter" -> controller.handleEnter(doc, lo, hi)
        action == "backspace" -> controller.backspace(doc, lo, hi)
        action == "bold" -> controller.toggleInline(doc, "b", a, b)
        action == "italic" -> controller.toggleInline(doc, "i", a, b)
        action == "underline" -> controller.toggleInline(doc, "u", a, b)
        action == "h1" -> controller.setLeaf(doc, a, b, "h1")
        action == "h2" -> controller.setLeaf(doc, a, b, "h2")
        action == "normal" -> controller.setLeaf(doc, a, b, "div")
        action == "bullet" -> controller.toggleBullet(doc, a, b)
        action == "indent" -> controller.indent(doc, a, b)
        action == "outdent" -> controller.outdent(doc, a, b)
        action == "clear" -> controller.clear(doc, a, b)
        action.startsWith("paste:") -> controller.paste(doc, lo, hi, action.removePrefix("paste:"))
        else -> error("unknown action $action")
    }
    return doc
}

@RunWith(RobolectricTestRunner::class)
class RichTextOpsTest {
    @Test fun everyEditFixturePasses() {
        val failures = ArrayList<String>()
        val edits = Fixtures.objects(Fixtures.editor.getJSONArray("edits"))
        assertTrue("the fixture has edits", edits.size >= 70)
        for (edit in edits) {
            val id = edit.getString("id")
            val selection = edit.getJSONArray("selection").let { it.getInt(0) to it.getInt(1) }
            try {
                val doc = applyBodyAction(edit.getString("html"), selection, edit.getString("action"))
                val actual = NoteHtml.serialize(doc)
                if (actual != edit.getString("expected")) failures += "$id: expected ${edit.getString("expected")} but was $actual"
                else assertEquals("$id idempotent", actual, NoteHtml.canonical(actual))
            } catch (problem: Throwable) { failures += "$id: $problem" }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test fun everyRowFixturePasses() {
        val failures = ArrayList<String>()
        val rows = Fixtures.objects(Fixtures.editor.getJSONArray("rows"))
        assertTrue("the fixture has rows", rows.size >= 20)
        for (row in rows) {
            val id = row.getString("id")
            try {
                val doc = NoteHtml.parse(row.getString("html"), HtmlMode.Row)
                assertEquals(id, row.getString("text"), doc.toString())
                val controller = RichTextController(HtmlMode.Row)
                var result: List<String>? = null
                controller.onSplit = { left, rest -> result = listOf(left) + rest }
                val edit = row.getJSONObject("edit")
                val selection = edit.getJSONArray("selection")
                controller.paste(doc, selection.getInt(0), selection.getInt(1), edit.getString("insert"))
                val actual = result ?: listOf(NoteHtml.serialize(doc, HtmlMode.Row))
                val expected = Fixtures.strings(row.getJSONArray("expected"))
                if (actual != expected) failures += "$id: expected $expected but was $actual"
            } catch (problem: Throwable) { failures += "$id: $problem" }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test fun backspaceAtTheStartOfABulletUnderAPlainLineDoesNotBulletTheLineAbove() {
        val doc = applyBodyAction("<div>x</div><ul><li>a</li></ul>", 2 to 2, "backspace")
        assertEquals("<div>x</div><div>a</div>", NoteHtml.serialize(doc))
    }

    @Test fun enterOnAnEmptyLevelTwoItemGivesLevelOne() {
        val html = "<ul><li>a<ul><li>b<ul><li><br></li></ul></li></ul></li></ul>"
        val doc = applyBodyAction(html, 4 to 4, "enter")
        assertEquals("<ul><li>a<ul><li>b</li><li><br></li></ul></li></ul>", NoteHtml.serialize(doc))
    }

    @Test fun boldOnFullyBoldTextRemovesItWithoutStackedTags() {
        val doc = applyBodyAction("<div><b>abc</b></div>", 0 to 3, "bold")
        assertEquals("<div>abc</div>", NoteHtml.serialize(doc))
        val twice = applyBodyAction("<div>abc</div>", 0 to 3, "bold")
        RichTextController().toggleInline(twice, "b", 0, 3)
        assertFalse(NoteHtml.serialize(twice).contains("<b><b>"))
    }

    @Test fun strikeSurvivesEditingNearby() {
        val doc = NoteHtml.parse("<div><s>x</s> y</div>")
        val controller = RichTextController()
        controller.replace(doc, 3, 3, "z")
        assertEquals("<div><s>x</s> yz</div>", NoteHtml.serialize(doc))
        controller.replace(doc, 1, 1, "q")
        assertEquals("<div><s>xq</s> yz</div>", NoteHtml.serialize(doc))
    }

    @Test fun pendingStyleAppliesToTheNextInsertionOnly() {
        val doc = NoteHtml.parse("<div>ab</div>")
        val controller = RichTextController()
        controller.toggleInline(doc, "b", 1, 1)
        assertEquals("<div>ab</div>", NoteHtml.serialize(doc))
        assertTrue(controller.formattingAt(doc, 1, 1).contains("b"))
        controller.replace(doc, 1, 1, "X")
        assertEquals("<div>a<b>X</b>b</div>", NoteHtml.serialize(doc))
        controller.replace(doc, 2, 2, "Y")
        assertEquals("<div>a<b>XY</b>b</div>", NoteHtml.serialize(doc))
    }

    @Test fun pendingStyleIsDroppedWhenTheCaretMoves() {
        val doc = NoteHtml.parse("<div>ab</div>")
        val controller = RichTextController()
        controller.toggleInline(doc, "i", 1, 1)
        controller.onSelectionChanged(2, 2)
        controller.replace(doc, 2, 2, "Z")
        assertEquals("<div>abZ</div>", NoteHtml.serialize(doc))
    }

    @Test fun formattingAtReportsBlockAndInlineState() {
        val doc = NoteHtml.parse("<h1><b>a</b></h1><ul><li>b</li></ul>")
        val controller = RichTextController()
        assertEquals(setOf("b", "h1"), controller.formattingAt(doc, 0, 1))
        assertEquals(setOf("bullet"), controller.formattingAt(doc, 2, 2))
    }

    @Test fun composingSpansAndForeignSpansAreNotWritten() {
        val doc = NoteHtml.parse("<div>Buy milk</div>")
        doc.setSpan(android.text.style.UnderlineSpan(), 4, 8, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        doc.setSpan(android.text.style.StyleSpan(android.graphics.Typeface.BOLD), 0, 3, android.text.Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        assertEquals("<div>Buy milk</div>", NoteHtml.serialize(doc))
    }

    @Test fun backwardSelectionsBehaveLikeForwardOnes() {
        assertEquals(NoteHtml.serialize(applyBodyAction("<div>abc</div>", 1 to 2, "italic")), NoteHtml.serialize(applyBodyAction("<div>abc</div>", 2 to 1, "italic")))
    }

    @Test fun emptyDocumentsWriteAnEmptyString() {
        val doc = NoteHtml.parse("<div>a</div>")
        RichTextController().replace(doc, 0, 1, "")
        assertEquals("<div><br></div>", NoteHtml.serialize(doc))
        assertEquals("", NoteHtml.serialize(NoteHtml.parse("")))
        val typed = NoteHtml.parse("")
        RichTextController().replace(typed, 0, 0, "hi")
        assertEquals("hi", NoteHtml.serialize(typed))
    }

    @Test fun embedsStayAloneAndSurviveEditsAroundThem() {
        val html = "<div>before</div><div class=\"inline-note-image-wrap\" contenteditable=\"false\"><img class=\"inline-note-image\" src=\"/api/uploads/images/abc.png\" alt=\"pic\"></div><div><br></div><div>after</div>"
        val doc = NoteHtml.parse(html)
        val controller = RichTextController()
        controller.replace(doc, 0, 0, "X")
        assertEquals(html.replace("before", "Xbefore"), NoteHtml.serialize(doc))
        // Text typed beside the embed moves to its own line.
        val embedAt = doc.toString().indexOf(EMBED_CHAR)
        controller.replace(doc, embedAt + 1, embedAt + 1, "t")
        val written = NoteHtml.serialize(doc)
        assertTrue(written, written.contains("alt=\"pic\"></div><div>t</div>"))
        // Backspace after an embed removes it as a unit.
        val removal = NoteHtml.parse("<div>a</div><img src=\"/api/uploads/images/x.png\" alt=\"x\"><div>b</div>")
        assertTrue(controller.handleBackspaceAtLineStart(removal, removal.toString().lastIndexOf('b')))
        assertEquals("<div>a</div><div>b</div>", NoteHtml.serialize(removal))
    }
}
