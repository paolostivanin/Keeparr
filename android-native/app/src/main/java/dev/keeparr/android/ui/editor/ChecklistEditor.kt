package dev.keeparr.android.ui.editor

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.DragIndicator
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.zIndex
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import dev.keeparr.android.data.ChecklistModel
import dev.keeparr.android.data.html.HtmlMode
import org.json.JSONObject
import android.net.Uri

/** What the rows of a checklist can ask of the note; the editor screen implements them with [ChecklistModel]. */
interface ChecklistActions {
    fun setText(id: Long, html: String)
    fun toggle(id: Long, done: Boolean)
    fun split(id: Long, left: String, rest: List<String>, caret: Int)
    /** Backspace at the true start of a row. Returns true when the row was merged or deleted. */
    fun backspaceAtStart(id: Long): Boolean
    fun moveUp(id: Long)
    fun moveDown(id: Long)
    /** Moves [id] before [beforeId], or to the end for null (a drop). False when that changes nothing. */
    fun moveBefore(id: Long, beforeId: Long?): Boolean
    fun setIndent(id: Long, level: Int)
    fun remove(id: Long)
}

/**
 * The rows of one checklist section ([shown], taken from the note's [rows]), each an editable [RichTextField] in row mode:
 * formatted rows stay editable, a typed or pasted line break splits the row, Backspace at the start merges it into the
 * previous row of its section. A row is reordered within its section by dragging its grip ([scrollBy] and [viewport] let
 * the drag scroll the editor it sits in), indented or outdented by swiping it right or left, and removed with its X.
 */
@Composable
internal fun ChecklistRows(
    rows: List<JSONObject>, shown: List<JSONObject>, externalEdits: Long, colors: EditorColors, foreground: Color, background: Color,
    embeds: EmbedBinder?, states: MutableMap<Long, RichEditorState>, actions: ChecklistActions, onLinkTap: (String) -> Unit,
    onImageContent: (Uri, String) -> Unit, viewport: () -> Rect?, scrollBy: suspend (Float) -> Float
) {
    val visibleIds = shown.map { ChecklistModel.idOf(it) }
    val byId = shown.associateBy { ChecklistModel.idOf(it) }
    // A row whose parent sits in the other section is drawn at the depth its own section allows, like the web.
    val shownLevels = ChecklistModel.normalizeIndentLevels(shown).associate { ChecklistModel.idOf(it) to ChecklistModel.normalizeIndentLevel(it.opt("indentLevel")) }
    val drag = remember { ChecklistDragController() }
    val haptics = LocalHapticFeedback.current
    SideEffect { drag.reconcile(visibleIds) }
    Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
        drag.shown(visibleIds).forEachIndexed { visibleIndex, id ->
            val item = byId[id] ?: return@forEachIndexed
            val index = rows.indexOf(item)
            key(id) {
                val level = ChecklistModel.normalizeIndentLevel(item.opt("indentLevel"))
                val canIndent = level < ChecklistModel.maxIndentLevelAt(rows, index)
                val indent by animateDpAsState(((shownLevels[id] ?: level) * 12).dp, label = "checklist indent")
                val dragged = drag.draggingId == id
                DisposableEffect(id) { onDispose { drag.disposed(id) } }
                Row(Modifier.fillMaxWidth().onSizeChanged { drag.sized(id, it.height.toFloat()) }
                    // The same modifiers at rest and while dragged: changing the chain's structure when a drag starts (adding a
                    // graphics layer) resets the grip's pointer input and ends the very gesture that caused it.
                    .zIndex(if (dragged) 1f else 0f)
                    .graphicsLayer { if (dragged) { translationY = drag.offset; shadowElevation = 8.dp.toPx() } }
                    .background(if (dragged) background else Color.Transparent),
                    verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(width = 32.dp, height = 48.dp)
                        .semantics {
                            contentDescription = "Reorder item"
                            // Dragging and swiping have no equivalent for a screen reader, which moves a row one step at a time.
                            customActions = listOfNotNull(
                                if (visibleIndex > 0) CustomAccessibilityAction("Move up") { actions.moveUp(id); true } else null,
                                if (visibleIndex < shown.lastIndex) CustomAccessibilityAction("Move down") { actions.moveDown(id); true } else null,
                                if (canIndent) CustomAccessibilityAction("Indent") { actions.setIndent(id, level + 1); true } else null,
                                if (level > 0) CustomAccessibilityAction("Outdent") { actions.setIndent(id, level - 1); true } else null)
                        }
                        .checklistDragHandle(id, drag, { visibleIds }, viewport, scrollBy,
                            onStart = { haptics.performHapticFeedback(HapticFeedbackType.LongPress) },
                            onDrop = { actions.moveBefore(it.id, it.beforeId) }),
                        contentAlignment = Alignment.Center) {
                        Icon(Icons.Outlined.DragIndicator, null, tint = foreground.copy(alpha = .6f))
                    }
                    // The checkbox goes with the text; the grip stays put so every row can be grabbed in the same place.
                    Spacer(Modifier.width(indent))
                    Checkbox(item.optBoolean("done"), onCheckedChange = { actions.toggle(id, it) }, colors = CheckboxDefaults.colors(
                        checkedColor = foreground, uncheckedColor = foreground.copy(alpha = .7f), checkmarkColor = background))
                    Box(Modifier.weight(1f)
                        .indentSwipe { step ->
                            if (if (step > 0) canIndent else level > 0) {
                                haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                actions.setIndent(id, level + step)
                            }
                        }) {
                        if (ChecklistModel.isStructured(item)) Column {
                            Text("Structured checklist item")
                            Text("This item comes from a newer version of Keeparr and is shown read-only.", style = MaterialTheme.typography.labelSmall)
                        } else {
                            val state = states.getOrPut(id) { RichEditorState(HtmlMode.Row, "row:$id") }
                            RichTextField(
                                state = state, html = item.getString("data"), externalEdits = externalEdits, colors = colors, hint = "List item",
                                modifier = Modifier.fillMaxWidth(), embeds = embeds,
                                onLinkTap = onLinkTap,
                                onImageContent = onImageContent,
                                onHtmlChange = { actions.setText(id, it) },
                                onSplit = { left, rest, caret -> actions.split(id, left, rest, caret) },
                                onBackspaceAtStart = { actions.backspaceAtStart(id) }
                            )
                        }
                    }
                    IconButton(onClick = { actions.remove(id) }) { Icon(Icons.Outlined.Close, "Remove item") }
                }
            }
        }
    }
}

/** The "(N) Completed items" row that opens and closes the section of checked rows below it. */
@Composable
internal fun CompletedItemsHeader(count: Int, collapsed: Boolean, foreground: Color, onToggle: () -> Unit) {
    val tint = foreground.copy(alpha = .7f)
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
        .clickable(onClickLabel = if (collapsed) "Show completed items" else "Hide completed items", role = Role.Button, onClick = onToggle)
        .semantics { stateDescription = if (collapsed) "Collapsed" else "Expanded" },
        verticalAlignment = Alignment.CenterVertically) {
        // As wide as a row's grip, so the arrow lines up with the grips above it.
        Box(Modifier.size(width = 32.dp, height = 48.dp), contentAlignment = Alignment.Center) {
            Icon(Icons.Outlined.ExpandMore, null, Modifier.rotate(if (collapsed) -90f else 0f), tint = tint)
        }
        Text("($count) Completed items", color = tint, style = MaterialTheme.typography.bodyMedium)
    }
}

/**
 * Where a checklist shows its rows. With `split`, checked rows leave the list for a section of their own below it, empty
 * while `collapsed`; without it every row stays in order in [open]. Each list keeps the note's row order.
 */
internal data class ChecklistSections(val open: List<JSONObject>, val completed: List<JSONObject>) {
    /** The shown rows of the section holding [id], in display order; empty when the row is not shown. */
    fun sectionOf(id: Long): List<JSONObject> = when {
        open.any { ChecklistModel.idOf(it) == id } -> open
        completed.any { ChecklistModel.idOf(it) == id } -> completed
        else -> emptyList()
    }

    companion object {
        fun of(rows: List<JSONObject>, split: Boolean, collapsed: Boolean): ChecklistSections =
            if (!split) ChecklistSections(rows, emptyList())
            else ChecklistSections(rows.filter { !it.optBoolean("done") }, if (collapsed) emptyList() else rows.filter { it.optBoolean("done") })
    }
}

/** The shown row before and after [id] within its own section. */
internal fun neighbours(sections: ChecklistSections, id: Long): Pair<JSONObject?, JSONObject?> {
    val section = sections.sectionOf(id)
    val position = section.indexOfFirst { ChecklistModel.idOf(it) == id }
    if (position < 0) return null to null
    return section.getOrNull(position - 1) to section.getOrNull(position + 1)
}
