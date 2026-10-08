package dev.keeparr.android.ui

import dev.keeparr.android.data.Note
import dev.keeparr.android.data.NoteFormat
import dev.keeparr.android.data.NoteOrder
import dev.keeparr.android.data.ReminderFormat
import dev.keeparr.android.data.text
import org.json.JSONObject

/**
 * Incremental builder of [HomeProjection]. Notes the repository did not re-decode are the same instances as last time,
 * so their card, labels and search text are reused; only changed notes (or notes whose reminder text changed) are
 * rebuilt, and a result that is element-for-element the previous one is returned as that same object so Compose has
 * nothing to recompose. Raw note JSON stays authoritative; this holds derived values only and can be dropped at any time.
 * Calls are serialized, but run it off the main thread.
 */
internal class HomeProjector {
    private class Meta(val note: Note, val labels: List<String>, val binder: String) {
        var card: NoteCardUiModel? = null
        var reminderText: String? = null
        var searchText: String? = null
    }

    private val meta = HashMap<String, Meta>()
    private var lastNotes: List<Note>? = null
    private var lastReminders: List<JSONObject>? = null
    private var lastFilter = ""
    private var lastSearch = ""
    private var lastProjection: HomeProjection = EmptyHomeProjection

    /** Counters for tests and profiling: how much derived work the last calls actually did. */
    internal var cardBuilds = 0; private set
    internal var searchTextBuilds = 0; private set

    @Synchronized fun project(notes: List<Note>, filter: String, search: String, reminders: List<JSONObject>): HomeProjection {
        if (notes === lastNotes && reminders === lastReminders && filter == lastFilter && search == lastSearch) return lastProjection
        syncMeta(notes)
        var visible = NoteOrder.visible(notes, filter)
        if (search.isNotBlank()) visible = visible.filter { note -> !note.locked && searchText(note).contains(search, ignoreCase = true) }
        val reminderIndex = ReminderFormat.indexByNote(notes, reminders)
        val cards = visible.map { note ->
            val entry = meta.getValue(note.syncId)
            val reminderText = reminderIndex[note.syncId]?.let { ReminderFormat.dateTime(ReminderFormat.displayDueAt(it)) }
            val cached = entry.card
            if (cached != null && entry.reminderText == reminderText) cached
            else buildCard(note, reminderText).also { entry.card = it; entry.reminderText = reminderText; cardBuilds++ }
        }
        val projection = lastProjection.takeIf { previous -> sameElements(previous.visibleNotes, visible) &&
            sameElements(previous.cards, cards) && previous.filterChoices == filterChoices(notes) }
            ?: HomeProjection(
                visibleNotes = visible,
                cards = cards,
                pinnedCards = cards.filter { it.pinned },
                otherCards = cards.filterNot { it.pinned },
                notesBySyncId = visible.associateBy { it.syncId },
                filterChoices = filterChoices(notes)
            )
        lastNotes = notes; lastReminders = reminders; lastFilter = filter; lastSearch = search; lastProjection = projection
        return projection
    }

    private fun syncMeta(notes: List<Note>) {
        val present = HashSet<String>(notes.size)
        for (note in notes) {
            present += note.syncId
            val existing = meta[note.syncId]
            if (existing == null || existing.note !== note) meta[note.syncId] = Meta(note, note.labels, note.binder)
        }
        meta.keys.retainAll(present)
    }

    private fun searchText(note: Note): String {
        val entry = meta.getValue(note.syncId)
        return entry.searchText ?: (note.title + " " + NoteFormat.displayText(note.body) + " " + note.items.joinToString { it.text("data") })
            .also { entry.searchText = it; searchTextBuilds++ }
    }

    private var cachedChoicesFor: List<Note>? = null
    private var cachedChoices: List<Pair<String, String>> = emptyList()

    private fun filterChoices(notes: List<Note>): List<Pair<String, String>> {
        if (notes === cachedChoicesFor) return cachedChoices
        val labels = meta.values.flatMap { it.labels }.distinct().sorted().map { "label:$it" to it }
        val binders = meta.values.map { it.binder }.filter(String::isNotBlank).distinct().sorted().map { "binder:$it" to it }
        cachedChoices = listOf("home" to "Notes", "reminders" to "Reminders", "shared" to "Shared notes",
            "archive" to "Archive", "trash" to "Trash") + labels + binders
        cachedChoicesFor = notes
        return cachedChoices
    }

    private fun <T> sameElements(a: List<T>, b: List<T>) = a.size == b.size && a.indices.all { a[it] === b[it] }

    private fun buildCard(note: Note, reminderText: String?) = NoteCardUiModel(
        syncId = note.syncId,
        title = NoteFormat.displayText(note.title),
        bodyText = if (note.checklist) "" else NoteFormat.displayText(note.body),
        colorArgb = dev.keeparr.android.data.NotePalette.parse(note.raw.text("bgColor")),
        locked = note.locked,
        checklist = note.checklist,
        checklistItems = if (note.checklist) note.items.take(8).map { item ->
            ChecklistCardItem(item.optLong("id"), NoteFormat.displayText(item.text("data")), item.optBoolean("done"))
        } else emptyList(),
        imagePath = note.raw.optJSONArray("images")?.optJSONObject(0)?.text("dataUrl")?.takeIf { it.isNotBlank() },
        labels = note.labels.toList(),
        shared = (note.raw.optJSONArray("collaborators")?.length() ?: 0) > 0,
        pinned = note.pinned,
        reminderText = reminderText
    )
}
