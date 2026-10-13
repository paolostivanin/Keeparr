package dev.keeparr.android.data.html

import android.text.Spannable
import android.text.Spanned

/** One line of an editor document: `[start, end)` excludes the newline. */
internal class LineRange(val start: Int, val end: Int)

/** Reading and rebuilding the structure spans of an editor document. */
internal object Doc {
    fun lines(text: CharSequence): List<LineRange> {
        val result = ArrayList<LineRange>()
        var start = 0
        for (i in text.indices) if (text[i] == '\n') { result += LineRange(start, i); start = i + 1 }
        result += LineRange(start, text.length)
        return result
    }

    fun lineIndexAt(lines: List<LineRange>, offset: Int): Int {
        var low = 0
        var high = lines.size - 1
        while (low < high) {
            val mid = (low + high + 1) ushr 1
            if (lines[mid].start <= offset) low = mid else high = mid - 1
        }
        return low
    }

    /** The structure of the line, from the block span that starts exactly at its start. */
    fun infoAt(text: Spanned, line: LineRange): BlockInfo? = spanAt(text, line)?.info

    fun spanAt(text: Spanned, line: LineRange): BlockSpan? {
        val candidates = text.getSpans(line.start, minOf(line.end + 1, text.length), BlockSpan::class.java)
        var best: BlockSpan? = null
        for (span in candidates) {
            if (text.getSpanStart(span) != line.start) continue
            if (best == null || text.getSpanEnd(span) > text.getSpanEnd(best)) best = span
        }
        return best
    }

    fun embedAt(text: Spanned, offset: Int): EmbedSpan? =
        if (offset in 0 until text.length && text[offset] == EMBED_CHAR) text.getSpans(offset, offset + 1, EmbedSpan::class.java).firstOrNull() else null

    /** Replaces every block span: `infos[i]` becomes the structure of line `i`. Derived fields and heading spans are rebuilt. */
    fun applyInfos(text: Spannable, infos: List<BlockInfo?>) {
        for (span in text.getSpans(0, text.length, BlockSpan::class.java)) text.removeSpan(span)
        val lines = lines(text)
        val spans = ArrayList<BlockSpan>(lines.size)
        lines.forEachIndexed { index, line ->
            val info = infos.getOrNull(index) ?: return@forEachIndexed
            val end = minOf(line.end + 1, text.length)
            val span = BlockSpan(info, markerOnly = end == line.start)
            text.setSpan(span, line.start, end, Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
            spans += span
        }
        BlockDerivation.derive(spans)
        refreshHeadings(text, lines, spans)
    }

    /** Recomputes derived fields and heading render spans without touching which frames each line has. */
    fun refresh(text: Spannable) {
        val lines = lines(text)
        val spans = lines.mapNotNull { spanAt(text, it) }
        BlockDerivation.derive(spans)
        refreshHeadings(text, lines, spans)
    }

    private fun refreshHeadings(text: Spannable, lines: List<LineRange>, spans: List<BlockSpan>) {
        val wanted = ArrayList<Triple<Int, Int, Int>>()
        var cursor = 0
        for (line in lines) {
            val span = spans.getOrNull(cursor)?.takeIf { text.getSpanStart(it) == line.start } ?: continue
            cursor++
            val tag = span.leafTag ?: continue
            if (tag.length == 2 && tag[0] == 'h' && line.end > line.start) wanted += Triple(line.start, line.end, tag[1] - '0')
        }
        val existing = text.getSpans(0, text.length, HeadingSizeSpan::class.java)
        val kept = BooleanArray(wanted.size)
        for (span in existing) {
            val start = text.getSpanStart(span); val end = text.getSpanEnd(span)
            val index = wanted.indexOfFirst { it.first == start && it.second == end && it.third == span.level }
            if (index >= 0 && !kept[index]) kept[index] = true else text.removeSpan(span)
        }
        wanted.forEachIndexed { index, (start, end, level) ->
            if (!kept[index]) text.setSpan(HeadingSizeSpan(level), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    fun inlineSpans(text: Spanned, start: Int, end: Int): List<InlineTagSpan> =
        text.getSpans(start, end, InlineTagSpan::class.java).toList()
}
