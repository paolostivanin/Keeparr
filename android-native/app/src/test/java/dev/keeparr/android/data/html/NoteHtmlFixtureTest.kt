package dev.keeparr.android.data.html

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

internal object Fixtures {
    val root: JSONObject by lazy {
        val path = requireNotNull(System.getProperty("keeparr.native.fixture"))
        JSONObject(java.io.File(path).readText())
    }
    val editor: JSONObject get() = root.getJSONObject("editorHtml")
    fun objects(array: JSONArray): List<JSONObject> = (0 until array.length()).map { array.getJSONObject(it) }
    fun strings(array: JSONArray): List<String> = (0 until array.length()).map { array.getString(it) }
    fun cases() = objects(editor.getJSONArray("cases"))
}

@RunWith(RobolectricTestRunner::class)
class NoteHtmlFixtureTest {
    @Test fun linesAndNonBlankLinesMatchTheFixtures() {
        for (case in Fixtures.cases()) {
            val html = case.getString("html")
            assertEquals("${case.getString("id")} lines", Fixtures.strings(case.getJSONArray("lines")), NoteHtml.lines(html))
            if (case.has("nonBlankLines") && !case.isNull("nonBlankLines")) {
                assertEquals("${case.getString("id")} nonBlankLines", Fixtures.strings(case.getJSONArray("nonBlankLines")), NoteHtml.nonBlankLines(html))
            }
        }
    }

    @Test fun canonicalFormMatchesAndIsIdempotent() {
        for (case in Fixtures.cases()) {
            val id = case.getString("id")
            val canonical = NoteHtml.canonical(case.getString("html"))
            assertEquals("$id canonical", case.getString("canonical"), canonical)
            assertEquals("$id idempotent", canonical, NoteHtml.canonical(canonical))
        }
    }

    @Test fun previewAndMeaningfulBodyMatch() {
        for (case in Fixtures.cases()) {
            val id = case.getString("id")
            if (case.has("preview") && !case.isNull("preview")) assertEquals("$id preview", case.getString("preview"), NoteHtml.previewText(case.getString("html")))
            assertEquals("$id hasMeaningfulBody", case.getBoolean("hasMeaningfulBody"), NoteHtml.hasMeaningfulBody(case.getString("html")))
        }
    }

    @Test fun authoredShapesAreFixedPoints() {
        for (html in Fixtures.strings(Fixtures.editor.getJSONArray("authoredBody"))) assertEquals(html, NoteHtml.canonical(html))
        for (html in Fixtures.strings(Fixtures.editor.getJSONArray("authoredRow"))) assertEquals(html, NoteHtml.canonical(html, HtmlMode.Row))
    }

    @Test fun editorTextMatchesTheLines() {
        for (case in Fixtures.cases()) {
            val lines = Fixtures.strings(case.getJSONArray("lines"))
            assertEquals(case.getString("id"), lines.joinToString("\n"), NoteHtml.parse(case.getString("html")).toString())
        }
    }

    @Test fun titlesDecodeAndEncode() {
        for (title in Fixtures.objects(Fixtures.editor.getJSONArray("titles"))) {
            val id = title.getString("id")
            val html = title.getString("html")
            assertEquals("$id text", title.getString("text"), NoteHtml.titleText(html))
            assertEquals("$id fresh", if (title.has("canonicalHtml")) title.getString("canonicalHtml") else html, NoteHtml.titleHtml(title.getString("text")))
            assertEquals("$id unchanged", html, NoteHtml.titleHtml(title.getString("text"), html))
        }
        for (edit in Fixtures.objects(Fixtures.editor.getJSONArray("titleEdits"))) {
            assertEquals(edit.getString("id"), edit.getString("html"), NoteHtml.titleHtml(edit.getString("text"), edit.getString("original")))
        }
    }

    @Test fun untouchedDocumentsKeepTheirOriginalString() {
        for (case in Fixtures.cases()) {
            val html = case.getString("html")
            val canonical = NoteHtml.canonical(html)
            assertEquals(case.getString("id"), html, NoteHtml.commit(html, canonical, NoteHtml.parse(html), HtmlMode.Body))
        }
    }

    @Test fun embedsAreSeenAndKeptVerbatim() {
        val image = "<div class=\"inline-note-image-wrap\" contenteditable=\"false\"><img class=\"inline-note-image\" src=\"/api/uploads/images/abc.png\" alt=\"pic\"></div><div><br></div>"
        assertEquals(listOf(image.substringBefore("<div><br>")), NoteHtml.embeds(image))
        assertEquals("/api/uploads/images/abc.png", NoteHtml.firstImageSrc("<div>a</div>$image"))
        assertEquals(null, NoteHtml.firstImageSrc("<table><tbody><tr><td>x</td></tr></tbody></table>"))
        // A table written without tbody stays exactly as it was written.
        val raw = "<div>a</div><table><tr><td>x</td></tr></table><div>b</div>"
        assertEquals(raw, NoteHtml.canonical(raw))
        val svg = "<svg viewBox=\"0 0 10 10\"><path d=\"M0 0\"/></svg>"
        assertEquals(svg, NoteHtml.canonical(svg))
    }

    @Test fun plainTextAndSharedTextHelpers() {
        assertEquals("Caffè", NoteHtml.plainText("<div>Caff&#232;</div>"))
        assertEquals("a &amp; b&lt;br&gt;<br>c", NoteHtml.plainTextToHtml("a & b<br>\r\nc"))
        assertEquals("a&nbsp;b", NoteHtml.escapeText("a\u00a0b"))
        assertFalse(NoteHtml.hasMeaningfulBody("<div> </div>"))
        assertNotNull(NoteHtml.parse("<h1>x</h1>"))
        assertTrue(NoteHtml.displayText("<div>a</div><table><tbody><tr><td>x</td></tr></tbody></table><div>b</div>") == "a\nb")
    }
}
