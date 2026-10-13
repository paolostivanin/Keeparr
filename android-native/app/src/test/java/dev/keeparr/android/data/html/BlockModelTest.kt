package dev.keeparr.android.data.html

import android.text.Spannable
import android.text.StaticLayout
import android.text.TextPaint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BlockModelTest {
    private fun spans(text: Spannable) = Doc.lines(text).mapNotNull { Doc.spanAt(text, it) }

    @Test fun nestedListRoundTripsWithFourLevels() {
        val html = "<ul><li>a<ul><li>b<ul><li>c<ul><li>d</li></ul></li></ul></li></ul></li><li>e</li></ul>"
        val doc = NoteHtml.parse(html)
        assertEquals("a\nb\nc\nd\ne", doc.toString())
        assertEquals(listOf(1, 2, 3, 4, 1), spans(doc).map { it.listDepth })
        assertEquals(html, NoteHtml.serialize(doc))
    }

    @Test fun listsNestedBesideTheItemAsChromeIndentWritesThemKeepEveryLine() {
        val chrome = "<ul><li>a</li><ul><li>b</li><ul><li>c</li></ul></ul><li>d</li></ul>"
        val doc = NoteHtml.parse(chrome)
        assertEquals("a\nb\nc\nd", doc.toString())
        assertEquals(listOf(1, 2, 3, 1), spans(doc).map { it.listDepth })
        // The shape the web wrote is the shape that is written back.
        assertEquals(chrome, NoteHtml.serialize(doc))
    }

    @Test fun fifthLevelIsKeptInTheDataAndDrawnAtDepthFour() {
        val html = "<p>x</p><ul><li>1<ul><li>2<ul><li>3<ul><li>4<ul><li>5</li></ul></li></ul></li></ul></li></ul></li></ul><p>y</p>"
        val doc = NoteHtml.parse(html)
        assertEquals(listOf(0, 1, 2, 3, 4, 5, 0), spans(doc).map { it.listDepth })
        assertEquals(html, NoteHtml.serialize(doc))
        assertEquals("x\n• 1\n  ◦ 2\n    ▪ 3\n      ▫ 4\n      ▫ 5\ny", NoteHtml.previewText(html))
    }

    @Test fun orderedListsAreEditableAndNumberedFromTheirStartAttribute() {
        val doc = NoteHtml.parse("<ol start=\"3\"><li>a</li><li>b</li></ol><ul><li>x</li></ul><ol><li>y</li><li>z</li></ol>")
        assertEquals(listOf("3.", "4.", "•", "1.", "2."), spans(doc).map { it.marker })
        assertEquals(listOf(3, 4, null, 1, 2), spans(doc).map { it.ordinal })
        RichTextController().replace(doc, 1, 1, "!")
        assertEquals("<ol start=\"3\"><li>a!</li><li>b</li></ol><ul><li>x</li></ul><ol><li>y</li><li>z</li></ol>", NoteHtml.serialize(doc))
    }

    @Test fun continuationLinesAndStrayTextGetNoMarker() {
        val doc = NoteHtml.parse("<ul><li>a<br>b</li>stray<li>c</li></ul>")
        assertEquals(listOf("•", null, null, "•"), spans(doc).map { it.marker })
        assertEquals(listOf(1, 1, 0, 1), spans(doc).map { it.listDepth })
    }

    @Test fun headingsAndQuotesAreDerivedFromTheirFrames() {
        val doc = NoteHtml.parse("<h1>T</h1><blockquote><blockquote>q</blockquote></blockquote><h3>s</h3>")
        assertEquals(listOf("h1", null, "h3"), spans(doc).map { it.leafTag?.takeIf { tag -> tag[0] == 'h' } })
        assertEquals(listOf(0, 2, 0), spans(doc).map { it.quoteDepth })
        assertEquals(2, doc.getSpans(0, doc.length, HeadingSizeSpan::class.java).size)
    }

    @Test fun legacyParagraphsBecomeDivs() {
        val html = "<p dir=\"ltr\" style=\"margin-top:0; margin-bottom:0;\">a</p>"
        assertEquals("<div>a</div>", NoteHtml.canonical(html))
        assertEquals("<p dir=\"ltr\">a</p>", NoteHtml.canonical("<p dir=\"ltr\">a</p>"))
    }

    private fun margins(text: Spannable): List<Int> {
        val layout = StaticLayout.Builder.obtain(text, 0, text.length, TextPaint().apply { textSize = 18f }, 1000).build()
        return (0 until layout.lineCount).map { layout.getParagraphLeft(it) }
    }

    @Test fun pressingEnterOnABulletDoesNotIndentThePreviousLineTwice() {
        val doc = NoteHtml.parse("<ul><li>abc</li></ul>")
        val single = margins(doc).single()
        RichTextController().handleEnter(doc, 3, 3)
        assertEquals("the previous line keeps its own margin", single, margins(doc)[0])
        assertEquals("<ul><li>abc</li><li><br></li></ul>", NoteHtml.serialize(doc))
        RichTextController().replace(doc, 4, 4, "x")
        assertEquals(listOf(single, single), margins(doc))
    }

    @Test fun anEmptyLastBulletLineStillKnowsItIsABullet() {
        val doc = NoteHtml.parse("<ul><li>a</li><li><br></li></ul>")
        val last = Doc.lines(doc).last()
        val span = Doc.spanAt(doc, last)
        assertNotNull(span)
        assertEquals("•", span!!.marker)
        assertTrue(span.markerOnly)
    }

    @Test fun serializationNeedsOnlyTheSpans() {
        val doc = NoteHtml.parse("<h2>a</h2><ul><li>b</li></ul>")
        val copy = android.text.SpannableStringBuilder(doc)
        assertEquals("<h2>a</h2><ul><li>b</li></ul>", NoteHtml.serialize(copy))
    }
}
