package dev.keeparr.android.data

import dev.keeparr.android.data.html.NoteHtml
import org.json.JSONArray
import org.json.JSONObject

/**
 * Checklist document operations: a port of the web's `checkbox-indent.ts`, `checklist-model.ts` and
 * `checklist-conversion.ts`, checked against the shared `checklistOps` fixtures. Every function maps one list of rows to
 * the next without touching its input; a null result means the operation changes nothing or does not apply. Rows keep
 * every field they came with (unknown fields, structured `data`).
 */
object ChecklistModel {
    const val MAX_INDENT_LEVEL = 3

    fun rows(array: JSONArray?): List<JSONObject> = array?.objects().orEmpty()
    fun toJson(rows: List<JSONObject>): JSONArray = JSONArray().also { array -> rows.forEach(array::put) }

    fun idOf(row: JSONObject): Long = row.optLong("id", -1)
    fun isStructured(row: JSONObject) = row.opt("data") !is String

    fun normalizeIndentLevel(value: Any?): Int {
        val number = when (value) { is Number -> value.toDouble(); is String -> value.toDoubleOrNull() ?: Double.NaN; else -> Double.NaN }
        if (!number.isFinite()) return 0
        val level = Math.floor(number).toInt()
        return if (level < 1) 0 else minOf(level, MAX_INDENT_LEVEL)
    }

    private fun levelOf(row: JSONObject) = normalizeIndentLevel(row.opt("indentLevel"))

    /** Deepest level the row at [index] may reach: one more than the row above. */
    fun maxIndentLevelAt(rows: List<JSONObject>, index: Int): Int =
        if (index <= 0) 0 else minOf(levelOf(rows[index - 1]) + 1, MAX_INDENT_LEVEL)

    /** Clamps every row so no row sits deeper than the row above allows. */
    fun normalizeIndentLevels(rows: List<JSONObject>): List<JSONObject> {
        val result = ArrayList<JSONObject>(rows.size)
        for (row in rows) {
            val current = levelOf(row)
            val max = if (result.isEmpty()) 0 else minOf(levelOf(result.last()) + 1, MAX_INDENT_LEVEL)
            val next = minOf(current, max)
            result += if (current == next) row else row.shallowCopy().put("indentLevel", next)
        }
        return result
    }

    /** Indexes of the contiguous rows nested below the row at [index]. */
    fun descendantIndexes(rows: List<JSONObject>, index: Int): List<Int> {
        if (index < 0 || index >= rows.size) return emptyList()
        val level = levelOf(rows[index])
        val result = ArrayList<Int>()
        for (i in index + 1 until rows.size) { if (levelOf(rows[i]) <= level) break; result += i }
        return result
    }

    /** One more than the highest numeric id (0 for no rows), so ids are never reused. */
    fun nextId(rows: List<JSONObject>): Long = (rows.map { idOf(it) }.filter { it >= 0 }.maxOrNull() ?: -1L) + 1

    private fun with(row: JSONObject, vararg changes: Pair<String, Any?>) = row.shallowCopy().also { copy -> changes.forEach { (key, value) -> copy.put(key, value) } }

    fun setIndent(rows: List<JSONObject>, id: Long, indentLevel: Int): List<JSONObject>? {
        val index = rows.indexOfFirst { idOf(it) == id }
        if (index < 0) return null
        val current = levelOf(rows[index])
        val next = minOf(normalizeIndentLevel(indentLevel), maxIndentLevelAt(rows, index))
        if (current == next) return null
        val delta = next - current
        val result = rows.toMutableList()
        for (child in descendantIndexes(rows, index)) result[child] = with(rows[child], "indentLevel" to normalizeIndentLevel(levelOf(rows[child]) + delta))
        result[index] = with(rows[index], "indentLevel" to next)
        return result
    }

    /** Toggles a row and applies the new state to every row nested below it. */
    fun toggleDone(rows: List<JSONObject>, id: Long): List<JSONObject>? {
        val index = rows.indexOfFirst { idOf(it) == id }
        if (index < 0) return null
        val done = !rows[index].optBoolean("done")
        val result = rows.toMutableList()
        result[index] = with(rows[index], "done" to done)
        for (child in descendantIndexes(rows, index)) result[child] = with(rows[child], "done" to done)
        return result
    }

    /** Moves one row (its children stay) before [beforeId], or to the end for null, then repairs the indentation. */
    fun moveBefore(rows: List<JSONObject>, id: Long, beforeId: Long?): List<JSONObject>? {
        val from = rows.indexOfFirst { idOf(it) == id }
        if (from < 0 || beforeId == id) return null
        val target = if (beforeId == null) rows.size else rows.indexOfFirst { idOf(it) == beforeId }.takeIf { it >= 0 } ?: return null
        if (target == from + 1) return null
        val result = rows.toMutableList()
        val row = result.removeAt(from)
        result.add(if (target > from) target - 1 else target, row)
        return normalizeIndentLevels(result)
    }

    /** A new empty row right after the row [afterId] at its level, or at the end when there is no such row. */
    fun insertAfter(rows: List<JSONObject>, afterId: Long?, data: String = "", id: Long = nextId(rows)): List<JSONObject> {
        val index = if (afterId == null) -1 else rows.indexOfFirst { idOf(it) == afterId }
        val level = if (index >= 0) levelOf(rows[index]) else 0
        val row = JSONObject().put("id", id).put("done", false).put("data", data).put("indentLevel", level)
        val result = rows.toMutableList()
        result.add(if (index >= 0) index + 1 else result.size, row)
        return result
    }

    /** The row takes [left]; a new unchecked row with [right] and the same level follows it, before its children. */
    fun split(rows: List<JSONObject>, id: Long, left: String, right: String): List<JSONObject>? {
        val index = rows.indexOfFirst { idOf(it) == id }
        if (index < 0 || isStructured(rows[index])) return null
        val result = rows.toMutableList()
        result[index] = with(rows[index], "data" to left)
        result.add(index + 1, JSONObject().put("id", nextId(rows)).put("done", false).put("data", right).put("indentLevel", levelOf(rows[index])))
        return result
    }

    /** True when the row's html shows text (tags stripped, entities decoded, nbsp counted as a space). */
    fun hasVisibleText(html: String): Boolean = NoteHtml.titleText(html).isNotBlank()

    /**
     * Backspace at the very start of a row: a row without visible text is deleted; otherwise its html is appended to the
     * previous row, taken in [visibleIds] order (the list order when null), and the row goes away.
     */
    fun mergeIntoPrevious(rows: List<JSONObject>, id: Long, visibleIds: List<Long>? = null): List<JSONObject>? {
        val index = rows.indexOfFirst { idOf(it) == id }
        if (index < 0) return null
        val row = rows[index]
        if (isStructured(row)) return null
        if (!hasVisibleText(row.getString("data"))) return rows.toMutableList().also { it.removeAt(index) }
        val order = visibleIds ?: rows.map { idOf(it) }
        val position = order.indexOf(id)
        if (position <= 0) return null
        val previousId = order[position - 1]
        val previousIndex = rows.indexOfFirst { idOf(it) == previousId }
        if (previousIndex < 0 || isStructured(rows[previousIndex])) return null
        val result = rows.toMutableList()
        result[previousIndex] = with(rows[previousIndex], "data" to rows[previousIndex].getString("data") + row.getString("data"))
        result.removeAt(index)
        return result
    }

    fun remove(rows: List<JSONObject>, id: Long): List<JSONObject>? {
        val index = rows.indexOfFirst { idOf(it) == id }
        return if (index < 0) null else rows.toMutableList().also { it.removeAt(index) }
    }

    /** "Show checkboxes": each body line becomes an unchecked row; embeds stay in the body, which makes the note hybrid. */
    fun show(rows: List<JSONObject>, body: String): Pair<List<JSONObject>, String> {
        val lines = NoteHtml.nonBlankLines(body, skipEmbeds = true)
        val keptBody = NoteHtml.embeds(body).joinToString("")
        if (lines.isEmpty()) return rows to keptBody
        val first = nextId(rows)
        val added = lines.mapIndexed { i, line -> JSONObject().put("id", first + i).put("done", false).put("data", NoteHtml.escapeText(line)).put("indentLevel", 0) }
        return (rows + added) to keptBody
    }

    /** Unchecked rows with text become lines after the kept body; checked rows are dropped. Null when a structured row blocks it. */
    fun hide(rows: List<JSONObject>, body: String): Pair<List<JSONObject>, String>? {
        if (!canHide(rows)) return null
        val lines = rows.filter { !it.optBoolean("done") && !isStructured(it) && hasVisibleText(it.getString("data")) }.joinToString("") { "<div>${it.getString("data")}</div>" }
        return emptyList<JSONObject>() to body + lines
    }

    fun canHide(rows: List<JSONObject>) = rows.all { it.optBoolean("done") || !isStructured(it) }

    fun checkedCount(rows: List<JSONObject>) = rows.count { it.optBoolean("done") }
}
