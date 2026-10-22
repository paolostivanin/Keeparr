package dev.keeparr.android.data.html

import android.content.res.Resources
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.Spanned
import android.text.TextPaint
import android.text.style.LeadingMarginSpan
import android.text.style.MetricAffectingSpan
import android.text.style.ReplacementSpan

/** Spans that are written back into the note HTML. Everything else (IME composing, pasted platform spans) is ignored. */
interface KeeparrSpan

/** Spans that only change how the editor paints text and are rebuilt after every edit; never serialized. */
interface RenderOnlySpan

private val density get() = Resources.getSystem().displayMetrics.density

/**
 * Block structure of one line, over `[lineStart, lineEnd + 1)`. The derived fields are filled in by [BlockDerivation]
 * after every change so that drawing never walks the document.
 *
 * [markerOnly] is used for an empty last line. Such a zero-length span sits exactly at the end of the previous line, and
 * [android.text.Layout] counts every paragraph span touching a line, so a normal one would add its margin to the previous
 * line too. A marker only records the structure.
 */
class BlockSpan(var info: BlockInfo, var markerOnly: Boolean = false) : LeadingMarginSpan, KeeparrSpan {
    /** Number of lists around the line's item; 0 when the line is not inside a list item. */
    var listDepth = 0
    var quoteDepth = 0
    var ordinal: Int? = null
    /** Bullet glyph or `n.`; null for continuation lines, stray text in a list and everything that is not an item. */
    var marker: String? = null
    /** Tag that decides the line's look: the nearest heading, else the leaf tag. */
    var leafTag: String? = null

    private val step get() = 20 * density
    private val quoteStep get() = 12 * density

    private fun margin(): Float = quoteDepth * quoteStep + (if (listDepth > 0) step * minOf(listDepth, MAX_LIST_LEVELS) else 0f)

    /** Also used by the editor for a final empty paragraph, which Android's Layout skips. */
    internal val contentInset: Int get() = margin().toInt()

    override fun getLeadingMargin(first: Boolean): Int = if (markerOnly) 0 else contentInset

    override fun drawLeadingMargin(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int,
        text: CharSequence, start: Int, end: Int, first: Boolean, layout: Layout?) {
        if (text !is Spanned || markerOnly) return
        val owns = text.getSpanStart(this) == start
        drawDecoration(c, p, x, dir, top, baseline, bottom, owns && first)
    }

    internal fun drawDecoration(c: Canvas, p: Paint, x: Int, dir: Int, top: Int, baseline: Int, bottom: Int,
        drawMarker: Boolean = true) {
        if (quoteDepth > 0) {
            val saved = p.style; val color = p.color; val alpha = p.alpha
            p.style = Paint.Style.FILL; p.alpha = 90
            for (level in 0 until quoteDepth) {
                val left = x + dir * (level * quoteStep + 2 * density)
                val right = left + dir * 3 * density
                c.drawRect(minOf(left, right), top.toFloat(), maxOf(left, right), bottom.toFloat(), p)
            }
            p.style = saved; p.color = color; p.alpha = alpha
        }
        val glyph = marker ?: return
        if (!drawMarker) return
        val itemLeft = x + dir * (quoteDepth * quoteStep + step * (minOf(listDepth, MAX_LIST_LEVELS) - 1))
        val numbered = ordinal != null
        val offset = if (numbered) (step - 4 * density - p.measureText(glyph)).coerceAtLeast(0f) else 6 * density
        c.drawText(glyph, itemLeft + dir * offset, baseline.toFloat(), p)
    }
}

class DerivedBlock(val listDepth: Int, val quoteDepth: Int, val ordinal: Int?, val marker: String?, val leafTag: String?)

/** Computes list depth, quote depth, markers and numbering for the lines of a document, in line order. */
internal object BlockDerivation {
    fun derive(paths: List<List<Frame>>): List<DerivedBlock> {
        val seenItems = java.util.IdentityHashMap<Frame, Boolean>()
        val counters = ArrayList<Pair<Frame, IntArray>>()
        val result = ArrayList<DerivedBlock>(paths.size)
        for (path in paths) {
            var itemIndex = -1
            for (i in path.indices.reversed()) if (path[i].tag == "li") { itemIndex = i; break }
            val quoteDepth = path.count { it.isQuote }
            val leafTag = path.lastOrNull { it.tag != null && it.tag.length == 2 && it.tag[0] == 'h' && it.tag[1] in '1'..'6' }?.tag
                ?: path.lastOrNull { !it.isAnonymous && !it.isEmbed }?.tag
            // Keep the counters of the lists this line is still inside; lists that closed start over if they reopen.
            val lists = path.filter { it.isList }
            var keep = 0
            while (keep < counters.size && keep < lists.size && counters[keep].first === lists[keep]) keep++
            while (counters.size > keep) counters.removeAt(counters.size - 1)
            for (i in keep until lists.size) {
                val start = lists[i].attrs.firstOrNull { it.name == "start" }?.value?.trim()?.toIntOrNull() ?: 1
                counters += lists[i] to intArrayOf(start - 1)
            }
            if (itemIndex < 0) { result += DerivedBlock(0, quoteDepth, null, null, leafTag); continue }
            val enclosing = path.subList(0, itemIndex).filter { it.isList }
            val depth = maxOf(1, enclosing.size)
            var ordinal: Int? = null
            var marker: String? = null
            if (seenItems.put(path[itemIndex], true) == null) {
                val parent = enclosing.lastOrNull()
                val counter = parent?.let { list -> counters.firstOrNull { it.first === list }?.second }
                if (counter != null) counter[0]++
                if (parent?.tag == "ol") {
                    ordinal = counter?.get(0)
                    marker = "$ordinal."
                } else {
                    marker = LIST_GLYPHS[(minOf(depth, MAX_LIST_LEVELS) - 1).coerceAtLeast(0)]
                }
            }
            result += DerivedBlock(depth, quoteDepth, ordinal, marker, leafTag)
        }
        return result
    }

    fun derive(spans: List<BlockSpan>) {
        val derived = derive(spans.map { it.info.path })
        spans.forEachIndexed { i, span ->
            val d = derived[i]
            span.listDepth = d.listDepth; span.quoteDepth = d.quoteDepth; span.ordinal = d.ordinal
            span.marker = d.marker; span.leafTag = d.leafTag
        }
    }
}

private fun parseCssNumber(style: String, name: String): String? =
    Regex("(?:^|;)\\s*$name\\s*:\\s*([^;]+)", RegexOption.IGNORE_CASE).find(style)?.groupValues?.get(1)?.trim()

/** Draws an inline element (`b`, `i`, `a`, `span style=...`, ...) the way the web does. Serialized with its tag and attributes. */
class InlineTagSpan(val tag: String, val attrs: List<HtmlAttr>, val order: Int) : MetricAffectingSpan(), KeeparrSpan {
    private val style = attrs.firstOrNull { it.name == "style" }?.value.orEmpty()
    val bold: Boolean? = run {
        val weight = parseCssNumber(style, "font-weight")?.lowercase()
        when {
            weight != null -> weight == "bold" || weight == "bolder" || (weight.toIntOrNull() ?: 0) >= 600
            tag == "b" || tag == "strong" -> true
            else -> null
        }
    }
    val explicitNormalWeight: Boolean = parseCssNumber(style, "font-weight")?.lowercase().let { w ->
        w != null && w != "bold" && w != "bolder" && (w.toIntOrNull() ?: 0) < 600
    }
    val italic = tag == "i" || tag == "em" || tag == "cite" || parseCssNumber(style, "font-style")?.lowercase() == "italic"
    private val decoration = parseCssNumber(style, "text-decoration")?.lowercase().orEmpty()
    val underline = tag == "u" || tag == "ins" || tag == "a" || decoration.contains("underline")
    val strike = tag == "s" || tag == "strike" || tag == "del" || decoration.contains("line-through")
    private val mono = tag == "code" || tag == "tt" || tag == "kbd" || tag == "samp"
    val link = tag == "a"
    private val color: Int? = (parseCssNumber(style, "color") ?: attrs.firstOrNull { tag == "font" && it.name == "color" }?.value)?.let(::parseColor)

    private fun apply(paint: TextPaint, drawing: Boolean) {
        if (explicitNormalWeight || bold == true || italic || mono) {
            val base = paint.typeface ?: Typeface.DEFAULT
            val weight = when {
                bold == true -> 700
                explicitNormalWeight -> 400
                else -> if (base.isBold) base.weight else 400
            }
            paint.typeface = if (mono) Typeface.create(Typeface.MONOSPACE, weight, italic || base.isItalic)
                else Typeface.create(base, weight, italic || base.isItalic)
        }
        when (tag) {
            "sub" -> { paint.textSize = paint.textSize * 0.8f; paint.baselineShift += (paint.textSize * 0.2f).toInt() }
            "sup" -> { paint.textSize = paint.textSize * 0.8f; paint.baselineShift -= (paint.textSize * 0.4f).toInt() }
            "small" -> paint.textSize = paint.textSize * 0.85f
            "big" -> paint.textSize = paint.textSize * 1.2f
        }
        if (!drawing) return
        if (underline) paint.isUnderlineText = true
        if (strike) paint.isStrikeThruText = true
        if (link) paint.color = paint.linkColor.takeIf { it != 0 } ?: paint.color
        color?.let { paint.color = it }
        if (tag == "mark") paint.bgColor = 0x66FFEB3B
    }

    override fun updateMeasureState(textPaint: TextPaint) = apply(textPaint, false)
    override fun updateDrawState(textPaint: TextPaint) = apply(textPaint, true)

    fun copySpan(order: Int = this.order, attrs: List<HtmlAttr> = this.attrs) = InlineTagSpan(tag, attrs, order)

    fun sameElement(other: InlineTagSpan) = tag == other.tag && attrs == other.attrs

    companion object {
        private val named = mapOf("red" to 0xFFFF0000.toInt(), "blue" to 0xFF0000FF.toInt(), "green" to 0xFF008000.toInt(),
            "black" to 0xFF000000.toInt(), "white" to 0xFFFFFFFF.toInt(), "gray" to 0xFF808080.toInt(), "grey" to 0xFF808080.toInt(),
            "orange" to 0xFFFFA500.toInt(), "purple" to 0xFF800080.toInt(), "yellow" to 0xFFFFFF00.toInt())

        fun parseColor(value: String): Int? {
            val text = value.trim().lowercase()
            named[text]?.let { return it }
            if (text.startsWith("#")) {
                val hex = text.substring(1)
                val expanded = if (hex.length == 3) hex.map { "$it$it" }.joinToString("") else hex
                if (expanded.length == 6) return expanded.toLongOrNull(16)?.let { (0xFF000000 or it).toInt() }
                return null
            }
            val match = Regex("rgba?\\(\\s*(\\d+)[ ,]+(\\d+)[ ,]+(\\d+)").find(text) ?: return null
            val (r, g, b) = match.destructured
            val red = r.toIntOrNull()?.coerceIn(0, 255) ?: return null
            val green = g.toIntOrNull()?.coerceIn(0, 255) ?: return null
            val blue = b.toIntOrNull()?.coerceIn(0, 255) ?: return null
            return (0xFF shl 24) or (red shl 16) or (green shl 8) or blue
        }

        /** Removes one CSS property from a style string; null when nothing else is left. */
        fun withoutStyleProperty(style: String, property: String): String? {
            val kept = style.split(';').map { it.trim() }.filter { it.isNotEmpty() && !it.substringBefore(':').trim().equals(property, ignoreCase = true) }
            return if (kept.isEmpty()) null else kept.joinToString("; ") + ";"
        }
    }
}

/** Heading size and weight (web: `src/styles.scss:671-688`). Rebuilt after every edit. */
class HeadingSizeSpan(val level: Int) : MetricAffectingSpan(), RenderOnlySpan {
    private fun apply(paint: TextPaint) {
        val scale = when (level) { 1 -> 1.543f; 2 -> 1.234f; 3 -> 1.15f; else -> 1.0f }
        paint.textSize = paint.textSize * scale
        val weight = if (level <= 2) 600 else 700
        paint.typeface = Typeface.create(paint.typeface ?: Typeface.DEFAULT, weight, paint.typeface?.isItalic == true)
    }
    override fun updateMeasureState(textPaint: TextPaint) = apply(textPaint)
    override fun updateDrawState(textPaint: TextPaint) = apply(textPaint)
}

/** An atomic embed on its own line: drawn as an image or a labelled card, written back verbatim. */
class EmbedSpan(val html: String, val data: EmbedData) : ReplacementSpan(), KeeparrSpan {
    /** Decoded image once the binder has loaded it. */
    @Volatile var bitmap: Bitmap? = null
    /** Width of the text area, set by the view; 0 until the first layout. */
    var maxWidth = 0
    /** Aspect ratio (width / height) remembered for the image, used before the bitmap is there. */
    var ratio = 4f / 3f
    var maxHeight = (360 * density).toInt()
    private val cardHeight get() = (56 * density).toInt()

    fun heightPx(width: Int): Int {
        if (data.kind != EmbedKind.Image) return cardHeight
        val bitmap = bitmap
        val actual = if (bitmap != null && bitmap.width > 0) bitmap.width.toFloat() / bitmap.height else ratio
        return (width / actual).toInt().coerceIn(1, maxHeight)
    }

    private fun drawWidth(): Int = if (maxWidth > 0) maxWidth else (240 * density).toInt()

    /** Bitmap bounds after the height cap is applied; drawing and touch handling share this geometry. */
    fun imageBounds(area: RectF): RectF {
        val bitmap = bitmap ?: return area
        if (bitmap.width <= 0 || bitmap.height <= 0) return area
        val width = area.width()
        val height = area.height()
        val scale = minOf(width / bitmap.width, height / bitmap.height)
        val fittedWidth = bitmap.width * scale
        val fittedHeight = bitmap.height * scale
        return RectF(area.left, area.top, area.left + fittedWidth, area.top + fittedHeight)
    }

    override fun getSize(paint: Paint, text: CharSequence?, start: Int, end: Int, fm: Paint.FontMetricsInt?): Int {
        val height = heightPx(drawWidth())
        if (fm != null) { fm.ascent = -height; fm.top = -height; fm.descent = 0; fm.bottom = 0 }
        return drawWidth()
    }

    override fun draw(canvas: Canvas, text: CharSequence?, start: Int, end: Int, x: Float, top: Int, y: Int, bottom: Int, paint: Paint) {
        val width = drawWidth()
        val height = heightPx(width)
        val area = RectF(x, (y - height).toFloat(), x + width, y.toFloat())
        val saved = Paint(paint)
        val bitmap = bitmap
        if (data.kind == EmbedKind.Image && bitmap != null && bitmap.width > 0) {
            val target = imageBounds(area)
            canvas.drawBitmap(bitmap, null, target, null)
            drawRemoveHandle(canvas, target, paint)
        } else {
            paint.style = Paint.Style.STROKE; paint.strokeWidth = density; paint.alpha = 120
            canvas.drawRoundRect(area, 8 * density, 8 * density, paint)
            paint.style = Paint.Style.FILL; paint.alpha = 255
            val label = if (data.kind == EmbedKind.Image) "Image" else data.label
            val subtitle = if (data.kind == EmbedKind.Image) data.alt else data.preview
            paint.isFakeBoldText = true
            canvas.drawText(label, area.left + 12 * density, area.top + 22 * density, paint)
            paint.isFakeBoldText = false
            if (subtitle.isNotEmpty()) {
                val room = width - 24 * density
                val shown = paint.breakText(subtitle, true, room, null).let { count -> if (count < subtitle.length) subtitle.take(count) + "…" else subtitle }
                paint.alpha = 160
                canvas.drawText(shown, area.left + 12 * density, area.top + 44 * density, paint)
            }
        }
        paint.set(saved)
    }

    /** The corner handle that removes the image; the view hit-tests [removeHandle]. */
    fun removeHandle(area: RectF): RectF {
        val size = 36 * density
        return RectF(area.right - size, area.top, area.right, area.top + size)
    }

    private fun drawRemoveHandle(canvas: Canvas, target: RectF, paint: Paint) {
        val handle = removeHandle(target)
        val saved = Paint(paint)
        paint.style = Paint.Style.FILL; paint.color = 0xAA000000.toInt()
        canvas.drawCircle(handle.centerX(), handle.centerY(), 12 * density, paint)
        paint.color = 0xFFFFFFFF.toInt(); paint.strokeWidth = 2 * density; paint.style = Paint.Style.STROKE
        val r = 5 * density
        canvas.drawLine(handle.centerX() - r, handle.centerY() - r, handle.centerX() + r, handle.centerY() + r, paint)
        canvas.drawLine(handle.centerX() - r, handle.centerY() + r, handle.centerX() + r, handle.centerY() - r, paint)
        paint.set(saved)
    }
}
