package dev.keeparr.android.data.html

import org.jsoup.nodes.Comment
import org.jsoup.nodes.DataNode
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.jsoup.parser.Parser

/**
 * Reads a note body into lines: one [ParsedLine] per visible line, each with its element ancestry ([BlockInfo]) and the
 * inline elements clipped to it. Whitespace is never collapsed: bodies render with `white-space: pre-wrap`, so a raw
 * newline is a line break and spaces are content. Parsing never throws.
 */
internal object HtmlParser {
    private val embedTags = setOf("table", "hr", "img", "video", "audio", "iframe", "object", "embed", "canvas", "svg", "figure", "picture")
    private val containerTags = setOf("ul", "ol", "blockquote")
    private val blockTags = setOf(
        "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "li", "ul", "ol", "blockquote", "section", "article", "aside",
        "header", "footer", "nav", "main", "address", "details", "summary", "dl", "dt", "dd", "fieldset", "form", "center",
        "hgroup", "menu", "dir", "legend"
    )
    private val voidTags = setOf("area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr")
    private val skippedTags = setOf("script", "style", "template", "head", "title", "meta", "link", "base", "noscript")
    private val legacyParagraph = setOf(HtmlAttr("dir", "ltr"), HtmlAttr("style", "margin-top:0; margin-bottom:0;"))

    fun isEmbedElement(element: Element) = element.tagName() in embedTags || element.attr("contenteditable").equals("false", ignoreCase = true)

    fun parse(html: String): List<ParsedLine> = try {
        Run(html).run()
    } catch (problem: RuntimeException) {
        // A parser failure must never lose or block a note: show the visible text as plain lines.
        html.replace(Regex("<[^>]*>"), "").split(Regex("\r\n?|\n")).filter { it.isNotEmpty() }.map {
            ParsedLine(BlockInfo(listOf(Frame(null))), it.replace(EMBED_CHAR.toString(), ""), emptyList(), null)
        }
    }

    private class OpenInline(val tag: String, val attrs: List<HtmlAttr>, val order: Int, var start: Int)

    private class LineBuilder(val breakBefore: BreakKind) {
        val text = StringBuilder()
        val inlines = ArrayList<InlineSpec>()
        var trailingBr = false
        var placeholder = false
    }

    private class Run(val source: String) {
        val out = ArrayList<ParsedLine>()
        var order = 0

        fun run(): List<ParsedLine> {
            val nodes = Parser.htmlParser().setTrackPosition(true).parseFragmentInput(source, Element("body"), "").toMutableList()
            // Trailing whitespace-only runs (a final newline after the last block) are not content.
            while (nodes.isNotEmpty()) {
                val last = nodes.last()
                val droppable = last is Comment || last is DataNode || (last is TextNode && last.wholeText.all { it == ' ' || it == '\t' || it == '\n' || it == '\r' || it == '\u000c' })
                if (!droppable) break
                nodes.removeAt(nodes.size - 1)
            }
            children(nodes, emptyList())
            return out
        }

        fun attrsOf(element: Element) = element.attributes().map { HtmlAttr(it.key, it.value) }

        fun isEmbed(element: Element) = isEmbedElement(element)

        fun isBlock(element: Element) = element.tagName() in blockTags

        fun skipped(node: Node) = node is Comment || node is DataNode || (node is Element && node.tagName() in skippedTags)

        fun hasBlockChild(element: Element): Boolean = element.children().any { isEmbed(it) || isBlock(it) || (!skipped(it) && hasBlockChild(it)) }

        fun children(nodes: List<Node>, path: List<Frame>) {
            var run = ArrayList<Node>()
            fun flush() {
                if (run.isEmpty()) return
                leaf(run, path + Frame(null), keepEmpty = false)
                run = ArrayList()
            }
            for (node in nodes) {
                when {
                    skipped(node) -> Unit
                    node is Element && isEmbed(node) -> { flush(); embed(node, path) }
                    node is Element && (isBlock(node) || hasBlockChild(node)) -> { flush(); block(node, path) }
                    else -> run.add(node)
                }
            }
            flush()
        }

        fun block(element: Element, path: List<Frame>) {
            val tag = element.tagName()
            val attrs = attrsOf(element)
            val legacy = tag == "p" && attrs.size == 2 && attrs.toSet() == legacyParagraph
            val frame = if (legacy) Frame("div") else Frame(tag, attrs)
            val nodes = element.childNodes()
            if (tag in containerTags || hasBlockChild(element)) children(nodes, path + frame)
            else leaf(nodes, path + frame, keepEmpty = tag == "li")
        }

        fun embed(element: Element, path: List<Frame>) {
            val html = outerSource(element)
            val data = describeEmbed(element, html)
            out += ParsedLine(BlockInfo(path + Frame(null, emptyList(), html)), EMBED_CHAR.toString(), emptyList(), data)
        }

        /** The element exactly as it was written, falling back to a Chrome-style serialization. */
        fun outerSource(element: Element): String {
            val start = element.sourceRange()
            val end = if (element.tagName() in voidTags) start else element.endSourceRange()
            if (start.isTracked && end.isTracked && start.startPos() in 0..end.endPos() && end.endPos() <= source.length) {
                return source.substring(start.startPos(), end.endPos())
            }
            return StringBuilder().also { writeElement(it, element) }.toString()
        }

        fun writeNode(sb: StringBuilder, node: Node) {
            when (node) {
                is TextNode -> appendEscapedText(sb, node.wholeText, 0, node.wholeText.length)
                is Element -> writeElement(sb, node)
                else -> Unit
            }
        }

        fun writeElement(sb: StringBuilder, element: Element) {
            sb.append('<').append(element.tagName())
            appendAttributes(sb, attrsOf(element))
            sb.append('>')
            if (element.tagName() in voidTags) return
            element.childNodes().forEach { writeNode(sb, it) }
            sb.append("</").append(element.tagName()).append('>')
        }

        fun describeEmbed(element: Element, html: String): EmbedData {
            val image = when {
                element.tagName() == "img" -> element
                element.hasClass("inline-note-image-wrap") -> element.selectFirst("img")
                else -> null
            }
            if (image != null && image.attr("src").isNotBlank()) {
                return EmbedData(html, EmbedKind.Image, image.attr("src"), image.attr("alt"), "Image", "")
            }
            val label = when (element.tagName()) {
                "table" -> "Table"; "hr" -> "Divider"; "video" -> "Video"; "audio" -> "Audio"; "iframe" -> "Embedded frame"
                "object", "embed" -> "Object"; "canvas" -> "Canvas"; "svg" -> "Drawing"; "figure", "picture" -> "Figure"
                "img" -> "Image"
                else -> "Embedded content"
            }
            val preview = element.wholeText().replace(Regex("\\s+"), " ").trim().take(120)
            return EmbedData(html, EmbedKind.Foreign, "", "", label, preview)
        }

        // ---- inline runs -------------------------------------------------------------------------------------

        fun leaf(nodes: List<Node>, path: List<Frame>, keepEmpty: Boolean) {
            val lines = ArrayList<LineBuilder>()
            var current = LineBuilder(BreakKind.BLOCK)
            lines += current
            val open = ArrayList<OpenInline>()

            fun closeOpen(into: LineBuilder) {
                for (inline in open) if (current.text.length > inline.start) {
                    into.inlines += InlineSpec(inline.tag, inline.attrs, inline.start, current.text.length, inline.order)
                }
            }
            fun newLine(kind: BreakKind) {
                closeOpen(current)
                current = LineBuilder(kind)
                lines += current
                for (inline in open) inline.start = 0
            }
            fun appendText(raw: String) {
                val text = raw.replace("\r\n", "\n").replace('\r', '\n').replace(EMBED_CHAR.toString(), "")
                for (c in text) if (c == '\n') newLine(BreakKind.NEWLINE) else current.text.append(c)
            }
            fun walk(node: Node) {
                when {
                    skipped(node) -> Unit
                    node is TextNode -> appendText(node.wholeText)
                    node is Element && node.tagName() == "br" -> newLine(BreakKind.BR)
                    node is Element -> {
                        val inline = OpenInline(node.tagName(), attrsOf(node), order++, current.text.length)
                        open += inline
                        node.childNodes().forEach(::walk)
                        open.removeAt(open.size - 1)
                        if (current.text.length > inline.start) {
                            current.inlines += InlineSpec(inline.tag, inline.attrs, inline.start, current.text.length, inline.order)
                        }
                    }
                }
            }
            nodes.forEach(::walk)

            // A trailing <br> ends the last line without starting another; a trailing raw newline adds nothing.
            fun dropTrailingBr() {
                val last = lines.last()
                if (lines.size > 1 && last.text.isEmpty() && last.breakBefore == BreakKind.BR) {
                    lines.removeAt(lines.size - 1); lines.last().trailingBr = true
                }
            }
            var terminated = false
            if (lines.size > 1 && lines.last().text.isEmpty() && lines.last().breakBefore == BreakKind.NEWLINE) { lines.removeAt(lines.size - 1); terminated = true }
            dropTrailingBr()
            var linePath = path
            if (lines.size == 1 && lines[0].text.isEmpty()) {
                if (!lines[0].trailingBr && !keepEmpty && !terminated) return
                lines[0].placeholder = lines[0].trailingBr || keepEmpty
                // A newline that only separates blocks is a blank line, written as <div><br></div>.
                if (terminated && path.last().isAnonymous) linePath = path.dropLast(1) + Frame("div")
            }
            lines.forEachIndexed { index, line ->
                val info = BlockInfo(linePath, line.breakBefore, line.trailingBr, line.placeholder && index == 0)
                out += ParsedLine(info, line.text.toString(), line.inlines, null)
            }
        }
    }
}
