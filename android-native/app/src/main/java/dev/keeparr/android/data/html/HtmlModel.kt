package dev.keeparr.android.data.html

import java.util.concurrent.atomic.AtomicLong

/** The character that stands for an atomic embed in editor text. */
const val EMBED_CHAR = '\uFFFC'

enum class HtmlMode { Body, Row }

data class HtmlAttr(val name: String, val value: String)

private val frameIds = AtomicLong()

/**
 * One element of a line's ancestry. [tag] is null for an anonymous run (bare text between blocks, which writes no tag);
 * [embedHtml] marks an atomic embed, which is written back verbatim. Frames are compared by identity: lines that share a
 * frame instance share the element in the written HTML.
 */
class Frame(val tag: String?, val attrs: List<HtmlAttr> = emptyList(), val embedHtml: String? = null) {
    val id = frameIds.incrementAndGet()
    val isAnonymous get() = tag == null && embedHtml == null
    val isEmbed get() = embedHtml != null
    val isList get() = tag == "ul" || tag == "ol"
    val isQuote get() = tag == "blockquote"
    fun copy() = Frame(tag, attrs, embedHtml)
    override fun toString() = "Frame(${tag ?: if (isEmbed) "embed" else "anon"}#$id)"
}

enum class BreakKind { BR, NEWLINE, BLOCK }

/** The block structure of one line. [path] runs from the root to the leaf frame. */
class BlockInfo(
    val path: List<Frame>,
    val breakBefore: BreakKind = BreakKind.BLOCK,
    val trailingBr: Boolean = false,
    val placeholderBr: Boolean = false
) {
    val leaf: Frame? get() = path.lastOrNull()
    fun with(path: List<Frame> = this.path, breakBefore: BreakKind = this.breakBefore, trailingBr: Boolean = this.trailingBr,
        placeholderBr: Boolean = this.placeholderBr) = BlockInfo(path, breakBefore, trailingBr, placeholderBr)
}

/** An inline element clipped to one line; [start] and [end] are relative to the line. */
class InlineSpec(val tag: String, val attrs: List<HtmlAttr>, val start: Int, val end: Int, val order: Int)

enum class EmbedKind { Image, Foreign }

class EmbedData(val html: String, val kind: EmbedKind, val src: String, val alt: String, val label: String, val preview: String)

class ParsedLine(val info: BlockInfo, val text: String, val inlines: List<InlineSpec>, val embed: EmbedData?)

internal fun samePath(a: List<Frame>, b: List<Frame>): Boolean {
    if (a.size != b.size) return false
    for (i in a.indices) if (a[i] !== b[i]) return false
    return true
}

internal fun commonPrefix(a: List<Frame>, b: List<Frame>): Int {
    val limit = minOf(a.size, b.size)
    var i = 0
    while (i < limit && a[i] === b[i]) i++
    return i
}

internal val LIST_GLYPHS = listOf("•", "◦", "▪", "▫")
internal const val MAX_LIST_LEVELS = 4

internal val INLINE_STYLE_TAGS = setOf("b", "strong", "i", "em", "u", "s", "strike", "del", "ins")

/** Escapes text as Chrome's innerHTML does: `&`, `<`, `>` and U+00A0 only. */
fun escapeHtmlText(text: CharSequence): String {
    val out = StringBuilder(text.length + 8)
    appendEscapedText(out, text, 0, text.length)
    return out.toString()
}

internal fun appendEscapedText(out: StringBuilder, text: CharSequence, start: Int, end: Int) {
    for (i in start until end) when (val c = text[i]) {
        '&' -> out.append("&amp;")
        '<' -> out.append("&lt;")
        '>' -> out.append("&gt;")
        '\u00a0' -> out.append("&nbsp;")
        else -> out.append(c)
    }
}

internal fun appendAttributes(out: StringBuilder, attrs: List<HtmlAttr>) {
    for (attr in attrs) {
        out.append(' ').append(attr.name).append("=\"")
        for (c in attr.value) when (c) {
            '&' -> out.append("&amp;")
            '"' -> out.append("&quot;")
            else -> out.append(c)
        }
        out.append('"')
    }
}
