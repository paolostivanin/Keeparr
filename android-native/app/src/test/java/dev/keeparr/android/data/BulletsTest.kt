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
    @Test fun orderedListsAreNotEditableButBulletsAre() {
        assertTrue(NoteFormat.editable("<ul><li>x</li></ul>"))
        assertTrue(!NoteFormat.editable("<ol><li>x</li></ol>"))
    }
}
