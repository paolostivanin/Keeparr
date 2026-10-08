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
) {
    /** Lazy-list content type: cards of different shape do not share composition slots. */
    val contentType: String get() = when {
        locked -> "locked-card"
        checklist -> "checklist-card"
        imagePath != null -> "image-card"
        else -> "text-card"
    }
}

internal data class HomeProjection(
    val visibleNotes: List<Note>,
    val cards: List<NoteCardUiModel>,
    val pinnedCards: List<NoteCardUiModel>,
    val otherCards: List<NoteCardUiModel>,
    val notesBySyncId: Map<String, Note>,
    val filterChoices: List<Pair<String, String>>
)

internal val EmptyHomeProjection = HomeProjection(emptyList(), emptyList(), emptyList(), emptyList(), emptyMap(), emptyList())

/** One-shot projection; the screen keeps a [HomeProjector] so unchanged notes are not rebuilt. */
internal fun buildHomeProjection(notes: List<Note>, filter: String, search: String, reminders: List<JSONObject>): HomeProjection =
    HomeProjector().project(notes, filter, search, reminders)
