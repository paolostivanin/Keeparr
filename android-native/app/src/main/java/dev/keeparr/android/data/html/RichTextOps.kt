package dev.keeparr.android.data.html

import android.text.Editable
import android.text.Selection
import android.text.Spannable
import android.text.Spanned

enum class EditCause { Typed, Paste }

/**
 * The editing rules of the note editor (docs/note-content-contract.md section 4), as pure logic over an [Editable]
 * that carries [BlockSpan]s and [InlineTagSpan]s. A view feeds it every text change ([capture] before, [afterChange]
 * after); tests and key handlers call the higher level operations such as [replace], [handleEnter] and [toggleInline].
 *
 * In [HtmlMode.Row] there are no blocks: block commands do nothing and a typed or pasted line break is reported to
 * [onSplit] as the row html on its left and the html of the rows that follow.
 */
class RichTextController(val mode: HtmlMode = HtmlMode.Body) {
    var onSplit: ((left: String, rest: List<String>) -> Unit)? = null

    /** True while the controller itself edits the document, so a text watcher can ignore the resulting callbacks. */
    var isApplying = false
        private set

    private val pending = LinkedHashMap<String, Boolean>()
    private var expectedCaret = -1

    class Snapshot internal constructor(internal val lines: List<LineRange>, internal val infos: List<BlockInfo?>,
        internal val lo: Int, internal val hi: Int, internal val inherit: List<InlineTagSpan>)

    // ---- text changes ------------------------------------------------------------------------------------

    /** Records what the change at `[start, end)` needs to know about the document before it is applied. */
    fun capture(text: Spanned, start: Int, end: Int): Snapshot {
        val lo = minOf(start, end).coerceIn(0, text.length)
        val hi = maxOf(start, end).coerceIn(0, text.length)
        val lines = if (mode == HtmlMode.Body) Doc.lines(text) else emptyList()
        val infos = if (mode == HtmlMode.Body) lines.map { Doc.infoAt(text, it) } else emptyList()
        return Snapshot(lines, infos, lo, hi, sourceSpans(text, lo, hi))
    }

    private fun sourceSpans(text: Spanned, lo: Int, hi: Int): List<InlineTagSpan> {
        val source = when {
            hi > lo -> lo
            lo > 0 && text[lo - 1] != '\n' -> lo - 1
            lo < text.length && text[lo] != '\n' -> lo
            else -> return emptyList()
        }
        if (source >= text.length || text[source] == '\n' || text[source] == EMBED_CHAR) return emptyList()
        return text.getSpans(source, source + 1, InlineTagSpan::class.java).filter { text.getSpanStart(it) <= source && text.getSpanEnd(it) > source }
    }

    /** Replaces `[start, end)` with [insert] and applies the editing rules. */
    fun replace(text: Editable, start: Int, end: Int, insert: String, cause: EditCause = EditCause.Typed) {
        val snapshot = capture(text, start, end)
        text.replace(snapshot.lo, snapshot.hi, insert)
        afterChange(text, snapshot, insert.length, cause)
    }

    /** Applies the editing rules after `insertedLength` characters replaced the range captured in [snapshot]. */
    fun afterChange(text: Editable, snapshot: Snapshot, insertedLength: Int, cause: EditCause = EditCause.Typed) {
        if (isApplying) return
        isApplying = true
        try {
            val kept = if (mode == HtmlMode.Body) blockAfterChange(text, snapshot, insertedLength, cause) else true
            inlineAfterChange(text, snapshot, if (kept) insertedLength else 0)
            if (mode == HtmlMode.Row) rowAfterChange(text, snapshot, insertedLength)
        } finally { isApplying = false }
    }

    private fun readInfos(text: Spanned): MutableList<BlockInfo?> = Doc.lines(text).map { Doc.infoAt(text, it) }.toMutableList()

    private fun defaultInfo() = BlockInfo(listOf(Frame(null)))

    /** Returns false when the inserted text was taken back out again (Enter on an empty item). */
    private fun blockAfterChange(text: Editable, snapshot: Snapshot, insertedLength: Int, cause: EditCause): Boolean {
        val oldLines = snapshot.lines
        val firstIndex = Doc.lineIndexAt(oldLines, snapshot.lo)
        val lastIndex = Doc.lineIndexAt(oldLines, snapshot.hi)
        val inserted = text.subSequence(snapshot.lo, snapshot.lo + insertedLength).toString()
        val firstInfo = snapshot.infos[firstIndex] ?: defaultInfo()
        val before = snapshot.infos.subList(0, firstIndex)
        val after = snapshot.infos.subList(lastIndex + 1, snapshot.infos.size)
        val newlines = inserted.count { it == '\n' }
        // Enter on an empty item leaves the list one level at a time instead of adding another item.
        if (cause == EditCause.Typed && inserted == "\n" && snapshot.lo == snapshot.hi && oldLines[firstIndex].start == oldLines[firstIndex].end &&
            isItemLine(firstInfo)) {
            text.delete(snapshot.lo, snapshot.lo + 1)
            Selection.setSelection(text, snapshot.lo)
            val left = outdentPrefixOnce(firstInfo.path) ?: removeBullet(firstInfo.path)
            Doc.applyInfos(text, before + firstInfo.with(path = left, breakBefore = BreakKind.BLOCK) + after)
            return false
        }
        val finalLines = Doc.lines(text)
        val produced = ArrayList<BlockInfo>()
        produced += firstInfo
        var previous = firstInfo
        for (j in 1..newlines) {
            val tailEmpty = finalLines.getOrNull(firstIndex + j)?.let { it.start == it.end } ?: true
            val next = if (cause == EditCause.Paste) pasteInfo(previous) else enterInfo(previous, tailEmpty)
            produced += next
            previous = next
        }
        if (newlines > 0) {
            for (i in 0 until produced.size - 1) produced[i] = produced[i].with(trailingBr = false, placeholderBr = false)
            if (cause == EditCause.Paste) produced[produced.size - 1] = produced.last().with(trailingBr = firstInfo.trailingBr)
        }
        val infos = ArrayList<BlockInfo?>(before.size + produced.size + after.size)
        infos.addAll(before); infos.addAll(produced); infos.addAll(after)
        while (infos.size < finalLines.size) infos += infos.lastOrNull() ?: defaultInfo()
        while (infos.size > finalLines.size) infos.removeAt(infos.size - 1)
        for (i in infos.indices) {
            val info = infos[i] ?: continue
            if (info.placeholderBr && finalLines[i].end > finalLines[i].start) infos[i] = info.with(trailingBr = false, placeholderBr = false)
        }
        for (i in infos.indices) {
            val info = infos[i] ?: continue
            if (info.path.lastOrNull()?.isEmbed != true) continue
            val line = finalLines[i]
            val holdsEmbed = (line.start until line.end).any { Doc.embedAt(text, it) != null }
            // An embed whose character was edited away is gone; what is left of its line is an ordinary line.
            if (!holdsEmbed) {
                infos[i] = BlockInfo(info.path.dropLast(1) + Frame("div"))
            }
        }
        ensureEmbedsAlone(text, infos)
        Doc.applyInfos(text, infos)
        return true
    }

    private fun innermostItem(path: List<Frame>): Int = path.indexOfLast { it.tag == "li" }

    private fun isItemLine(info: BlockInfo) = innermostItem(info.path) >= 0 && info.breakBefore == BreakKind.BLOCK

    /** The structure of the line a typed Enter creates after [previous]. */
    private fun enterInfo(previous: BlockInfo, tailEmpty: Boolean): BlockInfo {
        val path = previous.path
        val leaf = path.lastOrNull()
        val item = innermostItem(path)
        val newPath = when {
            leaf == null -> listOf(Frame("div"))
            leaf.isEmbed -> path.dropLast(1) + Frame("div")
            item >= 0 -> path.subList(0, item) + path[item].copy()
            leaf.tag != null && leaf.tag.length == 2 && leaf.tag[0] == 'h' && tailEmpty -> path.dropLast(1) + Frame("div")
            leaf.isAnonymous -> path.dropLast(1) + Frame("div")
            else -> path.dropLast(1) + leaf.copy()
        }
        return BlockInfo(newPath, BreakKind.BLOCK)
    }

    private fun pasteInfo(previous: BlockInfo): BlockInfo =
        if (innermostItem(previous.path) >= 0) enterInfo(previous, false) else previous.with(breakBefore = BreakKind.BR, trailingBr = false, placeholderBr = false)

    /** An embed always sits alone on its line: text typed or pasted next to one moves to its own line. */
    private fun ensureEmbedsAlone(text: Editable, infos: MutableList<BlockInfo?>) {
        var index = 0
        while (index < infos.size) {
            val lines = Doc.lines(text)
            val line = lines.getOrNull(index) ?: return
            var position = -1
            val alreadyEmbed = line.end - line.start == 1 && infos[index]?.path?.lastOrNull()?.isEmbed == true
            if (!alreadyEmbed) for (i in line.start until line.end) {
                if (Doc.embedAt(text, i) != null) { position = i; break }
            }
            if (position < 0) { index++; continue }
            val span = Doc.embedAt(text, position)!!
            val info = infos[index] ?: defaultInfo()
            val parent = info.path.dropLast(1)
            val leaf = info.path.lastOrNull()
            val parts = ArrayList<BlockInfo>()
            var hasTail = false
            if (position > line.start) parts += if (leaf?.isEmbed == true) BlockInfo(parent + Frame(null)) else info
            parts += BlockInfo(parent + Frame(null, emptyList(), span.html))
            if (position + 1 < line.end) {
                text.insert(position + 1, "\n")
                hasTail = true
                parts += BlockInfo(parent + (if (leaf == null || leaf.isAnonymous || leaf.isEmbed) Frame("div") else leaf.copy()))
            }
            if (position > line.start) text.insert(position, "\n")
            infos.removeAt(index)
            infos.addAll(index, parts)
            // The tail may hold another embed, so it is looked at again.
            index += if (hasTail) parts.size - 1 else parts.size
        }
    }

    private fun inlineAfterChange(text: Editable, snapshot: Snapshot, insertedLength: Int) {
        val lo = snapshot.lo
        val hi = lo + insertedLength
        if (insertedLength > 0) {
            for (span in snapshot.inherit) {
                val start = text.getSpanStart(span)
                if (start < 0) continue
                val end = text.getSpanEnd(span)
                if (lo < start || hi > end) text.setSpan(span, minOf(start, lo), maxOf(end, hi), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            if (pending.isNotEmpty()) {
                for ((tag, on) in pending) if (on) addStyle(text, tag, lo, hi) else removeStyle(text, tag, lo, hi)
                pending.clear()
            }
            expectedCaret = hi
        }
        mergeInline(text)
    }

    private fun mergeInline(text: Editable) {
        val spans = text.getSpans(0, text.length, InlineTagSpan::class.java)
        if (spans.isEmpty()) return
        val groups = LinkedHashMap<Pair<String, List<HtmlAttr>>, MutableList<InlineTagSpan>>()
        for (span in spans) {
            val start = text.getSpanStart(span)
            if (start < 0) continue
            if (start >= text.getSpanEnd(span)) { text.removeSpan(span); continue }
            groups.getOrPut(span.tag to span.attrs) { ArrayList() } += span
        }
        for (group in groups.values) {
            if (group.size < 2) continue
            group.sortBy { text.getSpanStart(it) }
            var current = group[0]
            for (i in 1 until group.size) {
                val next = group[i]
                val currentEnd = text.getSpanEnd(current)
                if (text.getSpanStart(next) <= currentEnd) {
                    val keep = if (current.order <= next.order) current else next
                    val drop = if (keep === current) next else current
                    val start = minOf(text.getSpanStart(current), text.getSpanStart(next))
                    val end = maxOf(currentEnd, text.getSpanEnd(next))
                    text.removeSpan(drop)
                    text.setSpan(keep, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    current = keep
                } else current = next
            }
        }
    }

    private fun rowAfterChange(text: Editable, snapshot: Snapshot, insertedLength: Int) {
        val inserted = text.subSequence(snapshot.lo, snapshot.lo + insertedLength)
        if (inserted.none { it == '\n' }) return
        val pieces = ArrayList<String>()
        var start = 0
        for (i in 0..text.length) if (i == text.length || text[i] == '\n') {
            pieces += StringBuilder().also { NoteHtml.writeInline(it, text, start, i) }.toString()
            start = i + 1
        }
        onSplit?.invoke(pieces.first(), pieces.drop(1))
    }

    /** True when the caret change did not come from typing, so a pending bold/italic/underline no longer applies. */
    fun onSelectionChanged(start: Int, end: Int) {
        if (start != end || start != expectedCaret) pending.clear()
    }

    val pendingStyles: Map<String, Boolean> get() = pending

    // ---- plain text in ----------------------------------------------------------------------------------

    /** Paste and drop insert plain text only. In a list each non-blank line becomes an item. */
    fun paste(text: Editable, start: Int, end: Int, raw: CharSequence) {
        var value = raw.toString().replace("\r\n", "\n").replace('\r', '\n').replace(EMBED_CHAR.toString(), "")
        if (mode == HtmlMode.Body) {
            val lo = minOf(start, end).coerceIn(0, text.length)
            val line = Doc.lines(text).let { it[Doc.lineIndexAt(it, lo)] }
            val info = Doc.infoAt(text, line)
            if (info != null && innermostItem(info.path) >= 0) value = value.split('\n').filter { it.isNotBlank() }.joinToString("\n")
        }
        replace(text, start, end, value, EditCause.Paste)
    }

    fun handleEnter(text: Editable, start: Int, end: Int) = replace(text, start, end, "\n", EditCause.Typed)

    /** Backspace for a selection, at a line start or inside a line. */
    fun backspace(text: Editable, start: Int, end: Int) {
        val lo = minOf(start, end)
        val hi = maxOf(start, end)
        if (lo != hi) { replace(text, lo, hi, ""); return }
        if (lo == 0 && mode == HtmlMode.Row) return
        if (mode == HtmlMode.Body && handleBackspaceAtLineStart(text, lo)) return
        if (lo == 0) return
        if (mode == HtmlMode.Body && text[lo - 1] == EMBED_CHAR && Doc.embedAt(text, lo - 1) != null) {
            val lines = Doc.lines(text)
            removeLine(text, readInfos(text), Doc.lineIndexAt(lines, lo - 1))
            return
        }
        val width = Character.charCount(Character.codePointBefore(text, lo))
        replace(text, lo - width, lo, "")
    }

    // ---- Backspace at a line start ----------------------------------------------------------------------

    /**
     * Backspace with the caret at the start of a line: remove the bullet, turn a heading into a plain line, drop one quote
     * level, or merge with the line above. Returns false when the caret is not at a line start or nothing applies.
     */
    fun handleBackspaceAtLineStart(text: Editable, caret: Int): Boolean {
        if (mode != HtmlMode.Body) return false
        val lines = Doc.lines(text)
        val index = Doc.lineIndexAt(lines, caret)
        val line = lines[index]
        if (caret != line.start) return false
        val infos = readInfos(text)
        val info = infos[index] ?: defaultInfo()
        val leaf = info.path.lastOrNull()
        if (leaf?.isEmbed == true) {
            if (index == 0) return true
            val previous = lines[index - 1]
            if (previous.start == previous.end) removeLine(text, infos, index - 1)
            else Selection.setSelection(text, previous.end)
            return true
        }
        val changedPath: List<Frame>? = when {
            innermostItem(info.path) >= 0 && info.breakBefore == BreakKind.BLOCK -> removeBullet(info.path)
            leaf?.tag?.length == 2 && leaf.tag[0] == 'h' -> info.path.dropLast(1) + Frame("div")
            info.path.any { it.isQuote } -> info.path.toMutableList().also { it.removeAt(it.indexOfLast { frame -> frame.isQuote }) }
            else -> null
        }
        if (changedPath != null) {
            infos[index] = info.with(path = changedPath, breakBefore = BreakKind.BLOCK)
            Doc.applyInfos(text, infos)
            return true
        }
        if (index == 0) return false
        val previous = lines[index - 1]
        if (infos[index - 1]?.path?.lastOrNull()?.isEmbed == true) { removeLine(text, infos, index - 1); return true }
        replace(text, previous.end, caret, "")
        Selection.setSelection(text, previous.end)
        return true
    }

    private fun removeLine(text: Editable, infos: MutableList<BlockInfo?>, index: Int) {
        val lines = Doc.lines(text)
        val line = lines[index]
        val from = if (index < lines.lastIndex) line.start else maxOf(line.start - 1, 0)
        val to = if (index < lines.lastIndex) line.end + 1 else line.end
        isApplying = true
        try {
            text.delete(from, to)
            infos.removeAt(index)
            if (infos.isEmpty()) infos += null
            Doc.applyInfos(text, infos)
        } finally { isApplying = false }
        Selection.setSelection(text, from.coerceIn(0, text.length))
    }

    // ---- block structure helpers ------------------------------------------------------------------------

    /** The path with the item and every list around it removed; the line becomes plain (or keeps its heading). */
    private fun removeBullet(path: List<Frame>): List<Frame> {
        val firstList = path.indexOfFirst { it.isList }
        val itemIndex = innermostItem(path)
        if (firstList < 0 && itemIndex < 0) return path
        val start = if (firstList >= 0) firstList else itemIndex
        val kept = path.subList(start, path.size).filter { !it.isList && it.tag != "li" }
        val rest = if (kept.any { !it.isAnonymous }) kept else listOf(Frame("div"))
        return path.subList(0, start) + rest
    }

    /** One list level less for the item that ends at [path]'s innermost `li`; null when the line is not in a list. */
    private fun outdentPrefixOnce(path: List<Frame>): List<Frame>? {
        val item = innermostItem(path)
        if (item < 0) return null
        val list = item - 1
        if (list < 0 || !path[list].isList) return removeBullet(path)
        return when {
            list >= 1 && path[list - 1].tag == "li" -> path.subList(0, list - 1) + path.subList(item, path.size)
            list >= 1 && path[list - 1].isList -> path.subList(0, list) + path.subList(item, path.size)
            else -> removeBullet(path)
        }
    }

    private class Selected(val first: Int, val last: Int)

    private fun selectedLines(text: Spanned, a: Int, b: Int): Selected {
        val lo = minOf(a, b).coerceIn(0, text.length)
        val hi = maxOf(a, b).coerceIn(0, text.length)
        val lines = Doc.lines(text)
        val first = Doc.lineIndexAt(lines, lo)
        var last = Doc.lineIndexAt(lines, hi)
        if (hi > lo && last > first && lines[last].start == hi) last--
        return Selected(first, last)
    }

    private fun isEmbedInfo(info: BlockInfo?) = info?.path?.lastOrNull()?.isEmbed == true

    // ---- block commands ---------------------------------------------------------------------------------

    /** `h1`, `h2` or `div` (Normal) for every selected line. */
    fun setLeaf(text: Editable, a: Int, b: Int, tag: String) {
        if (mode != HtmlMode.Body) return
        val selected = selectedLines(text, a, b)
        val infos = readInfos(text)
        for (i in selected.first..selected.last) {
            val info = infos[i] ?: defaultInfo()
            if (isEmbedInfo(info)) continue
            val path = info.path
            val leaf = path.lastOrNull() ?: continue
            val heading = leaf.tag?.let { it.length == 2 && it[0] == 'h' && it[1] in '1'..'6' } == true
            val newPath = when {
                tag == "div" -> if (heading) path.dropLast(1) + Frame("div") else null
                leaf.tag == "li" -> path + Frame(tag)
                leaf.tag == tag -> null
                else -> path.dropLast(1) + Frame(tag)
            } ?: continue
            infos[i] = info.with(path = newPath, breakBefore = BreakKind.BLOCK)
        }
        Doc.applyInfos(text, infos)
    }

    fun toggleBullet(text: Editable, a: Int, b: Int) {
        if (mode != HtmlMode.Body) return
        val selected = selectedLines(text, a, b)
        val infos = readInfos(text)
        val range = (selected.first..selected.last).filter { !isEmbedInfo(infos[it]) }
        if (range.isEmpty()) return
        val allItems = range.all { innermostItem((infos[it] ?: defaultInfo()).path) >= 0 }
        if (allItems) {
            for (i in range) { val info = infos[i]!!; infos[i] = info.with(path = removeBullet(info.path), breakBefore = BreakKind.BLOCK) }
        } else {
            var list: Frame? = null
            var listParent: List<Frame>? = null
            var previousIndex = -1
            for (i in range) {
                val info = infos[i] ?: defaultInfo()
                if (innermostItem(info.path) >= 0) { list = null; previousIndex = i; continue }
                val leaf = info.path.last()
                val heading = leaf.tag?.let { it.length == 2 && it[0] == 'h' && it[1] in '1'..'6' } == true
                val parent = info.path.dropLast(1)
                if (list == null || previousIndex != i - 1 || listParent == null || !samePath(listParent, parent)) {
                    // Join the list right above when it sits in the same place, as the browser does.
                    val above = infos.getOrNull(i - 1)?.takeIf { i - 1 !in range }
                    val reusable = above?.path?.let { p -> if (p.size > parent.size + 1 && samePath(p.subList(0, parent.size), parent) && p[parent.size].tag == "ul" && p.size == parent.size + 2) p[parent.size] else null }
                    list = reusable ?: Frame("ul")
                    listParent = parent
                }
                val newPath = parent + list + Frame("li") + (if (heading) listOf(leaf) else emptyList())
                infos[i] = info.with(path = newPath, breakBefore = BreakKind.BLOCK)
                previousIndex = i
            }
        }
        Doc.applyInfos(text, infos)
    }

    fun indent(text: Editable, a: Int, b: Int) {
        if (mode != HtmlMode.Body) return
        val selected = selectedLines(text, a, b)
        val infos = readInfos(text)
        val handledItems = java.util.IdentityHashMap<Frame, Boolean>()
        var quote: Frame? = null
        var quoteAt = -2
        for (i in selected.first..selected.last) {
            val info = infos[i] ?: defaultInfo()
            if (isEmbedInfo(info)) continue
            val itemIndex = innermostItem(info.path)
            if (itemIndex < 0) {
                if (quote == null || quoteAt != i - 1) quote = Frame("blockquote", listOf(HtmlAttr("style", QUOTE_STYLE)))
                quoteAt = i
                val leafIndex = info.path.size - 1
                infos[i] = info.with(path = info.path.subList(0, leafIndex) + quote + info.path[leafIndex], breakBefore = BreakKind.BLOCK)
                continue
            }
            val item = info.path[itemIndex]
            if (handledItems.put(item, true) != null) continue
            val listIndex = itemIndex - 1
            if (listIndex < 0 || !info.path[listIndex].isList) continue
            var previous: BlockInfo? = null
            for (k in i - 1 downTo 0) {
                val candidate = infos[k] ?: continue
                val p = candidate.path
                if (p.size > itemIndex && samePath(p.subList(0, listIndex + 1), info.path.subList(0, listIndex + 1))) {
                    if (p[itemIndex] === item) continue
                    previous = candidate; break
                }
                break
            }
            val prefix = info.path.subList(0, listIndex + 1)
            val newPrefix: List<Frame> = if (previous == null) prefix + Frame(info.path[listIndex].tag, emptyList()) + item
            else {
                val sibling = previous.path[itemIndex]
                when {
                    sibling.isList -> prefix + sibling + item
                    sibling.tag == "li" -> {
                        val existing = previous.path.getOrNull(itemIndex + 1)?.takeIf { it.isList }
                        prefix + sibling + (existing ?: Frame(info.path[listIndex].tag, emptyList())) + item
                    }
                    else -> prefix + item
                }
            }
            for (j in infos.indices) {
                val target = infos[j] ?: continue
                val p = target.path
                if (p.size > itemIndex && p[itemIndex] === item && samePath(p.subList(0, listIndex + 1), prefix)) {
                    infos[j] = target.with(path = newPrefix + p.subList(itemIndex + 1, p.size))
                }
            }
        }
        Doc.applyInfos(text, infos)
    }

    fun outdent(text: Editable, a: Int, b: Int) {
        if (mode != HtmlMode.Body) return
        val selected = selectedLines(text, a, b)
        val infos = readInfos(text)
        val handledItems = java.util.IdentityHashMap<Frame, Boolean>()
        for (i in selected.first..selected.last) {
            val info = infos[i] ?: defaultInfo()
            if (isEmbedInfo(info)) continue
            val itemIndex = innermostItem(info.path)
            if (itemIndex >= 0) {
                val item = info.path[itemIndex]
                if (handledItems.put(item, true) != null) continue
                val prefixBefore = info.path.subList(0, itemIndex + 1)
                val newPrefix = outdentPrefixOnce(prefixBefore) ?: continue
                for (j in infos.indices) {
                    val target = infos[j] ?: continue
                    val p = target.path
                    if (p.size > itemIndex && p[itemIndex] === item && samePath(p.subList(0, itemIndex + 1), prefixBefore)) {
                        infos[j] = target.with(path = newPrefix + p.subList(itemIndex + 1, p.size), breakBefore = if (j == i) BreakKind.BLOCK else target.breakBefore)
                    }
                }
            } else if (info.path.any { it.isQuote }) {
                val q = info.path.indexOfLast { it.isQuote }
                infos[i] = info.with(path = info.path.toMutableList().also { it.removeAt(q) }, breakBefore = BreakKind.BLOCK)
            }
        }
        Doc.applyInfos(text, infos)
    }

    /** Removes inline formatting (links stay) from the selection and bullets from every selected line. */
    fun clear(text: Editable, a: Int, b: Int) {
        val lo = minOf(a, b).coerceIn(0, text.length)
        val hi = maxOf(a, b).coerceIn(0, text.length)
        if (lo < hi) {
            for (span in text.getSpans(lo, hi, InlineTagSpan::class.java)) {
                if (span.tag == "a") continue
                val start = text.getSpanStart(span); val end = text.getSpanEnd(span)
                text.removeSpan(span)
                if (start < lo) text.setSpan(span.copySpan(), start, lo, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                if (end > hi) text.setSpan(span.copySpan(), hi, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            mergeInline(text)
        }
        if (mode != HtmlMode.Body) return
        val selected = selectedLines(text, a, b)
        val infos = readInfos(text)
        for (i in selected.first..selected.last) {
            val info = infos[i] ?: continue
            if (innermostItem(info.path) < 0 || isEmbedInfo(info)) continue
            infos[i] = info.with(path = removeBullet(info.path), breakBefore = BreakKind.BLOCK)
        }
        Doc.applyInfos(text, infos)
    }

    // ---- inline commands --------------------------------------------------------------------------------

    private fun matches(span: InlineTagSpan, tag: String): Boolean = when (tag) {
        "b" -> span.bold == true
        "i" -> span.italic
        else -> span.tag == "u" || span.tag == "ins" || span.attrs.firstOrNull { it.name == "style" }?.value?.let {
            Regex("text-decoration[^;]*underline", RegexOption.IGNORE_CASE).containsMatchIn(it)
        } == true
    }

    private fun formattable(text: Spanned, position: Int) = text[position] != '\n' && text[position] != EMBED_CHAR

    /** Toggles bold (`b`), italic (`i`) or underline (`u`) over the selection, or the pending typing style when collapsed. */
    fun toggleInline(text: Editable, tag: String, a: Int, b: Int) {
        val lo = minOf(a, b).coerceIn(0, text.length)
        val hi = maxOf(a, b).coerceIn(0, text.length)
        if (lo == hi) {
            val active = pending[tag] ?: styleBefore(text, tag, lo)
            pending[tag] = !active
            expectedCaret = lo
            return
        }
        val positions = (lo until hi).filter { formattable(text, it) }
        if (positions.isEmpty()) return
        val covered = coverage(text, tag, lo, hi)
        if (positions.all { covered[it - lo] }) removeStyle(text, tag, lo, hi) else addStyle(text, tag, lo, hi)
        mergeInline(text)
    }

    private fun coverage(text: Spanned, tag: String, lo: Int, hi: Int): BooleanArray {
        val covered = BooleanArray(hi - lo)
        for (span in text.getSpans(lo, hi, InlineTagSpan::class.java)) {
            if (!matches(span, tag)) continue
            for (i in maxOf(lo, text.getSpanStart(span)) until minOf(hi, text.getSpanEnd(span))) covered[i - lo] = true
        }
        return covered
    }

    private fun styleBefore(text: Spanned, tag: String, caret: Int): Boolean {
        val position = when { caret > 0 && text[caret - 1] != '\n' -> caret - 1; caret < text.length && text[caret] != '\n' -> caret; else -> return false }
        return coverage(text, tag, position, position + 1)[0]
    }

    private fun nextOrder(text: Spanned) = (text.getSpans(0, text.length, InlineTagSpan::class.java).maxOfOrNull { it.order } ?: -1) + 1

    internal fun addStyle(text: Editable, tag: String, lo: Int, hi: Int) {
        val covered = coverage(text, tag, lo, hi)
        var order = nextOrder(text)
        var i = lo
        while (i < hi) {
            if (covered[i - lo] || !formattable(text, i)) { i++; continue }
            var j = i
            while (j < hi && !covered[j - lo] && formattable(text, j)) j++
            text.setSpan(InlineTagSpan(tag, emptyList(), order++), i, j, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            i = j
        }
    }

    internal fun removeStyle(text: Editable, tag: String, lo: Int, hi: Int) {
        for (span in text.getSpans(lo, hi, InlineTagSpan::class.java)) {
            if (!matches(span, tag)) continue
            val start = text.getSpanStart(span); val end = text.getSpanEnd(span)
            text.removeSpan(span)
            if (start < lo) text.setSpan(span.copySpan(), start, lo, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            if (end > hi) text.setSpan(span.copySpan(), hi, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            // A span that only carried the style (b, strong, i, em, u) is gone in the middle; other attributes stay.
            val middle = withoutStyle(span, tag) ?: continue
            text.setSpan(middle, maxOf(start, lo), minOf(end, hi), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
    }

    private fun withoutStyle(span: InlineTagSpan, tag: String): InlineTagSpan? {
        if (span.tag in INLINE_STYLE_TAGS) return null
        val properties = when (tag) { "b" -> listOf("font-weight"); "i" -> listOf("font-style"); else -> listOf("text-decoration") }
        val remaining = span.attrs.firstOrNull { it.name == "style" }?.value?.let { value ->
            properties.fold<String, String?>(value) { acc, name -> acc?.let { InlineTagSpan.withoutStyleProperty(it, name) } }
        }
        val others = span.attrs.filter { it.name != "style" }
        if (remaining == null && others.isEmpty()) return null
        val attrs = span.attrs.mapNotNull { if (it.name == "style") remaining?.let { style -> HtmlAttr("style", style) } else it }
        return InlineTagSpan(span.tag, attrs, span.order)
    }

    /** Active toolbar states for the selection: `b`, `i`, `u`, `h1`, `h2`, `bullet`, `quote`. */
    fun formattingAt(text: Spanned, a: Int, b: Int): Set<String> {
        val lo = minOf(a, b).coerceIn(0, text.length)
        val hi = maxOf(a, b).coerceIn(0, text.length)
        val result = LinkedHashSet<String>()
        for (tag in listOf("b", "i", "u")) {
            val active = if (lo == hi) pending[tag] ?: styleBefore(text, tag, lo) else {
                val positions = (lo until hi).filter { formattable(text, it) }
                positions.isNotEmpty() && coverage(text, tag, lo, hi).let { covered -> positions.all { covered[it - lo] } }
            }
            if (active) result += tag
        }
        if (mode == HtmlMode.Body) {
            val lines = Doc.lines(text)
            val info = Doc.infoAt(text, lines[Doc.lineIndexAt(lines, lo)])
            if (info != null) {
                val heading = info.path.lastOrNull { it.tag == "h1" || it.tag == "h2" }?.tag
                if (heading != null) result += heading
                if (innermostItem(info.path) >= 0) result += "bullet"
                if (info.path.any { it.isQuote }) result += "quote"
            }
        }
        return result
    }

    private companion object {
        const val QUOTE_STYLE = "margin: 0 0 0 40px; border: none; padding: 0px;"
    }
}
