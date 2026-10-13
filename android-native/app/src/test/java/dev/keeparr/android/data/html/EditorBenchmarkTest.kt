package dev.keeparr.android.data.html

import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Parse + edit + serialize of a 50 KB body. The medians are printed; the bounds are loose because a JVM is not a phone. */
@RunWith(RobolectricTestRunner::class)
class EditorBenchmarkTest {
    @Test fun aFiftyKilobyteBodyParsesEditsAndSerializesQuickly() {
        val html = buildString {
            var n = 0
            while (length < 50_000) {
                append("<div>Line ${n++} with <b>bold</b>, <i>italic</i> and a <a href=\"https://e.test/$n\">link</a></div>")
                if (n % 7 == 0) append("<ul><li>item a</li><li>item b<ul><li>nested</li></ul></li></ul>")
                if (n % 11 == 0) append("<h2>Heading $n</h2>")
            }
        }
        val controller = RichTextController()
        val samples = ArrayList<Long>()
        repeat(15) {
            val start = System.nanoTime()
            val doc = NoteHtml.parse(html)
            controller.replace(doc, doc.length / 2, doc.length / 2, "x")
            NoteHtml.serialize(doc)
            samples += (System.nanoTime() - start) / 1_000
        }
        val warmed = samples.drop(5).sorted()
        val median = warmed[warmed.size / 2]
        println("BENCH parse+edit+serialize of ${html.length} chars: median ${median / 1000.0} ms")
        assertTrue("median $median us", median < 400_000)
        // One keystroke in a large document that is already open.
        val doc = NoteHtml.parse(html)
        val keys = ArrayList<Long>()
        repeat(60) { i ->
            val start = System.nanoTime()
            controller.replace(doc, doc.length / 2 + i, doc.length / 2 + i, "k")
            NoteHtml.serialize(doc)
            keys += (System.nanoTime() - start) / 1_000
        }
        val keyMedian = keys.sorted()[keys.size / 2]
        println("BENCH one keystroke (edit + serialize) in ${html.length} chars: median ${keyMedian / 1000.0} ms")
        assertTrue("keystroke median $keyMedian us", keyMedian < 100_000)
    }
}
