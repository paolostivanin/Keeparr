package dev.keeparr.android.data.html

import android.text.Spannable
import android.text.SpannableStringBuilder
import android.text.Spanned
import org.jsoup.nodes.Comment
import org.jsoup.nodes.DataNode
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.parser.Parser

/**
 * The one codec for note HTML on Android (see docs/note-content-contract.md). It reads the web's dialect into an
 * editable [Spanned] and writes it back the way Chrome's `innerHTML` would, so both clients can edit the same string.
 */
object NoteHtml {
    // ---- the editor document -----------------------------------------------------------------------------

    fun parse(html: String, mode: HtmlMode = HtmlMode.Body): SpannableStringBuilder = build(HtmlParser.parse(html), mode)

    internal fun build(lines: List<ParsedLine>, mode: HtmlMode): SpannableStringBuilder {
        val text = SpannableStringBuilder()
        if (mode == HtmlMode.Row) {
            // A row is one line of inline content: a stray line break becomes a space.
            lines.forEachIndexed { index, line ->
                if (index > 0) text.append(' ')
                val base = text.length
                text.append(line.text)
                addInline(text, base, line)
            }
            return text
        }
        val infos = ArrayList<BlockInfo>(lines.size)
        lines.forEachIndexed { index, line ->
            if (index > 0) text.append('\n')
            val base = text.length
            text.append(line.text)
            addInline(text, base, line)
            infos += line.info
        }
        Doc.applyInfos(text, infos)
        return text
    }

    private fun addInline(text: SpannableStringBuilder, base: Int, line: ParsedLine) {
        for (inline in line.inlines) {
            text.setSpan(InlineTagSpan(inline.tag, inline.attrs, inline.order), base + inline.start, base + inline.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        line.embed?.let { text.setSpan(EmbedSpan(it.html, it), base, base + line.text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
    }

    fun serialize(text: Spanned, mode: HtmlMode = HtmlMode.Body): String =
        if (mode == HtmlMode.Row) StringBuilder().also { writeInline(it, text, 0, text.length) }.toString() else serializeBody(text)

    /** The form a client writes after an edit; `canonical(canonical(x)) == canonical(x)`. */
    fun canonical(html: String, mode: HtmlMode = HtmlMode.Body): String = serialize(parse(html, mode), mode)

    /** What to store for an edited document: the untouched [original] string whenever the edit changed nothing. */
    fun commit(original: String, originalCanonical: String, edited: Spanned, mode: HtmlMode): String {
        val written = serialize(edited, mode)
        return if (written == originalCanonical) original else written
    }

    // ---- writing -----------------------------------------------------------------------------------------

    private class Item(val span: InlineTagSpan, val start: Int, val end: Int)

    internal fun writeInline(out: StringBuilder, text: Spanned, from: Int, to: Int) {
        val items = ArrayList<Item>()
        for (span in text.getSpans(from, to, InlineTagSpan::class.java)) {
            val start = maxOf(text.getSpanStart(span), from)
            val end = minOf(text.getSpanEnd(span), to)
            if (start < end) items += Item(span, start, end)
        }
        if (items.isEmpty()) { writeText(out, text, from, to); return }
        val boundaries = java.util.TreeSet<Int>().apply { add(from); add(to); items.forEach { add(it.start); add(it.end) } }
        val open = ArrayList<Item>()
        var position = from
        for (boundary in boundaries) {
            if (boundary > position) { writeText(out, text, position, boundary); position = boundary }
            val reopen = ArrayList<Item>()
            val lowest = open.indexOfFirst { it.end == boundary }
            if (lowest >= 0) {
                while (open.size > lowest) {
                    val item = open.removeAt(open.size - 1)
                    out.append("</").append(item.span.tag).append('>')
                    if (item.end != boundary) reopen += item
                }
                reopen.reverse()
            }
            val starting = ArrayList<Item>(reopen)
            for (item in items) if (item.start == boundary) starting += item
            starting.sortWith(compareByDescending<Item> { it.end }.thenBy { it.span.order })
            for (item in starting) {
                if (item.span.tag == "a" && open.any { it.span.tag == "a" }) continue
                open += item
                out.append('<').append(item.span.tag)
                appendAttributes(out, item.span.attrs)
                out.append('>')
            }
        }
    }

    private fun writeText(out: StringBuilder, text: Spanned, from: Int, to: Int) {
        var start = from
        for (i in from until to) {
            if (text[i] != EMBED_CHAR) continue
            appendEscapedText(out, text, start, i)
            Doc.embedAt(text, i)?.let { out.append(it.html) }
            start = i + 1
        }
        appendEscapedText(out, text, start, to)
    }

    private fun serializeBody(text: Spanned): String {
        val lines = Doc.lines(text)
        val infos = lines.map { Doc.infoAt(text, it) }
        if (text.isEmpty() && (infos[0] == null || infos[0]!!.let { first -> first.path.all { it.isAnonymous } && !first.trailingBr && !first.placeholderBr })) return ""
        val fallback = Frame(null)
        val resolved = infos.mapIndexed { i, info -> info ?: BlockInfo(listOf(fallback), if (i == 0) BreakKind.BLOCK else BreakKind.BR) }.toMutableList()
        // A whitespace-only run at the very end of the document is not content when read back, so it gets a div of its own.
        val last = lines.last()
        val lastInfo = resolved.last()
        if (last.end > last.start && lastInfo.path.size == 1 && lastInfo.path[0].isAnonymous && (last.start until last.end).all { text[it] == ' ' || text[it] == '\t' || text[it] == '\r' || text[it] == '\u000c' }) {
            resolved[resolved.size - 1] = lastInfo.with(path = listOf(Frame("div")), breakBefore = BreakKind.BLOCK)
        }
        val out = StringBuilder(text.length + 64)
        val open = ArrayList<Frame>()
        var preStart = -1
        fun joins(index: Int): Boolean {
            if (index == 0) return false
            val info = resolved[index]
            val previous = resolved[index - 1]
            val leaf = info.path.lastOrNull() ?: return false
            // Two anonymous runs side by side are one run once written: the tag-less frames leave nothing between them.
            if (leaf.isAnonymous && previous.path.lastOrNull()?.isAnonymous == true && samePath(previous.path.dropLast(1), info.path.dropLast(1))) return true
            return samePath(previous.path, info.path) && !leaf.isEmbed && (info.breakBefore != BreakKind.BLOCK || leaf.isAnonymous)
        }
        for (index in lines.indices) {
            val line = lines[index]
            val info = resolved[index]
            val join = joins(index)
            if (join) {
                if (info.breakBefore == BreakKind.NEWLINE) {
                    // The parser drops one newline right after <pre>, so a leading blank line needs two.
                    if (out.length == preStart) out.append('\n')
                    out.append('\n')
                } else out.append("<br>")
            } else {
                var common = commonPrefix(open, info.path)
                if (index > 0 && samePath(resolved[index - 1].path, info.path)) common = minOf(common, info.path.size - 1)
                while (open.size > common) {
                    val frame = open.removeAt(open.size - 1)
                    frame.tag?.let { out.append("</").append(it).append('>') }
                }
                for (i in common until info.path.size) {
                    val frame = info.path[i]
                    open += frame
                    if (frame.tag != null) { out.append('<').append(frame.tag); appendAttributes(out, frame.attrs); out.append('>') }
                    frame.embedHtml?.let { out.append(it) }
                    if (frame.tag == "pre") preStart = out.length
                }
            }
            if (info.path.lastOrNull()?.isEmbed == true) continue
            writeInline(out, text, line.start, line.end)
            val empty = line.start == line.end
            val lastInLeaf = index == lines.lastIndex || !joins(index + 1)
            val trailing = (info.trailingBr && lastInLeaf && !(info.placeholderBr && !empty)) || (lastInLeaf && empty)
            if (trailing) out.append(if (!join || info.trailingBr || info.breakBefore != BreakKind.NEWLINE) "<br>" else "\n")
        }
        while (open.isNotEmpty()) {
            val frame = open.removeAt(open.size - 1)
            frame.tag?.let { out.append("</").append(it).append('>') }
        }
        return out.toString()
    }

    // ---- reading -----------------------------------------------------------------------------------------

    /** One entry per line (an embed is [EMBED_CHAR]); an empty body has no lines. Offsets and text match the editor. */
    fun lines(html: String): List<String> = HtmlParser.parse(html).map { it.text }

    private val unicodeSpace = Regex("[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")
    private val blockNames = setOf("p", "div", "li", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6")

    /**
     * Same as the web's `splitBodyIntoLines(...).lines`: `<br>` and block elements end a line, whitespace collapses,
     * blank lines are skipped, images and link-preview slots are not text.
     */
    fun nonBlankLines(html: String): List<String> {
        val result = ArrayList<String>()
        val current = StringBuilder()
        fun flush() {
            val text = current.toString().replace('\u00a0', ' ').trim { it.isWhitespace() || it == '\u00a0' || it == '\ufeff' }
            if (text.isNotEmpty()) result += text
            current.setLength(0)
        }
        fun walk(node: Node) {
            when {
                node is TextNode -> current.append(unicodeSpace.replace(node.wholeText, " "))
                node is Comment || node is DataNode -> Unit
                node is Element -> {
                    val tag = node.tagName()
                    when {
                        tag == "script" || tag == "style" -> Unit
                        tag == "img" || node.hasClass("editor-link-preview-slot") -> Unit
                        tag == "br" -> flush()
                        else -> {
                            val block = tag in blockNames
                            if (block) flush()
                            node.childNodes().forEach(::walk)
                            if (block) flush()
                        }
                    }
                }
            }
        }
        Parser.htmlParser().parseFragmentInput(html, Element("body"), "").forEach(::walk)
        flush()
        return result
    }

    /** The visible text, one line per line, without embeds. */
    fun displayText(html: String): String = HtmlParser.parse(html).filter { it.embed == null }.joinToString("\n") { it.text }

    /** Text for search and notifications (the same as [displayText]; tags and entities are gone). */
    fun plainText(html: String): String = displayText(html)

    /** Display text with the markers the editor draws: bullets, numbers, two spaces of indent per level. */
    fun previewText(html: String): String {
        val lines = HtmlParser.parse(html)
        if (lines.isEmpty()) return ""
        val derived = BlockDerivation.derive(lines.map { it.info.path })
        val out = StringBuilder()
        lines.forEachIndexed { index, line ->
            if (out.isNotEmpty() || index > 0) out.append('\n')
            val block = derived[index]
            when {
                line.embed != null -> if (line.embed.kind == EmbedKind.Foreign) out.append('[').append(line.embed.label).append(']')
                block.marker != null -> {
                    repeat(minOf(block.listDepth, MAX_LIST_LEVELS) - 1) { out.append("  ") }
                    out.append(block.marker).append(' ').append(line.text)
                }
                else -> out.append(line.text)
            }
        }
        return out.toString()
    }

    /** True when the body shows text, an image or an atomic embed (nbsp counts as a space). */
    fun hasMeaningfulBody(html: String): Boolean =
        HtmlParser.parse(html).any { it.embed != null || it.text.replace('\u00a0', ' ').isNotBlank() }

    /** Atomic embeds in document order, each as its stored HTML. */
    fun embeds(html: String): List<String> = HtmlParser.parse(html).mapNotNull { it.embed?.html }

    fun firstImageSrc(html: String): String? =
        HtmlParser.parse(html).firstNotNullOfOrNull { line -> line.embed?.takeIf { it.kind == EmbedKind.Image }?.src }

    // ---- titles ------------------------------------------------------------------------------------------

    /** The title as plain text: entities decoded, tags dropped. */
    fun titleText(html: String): String {
        if (html.isEmpty()) return ""
        if (html.indexOf('<') < 0 && html.indexOf('&') < 0) return html
        val out = StringBuilder()
        fun walk(node: Node) {
            when {
                node is TextNode -> out.append(node.wholeText)
                node is Comment || node is DataNode -> Unit
                node is Element -> if (node.tagName() != "script" && node.tagName() != "style") node.childNodes().forEach(::walk)
            }
        }
        Parser.htmlParser().parseFragmentInput(html, Element("body"), "").forEach(::walk)
        return out.toString()
    }

    /** What to store for the edited title; the original string stays when the decoded text did not change. */
    fun titleHtml(text: String, original: String = ""): String =
        if (titleText(original) == text) original else escapeText(text)

    fun escapeText(text: String): String = escapeHtmlText(text)

    /** Shared text becomes HTML: escaped, with line breaks as `<br>`. */
    fun plainTextToHtml(text: String): String = escapeText(text.replace("\r\n", "\n").replace('\r', '\n')).replace("\n", "<br>")
}
