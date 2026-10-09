package dev.keeparr.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BulletsTest {
    @Test fun nestedListRoundTripsWithFourLevels() {
        val html = "<ul><li>a<ul><li>b<ul><li>c<ul><li>d</li></ul></li></ul></li></ul></li><li>e</li></ul>"
        assertTrue(NoteFormat.editable(html))
        val spanned = NoteFormat.spanned(html)
        assertEquals("a\nb\nc\nd\ne", spanned.toString())
        assertEquals(listOf(0, 1, 2, 3, 0), Bullets.levels(spanned as android.text.Spannable))
        assertEquals(html, NoteFormat.serialize(spanned))
    }
    @Test fun listsNestedBesideTheItemAsChromeIndentWritesThemKeepEveryLine() {
        // Chrome's execCommand('indent') output: the nested list is a child of the list, not of the <li>.
        val chrome = "<ul><li>a</li><ul><li>b</li><ul><li>c</li></ul></ul><li>d</li></ul>"
        assertTrue(NoteFormat.editable(chrome))
        val spanned = NoteFormat.spanned(chrome)
        assertEquals("a\nb\nc\nd", spanned.toString())
        assertEquals(listOf(0, 1, 2, 0), Bullets.levels(spanned as android.text.Spannable))
        // Saving from Android writes the standard shape, which the same reader gives back unchanged.
        val saved = NoteFormat.serialize(spanned)
        assertEquals("<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>", saved)
        assertEquals(listOf(0, 1, 2, 0), Bullets.levels(NoteFormat.spanned(saved) as android.text.Spannable))
    }
    @Test fun fifthLevelIsClampedAndParagraphsSurround() {
        val spanned = NoteFormat.spanned("<p>x</p><ul><li>1<ul><li>2<ul><li>3<ul><li>4<ul><li>5</li></ul></li></ul></li></ul></li></ul></li></ul><p>y</p>")
        assertEquals(listOf(null, 0, 1, 2, 3, 3, null), Bullets.levels(spanned as android.text.Spannable))
        val out = NoteFormat.serialize(spanned)
        assertTrue(out, Regex("^<p[^>]*>x</p><ul><li>1<ul><li>2").containsMatchIn(out))
        assertTrue(out, Regex("</ul><p[^>]*>y</p>$").containsMatchIn(out))
    }
    @Test fun indentIsCappedAtFourLevels() {
        val items = org.json.JSONArray().put(org.json.JSONObject().put("indentLevel", 3))
        assertEquals(3, ChecklistAdapter.indent(items, 0, 1).getJSONObject(0).getInt("indentLevel"))
    }
    @Test fun applyNeverNestsMoreThanOneLevelBelowThePreviousLine() {
        val text = android.text.SpannableStringBuilder("a\nb\nc")
        Bullets.apply(text, listOf(2, 3, 0))
        assertEquals(listOf(0, 1, 0), Bullets.levels(text))
        Bullets.apply(text, listOf(null, 1, 9))
        assertEquals(listOf(null, 0, 1), Bullets.levels(text))
    }
    @Test fun linesIncludeTrailingEmptyLine() {
        assertEquals(listOf(0 to 1, 2 to 2), Bullets.lines("a\n").map { it[0] to it[1] })
    }
    @Test fun plainBodiesAreUnchangedBySerialize() {
        val html = "<p dir=\"ltr\">hello</p>"
        assertEquals(html, NoteFormat.serialize(NoteFormat.spanned(html)).replace(" style=\"margin-top:0; margin-bottom:0;\"", ""))
    }
    private fun margins(text: android.text.Spannable): List<Int> {
        val layout = android.text.StaticLayout.Builder.obtain(text, 0, text.length, android.text.TextPaint().apply { textSize = 18f }, 1000).build()
        return (0 until layout.lineCount).map { layout.getParagraphLeft(it) }
    }
    @Test fun pressingEnterOnABulletDoesNotIndentThePreviousLineTwice() {
        val text = android.text.SpannableStringBuilder("abc")
        Bullets.apply(text, listOf(0))
        val single = margins(text).single()
        // What the editor does when Enter is typed at the end of a bullet: a new, still empty, bullet line.
        text.insert(3, "\n")
        Bullets.apply(text, listOf(0, 0))
        assertEquals("the previous line keeps its own margin", single, margins(text)[0])
        assertEquals("the empty line still remembers it is a bullet", listOf(0, 0), Bullets.levels(text))
        text.insert(4, "x")
        Bullets.apply(text, Bullets.levels(text))
        assertEquals(listOf(single, single), margins(text))
    }
    @Test fun previewTextShowsBulletsAndIndentWhileDisplayTextDoesNot() {
        val html = "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>"
        assertEquals("a\nb\nc", NoteFormat.displayText(html))
        assertEquals("\u2022 a\n  \u25E6 b\n\u2022 c", NoteFormat.previewText(html))
        assertEquals("x\n\u2022 a\ny", NoteFormat.previewText("<p>x</p><ul><li>a</li></ul><p>y</p>"))
        assertEquals("plain text keeps its exact display text", NoteFormat.displayText("<p>a</p><p><br></p><p>b</p>"),
            NoteFormat.previewText("<p>a</p><p><br></p><p>b</p>"))
    }
    @Test fun orderedListsAreNotEditableButBulletsAre() {
        assertTrue(NoteFormat.editable("<ul><li>x</li></ul>"))
        assertTrue(!NoteFormat.editable("<ol><li>x</li></ol>"))
    }
}
