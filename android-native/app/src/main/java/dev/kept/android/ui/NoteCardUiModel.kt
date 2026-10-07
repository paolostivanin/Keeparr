package dev.kept.android.ui

import androidx.compose.runtime.Immutable
import dev.kept.android.data.Note
import dev.kept.android.data.NoteFormat
import dev.kept.android.data.NotePalette
import dev.kept.android.data.ReminderFormat
import dev.kept.android.data.text
import org.json.JSONObject

@Immutable
internal data class ChecklistCardItem(val id: Long, val text: String, val done: Boolean)

@Immutable
internal data class NoteCardUiModel(
    val syncId: String,
    val title: String,
    val bodyText: String,
    val colorArgb: Int?,
    val locked: Boolean,
    val checklist: Boolean,
    val checklistItems: List<ChecklistCardItem>,
    val imagePath: String?,
    val labels: List<String>,
    val shared: Boolean,
    val pinned: Boolean,
    val reminderText: String?
)

internal data class HomeProjection(
    val visibleNotes: List<Note>,
    val cards: List<NoteCardUiModel>,
    val pinnedCards: List<NoteCardUiModel>,
    val otherCards: List<NoteCardUiModel>,
    val notesBySyncId: Map<String, Note>,
    val filterChoices: List<Pair<String, String>>
)

internal val EmptyHomeProjection = HomeProjection(emptyList(), emptyList(), emptyList(), emptyList(), emptyMap(), emptyList())

internal fun buildHomeProjection(notes: List<Note>, filter: String, search: String, reminders: List<JSONObject>): HomeProjection {
    val visible = searchVisibleNotes(notes, filter, search)
    val reminderIndex = ReminderFormat.indexByNote(notes, reminders)
    val cards = visible.map { note ->
        NoteCardUiModel(
            syncId = note.syncId,
            title = NoteFormat.displayText(note.title),
            bodyText = if (note.checklist) "" else NoteFormat.displayText(note.body),
            colorArgb = NotePalette.parse(note.raw.text("bgColor")),
            locked = note.locked,
            checklist = note.checklist,
            checklistItems = if (note.checklist) note.items.take(8).map { item ->
                ChecklistCardItem(item.optLong("id"), NoteFormat.displayText(item.text("data")), item.optBoolean("done"))
            } else emptyList(),
            imagePath = note.raw.optJSONArray("images")?.optJSONObject(0)?.text("dataUrl")?.takeIf { it.isNotBlank() },
            labels = note.labels.toList(),
            shared = (note.raw.optJSONArray("collaborators")?.length() ?: 0) > 0,
            pinned = note.pinned,
            reminderText = reminderIndex[note.syncId]?.let { reminder ->
                ReminderFormat.dateTime(ReminderFormat.displayDueAt(reminder))
            }
        )
    }
    val filterChoices = listOf("home" to "Notes", "reminders" to "Reminders", "shared" to "Shared notes",
        "archive" to "Archive", "trash" to "Trash") + notes.flatMap { it.labels }.distinct().sorted().map { "label:$it" to it } +
        notes.map { it.binder }.filter(String::isNotBlank).distinct().sorted().map { "binder:$it" to it }
    return HomeProjection(
        visibleNotes = visible,
        cards = cards,
        pinnedCards = cards.filter { it.pinned },
        otherCards = cards.filterNot { it.pinned },
        notesBySyncId = visible.associateBy { it.syncId },
        filterChoices = filterChoices
    )
}
