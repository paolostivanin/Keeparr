package dev.keeparr.android.data

import android.content.res.Resources
import android.graphics.Canvas
import android.graphics.Paint
import android.text.Layout
import android.text.Spannable
import android.text.Spanned
import android.text.style.LeadingMarginSpan

const val MAX_BULLET_LEVELS = 4

/** Paragraph span marking a line as a bullet at [level] (0 until [MAX_BULLET_LEVELS]). */
class BulletLevelSpan(val level: Int) : LeadingMarginSpan {
    private val density get() = Resources.getSystem().displayMetrics.density
    private val step get() = 20 * density

    override fun getLeadingMargin(first: Boolean): Int = (step * (level + 1)).toInt()

    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int,
        text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        if (text !is Spanned || text.getSpanStart(this) != start) return
        c.drawText(GLYPHS[level.coerceIn(0, GLYPHS.lastIndex)], x + dir * (step * level + 6 * density), baseline.toFloat(), p)
    }

    companion object { val GLYPHS = listOf("\u2022", "\u25E6", "\u25AA", "\u25AB") }
}

object Bullets {
    /** [start, end) of every line; end excludes the newline. A trailing newline yields a final empty line. */
    fun lines(text: CharSequence): List<IntArray> {
        val result = mutableListOf<IntArray>()
        var start = 0
        for (i in text.indices) if (text[i] == '\n') { result += intArrayOf(start, i); start = i + 1 }
        result += intArrayOf(start, text.length)
        return result
    }

    /** Level of the bullet whose span starts within the line, or null. */
    fun levelOf(text: Spannable, start: Int, end: Int): Int? =
        text.getSpans(start, end, BulletLevelSpan::class.java).filter { text.getSpanStart(it) in start..end }
            .minByOrNull { text.getSpanStart(it) }?.level

    fun levels(text: Spannable): List<Int?> = lines(text).map { levelOf(text, it[0], it[1]) }

    /** Replaces every bullet span so that each bulleted line has exactly one, covering the line and its newline. */
    fun apply(text: Spannable, levels: List<Int?>) {
        text.getSpans(0, text.length, BulletLevelSpan::class.java).forEach(text::removeSpan)
        var previous: Int? = null
        lines(text).forEachIndexed { index, line ->
            val raw = levels.getOrNull(index)
            // Never nest deeper than one level below the previous bullet line.
            val level = raw?.let { minOf(it.coerceIn(0, MAX_BULLET_LEVELS - 1), (previous ?: -1) + 1) }
            if (level != null) text.setSpan(BulletLevelSpan(level), line[0], minOf(line[1] + 1, text.length), Spanned.SPAN_INCLUSIVE_EXCLUSIVE)
            previous = level
        }
    }
}
