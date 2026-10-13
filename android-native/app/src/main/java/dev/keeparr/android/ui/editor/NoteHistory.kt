package dev.keeparr.android.ui.editor

/**
 * Undo and redo for one note editor session: snapshots of the fields a user edits (title, body, checklist), taken after
 * each change. Typing is coalesced: edits less than [BURST_MS] apart, with no structural change between them, replace the
 * latest snapshot instead of adding one. Structural changes (a row added, moved, checked, a toolbar command, show or hide
 * checkboxes) always get their own step, so undo steps through them one by one.
 *
 * Mirrors the web's `ChecklistHistory` (src/app/utils/checklist-model.ts) in limit and in ignoring identical states,
 * and adds the text history the browser provides there.
 */
class NoteHistory(private val now: () -> Long = System::currentTimeMillis) {
    class Entry(
        val title: String, val body: String, val checklist: Boolean, val items: String,
        /** Rows' ids, states and levels: when this differs between two snapshots the change is structural. */
        val structure: String,
        /** Field that had the focus (`body`, `row:<id>`) and its selection, to put the caret back after undo. */
        val focusKey: String? = null, val selection: IntArray? = null
    ) {
        fun sameContent(other: Entry) = title == other.title && body == other.body && checklist == other.checklist && items == other.items
    }

    private val entries = ArrayList<Entry>()
    private var index = -1
    private var lastAt = 0L
    private var lastStructural = true

    val canUndo get() = index > 0
    val canRedo get() = index in 0 until entries.size - 1
    val size get() = entries.size

    fun reset(initial: Entry) {
        entries.clear(); entries += initial; index = 0; lastAt = 0; lastStructural = true
    }

    /** Records the state after a user change. Returns false when it equals the current one. */
    fun record(entry: Entry, structural: Boolean = false): Boolean {
        if (index < 0) { reset(entry); return true }
        val current = entries[index]
        if (current.sameContent(entry)) return false
        val time = now()
        val isStructural = structural || current.structure != entry.structure
        // A burst of typing keeps one step, but never swallows the baseline the user could return to.
        val coalesce = !isStructural && !lastStructural && index > 0 && index == entries.size - 1 && time - lastAt < BURST_MS &&
            current.focusKey == entry.focusKey
        if (coalesce) entries[index] = entry
        else {
            while (entries.size > index + 1) entries.removeAt(entries.size - 1)
            entries += entry
            if (entries.size > LIMIT) entries.removeAt(0)
            index = entries.size - 1
        }
        lastAt = time
        lastStructural = isStructural
        return true
    }

    fun undo(): Entry? {
        if (!canUndo) return null
        index--; lastStructural = true
        return entries[index]
    }

    fun redo(): Entry? {
        if (!canRedo) return null
        index++; lastStructural = true
        return entries[index]
    }

    /** The state the next undo returns to (for the caret hint); null when there is none. */
    fun previous(): Entry? = if (canUndo) entries[index - 1] else null

    companion object {
        const val LIMIT = 80
        const val BURST_MS = 1_000L
    }
}
