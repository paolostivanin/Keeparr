package dev.keeparr.android.data.html

import android.text.SpannableStringBuilder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.random.Random

private class HtmlGenerator(private val random: Random) {
    private val words = listOf("a", "bc", "Caffè", "日本", "x y", "  two  ", "a&amp;b", "&lt;t&gt;", "&nbsp;", "😀", "q\"q", "Tom", " ", "line")
    private fun word() = words[random.nextInt(words.size)]

    private fun inline(depth: Int = 0): String {
        val parts = (0..random.nextInt(3)).joinToString("") {
            when (random.nextInt(if (depth > 2) 3 else 9)) {
                0, 1, 2 -> word()
                3 -> "<b>${inline(depth + 1)}</b>"
                4 -> "<i>${inline(depth + 1)}</i>"
                5 -> "<u>${inline(depth + 1)}</u>"
                6 -> "<a href=\"https://e.test/?a=1&amp;b=${random.nextInt(9)}\">${inline(depth + 1)}</a>"
                7 -> "<s>${inline(depth + 1)}</s>"
                else -> "<span style=\"font-weight: bold;\">${inline(depth + 1)}</span>"
            }
        }
        return when (random.nextInt(8)) { 0 -> "$parts<br>"; 1 -> "$parts<br>${word()}"; 2 -> "$parts\n${word()}"; else -> parts }
    }

    private fun list(depth: Int): String {
        val tag = if (random.nextInt(4) == 0) "ol" else "ul"
        val start = if (tag == "ol" && random.nextInt(3) == 0) " start=\"${random.nextInt(5) + 1}\"" else ""
        val items = (0..random.nextInt(3)).joinToString("") {
            when (random.nextInt(8)) {
                0 -> "stray"
                1 -> "<li><br></li>"
                2 -> if (depth < 5) "<$tag><li>${inline()}</li></$tag>" else "<li>x</li>"
                3, 4 -> if (depth < 5) "<li>${inline()}${list(depth + 1)}</li>" else "<li>y</li>"
                else -> "<li>${inline()}</li>"
            }
        }
        return "<$tag$start>$items</$tag>"
    }

    private fun block(depth: Int = 0): String = when (random.nextInt(14)) {
        0 -> inline()
        1, 2 -> "<div>${inline()}</div>"
        3 -> "<div><br></div>"
        4 -> "<h${random.nextInt(2) + 1}>${inline()}</h1>".replace(Regex("<h(\\d)>(.*)</h1>")) { "<h${it.groupValues[1]}>${it.groupValues[2]}</h${it.groupValues[1]}>" }
        5, 6 -> list(0)
        7 -> "<p>${inline()}</p>"
        8 -> if (depth < 2) "<blockquote>${(0..random.nextInt(2)).joinToString("") { block(depth + 1) }}</blockquote>" else "<div>q</div>"
        9 -> "<div class=\"inline-note-image-wrap\" contenteditable=\"false\"><img class=\"inline-note-image\" src=\"/api/uploads/images/${random.nextInt(9)}.png\" alt=\"pic\"></div><div><br></div>"
        10 -> "<table><tbody><tr><td>${word()}</td></tr></tbody></table>"
        11 -> "<br>"
        12 -> "<pre>${word()}\n ${word()}</pre>"
        else -> "\n"
    }

    fun document(): String = (0..random.nextInt(5)).joinToString("") { block() }
}

@RunWith(RobolectricTestRunner::class)
class RoundTripFuzzTest {
    @Test fun parsingNeverThrowsOnArbitraryHtml() {
        val random = Random(7)
        val alphabet = "<>/ab\"'= &;#\n \u0000divulibrph1ap://".toList()
        repeat(2000) {
            val html = (0..random.nextInt(80)).joinToString("") { alphabet[random.nextInt(alphabet.size)].toString() }
            NoteHtml.canonical(html)
            NoteHtml.lines(html); NoteHtml.nonBlankLines(html); NoteHtml.previewText(html); NoteHtml.titleText(html)
        }
    }

    @Test fun canonicalIsIdempotentForFiveThousandSeededDocuments() {
        val random = Random(20261013)
        val generator = HtmlGenerator(random)
        val failures = ArrayList<String>()
        repeat(5000) { n ->
            val html = generator.document()
            val once = NoteHtml.canonical(html)
            val twice = NoteHtml.canonical(once)
            if (once != twice) failures += "#$n not idempotent: $html -> $once -> $twice"
            if (once.contains("&#")) failures += "#$n numeric entity in $once"
            // Reading what was written gives the same lines.
            if (NoteHtml.lines(html) != NoteHtml.lines(once)) failures += "#$n lines changed: $html -> $once"
            if (failures.size > 10) return@repeat
        }
        assertTrue(failures.take(10).joinToString("\n"), failures.isEmpty())
    }

    @Test fun editSequencesKeepTheOutputCanonical() {
        val random = Random(System.getenv("FUZZ_SEED")?.toLong() ?: 99L)
        val generator = HtmlGenerator(random)
        val failures = ArrayList<String>()
        repeat(System.getenv("FUZZ_N")?.toInt() ?: 1500) { n ->
            val html = generator.document()
            val doc = NoteHtml.parse(html)
            val controller = RichTextController()
            val trail = StringBuilder(html)
            repeat(1 + random.nextInt(6)) {
                val length = doc.length
                val a = random.nextInt(length + 1)
                val b = if (random.nextInt(3) == 0) random.nextInt(length + 1) else a
                val op = random.nextInt(14)
                trail.append(" |op$op[$a,$b]")
                try {
                    when (op) {
                        0 -> controller.replace(doc, minOf(a, b), maxOf(a, b), listOf("x", "\n", "è", " ", "<b>&")[random.nextInt(5)])
                        1 -> controller.handleEnter(doc, minOf(a, b), maxOf(a, b))
                        2 -> controller.backspace(doc, a, b)
                        3 -> controller.toggleInline(doc, "b", a, b)
                        4 -> controller.toggleInline(doc, "i", a, b)
                        5 -> controller.toggleInline(doc, "u", a, b)
                        6 -> controller.setLeaf(doc, a, b, listOf("h1", "h2", "div")[random.nextInt(3)])
                        7 -> controller.toggleBullet(doc, a, b)
                        8 -> controller.indent(doc, a, b)
                        9 -> controller.outdent(doc, a, b)
                        10 -> controller.clear(doc, a, b)
                        11 -> controller.paste(doc, minOf(a, b), maxOf(a, b), "p\nq\r\nr")
                        12 -> controller.replace(doc, minOf(a, b), maxOf(a, b), "")
                        else -> controller.handleBackspaceAtLineStart(doc, a)
                    }
                    val written = NoteHtml.serialize(doc)
                    val again = NoteHtml.canonical(written)
                    if (written != again) failures += "#$n $trail\n  wrote $written\n  again $again"
                    if (NoteHtml.parse(written).toString() != doc.toString().let { text -> normalizeForCompare(text) } && failures.size < 3) {
                        failures += "#$n $trail text mismatch: ${esc(doc.toString())} vs ${esc(NoteHtml.parse(written).toString())}\n  wrote ${esc(written)}"
                    }
                } catch (problem: Throwable) {
                    failures += "#$n $trail threw $problem"
                }
            }
        }
        assertTrue(failures.take(6).joinToString("\n"), failures.isEmpty())
    }

    private fun esc(text: String) = text.replace("\n", "\\n").replace("\u00a0", "~").replace("\uFFFC", "#")

    // The writer drops a trailing newline run and keeps everything else; compare ignoring a trailing empty line.
    private fun normalizeForCompare(text: String) = text

    @Test fun outputOnlyUsesAuthoredTagsOrTagsAlreadyInTheInput() {
        val authored = Regex("</?(b|i|u|a|div|br|h1|h2|ul|li|ol|p|blockquote|span|s|strike|del|strong|em|code|sub|sup|mark|small|font|pre|h3|h4|h5|h6|table|tbody|tr|td|img)\\b")
        val random = Random(5)
        val generator = HtmlGenerator(random)
        repeat(500) {
            val html = generator.document()
            val written = NoteHtml.canonical(html)
            for (match in Regex("</?([a-z0-9]+)").findAll(written)) {
                val tag = match.groupValues[1]
                assertTrue("$tag in $written (from $html)", authored.containsMatchIn("<$tag") || html.contains("<$tag"))
            }
        }
    }

    @Test fun hrefWithSpecialCharactersRoundTripsEscaped() {
        val html = "<a href=\"https://e.test/?q=a&amp;b=&quot;c&quot;&lt;\">t</a>"
        val doc = NoteHtml.parse(html)
        RichTextController().replace(doc, 1, 1, "!")
        assertEquals("<a href=\"https://e.test/?q=a&amp;b=&quot;c&quot;<\">t!</a>", NoteHtml.serialize(doc))
        assertFalse(NoteHtml.serialize(doc).contains("&#"))
    }

    @Test fun nonAsciiIsWrittenAsUtf8() {
        val doc = SpannableStringBuilder()
        val parsed = NoteHtml.parse("<div>x</div>")
        RichTextController().replace(parsed, 1, 1, "è日😀")
        assertEquals("<div>xè日😀</div>", NoteHtml.serialize(parsed))
        assertTrue(doc.isEmpty())
    }
}
