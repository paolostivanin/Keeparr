package dev.keeparr.android.ui.editor

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
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
    fun setIndent(id: Long, level: Int)
    fun remove(id: Long)
}

/**
 * The rows of a checklist, each an editable [RichTextField] in row mode: formatted rows stay editable, a typed or pasted
 * line break splits the row, Backspace at the start merges it into the previous visible row.
 */
@Composable
internal fun ChecklistRows(
    rows: List<JSONObject>, hideDone: Boolean, externalEdits: Long, colors: EditorColors, foreground: Color, background: Color,
    embeds: EmbedBinder?, states: MutableMap<Long, RichEditorState>, actions: ChecklistActions, onLinkTap: (String) -> Unit,
    onImageContent: (Uri, String) -> Unit
) {
    val visible = rows.filter { !hideDone || !it.optBoolean("done") }
    Column(verticalArrangement = Arrangement.spacedBy(0.dp)) {
        visible.forEachIndexed { visibleIndex, item ->
            val id = ChecklistModel.idOf(item)
            val index = rows.indexOf(item)
            key(id) {
                var menu by remember { mutableStateOf(false) }
                val level = ChecklistModel.normalizeIndentLevel(item.opt("indentLevel"))
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(item.optBoolean("done"), onCheckedChange = { actions.toggle(id, it) }, colors = CheckboxDefaults.colors(
                        checkedColor = foreground, uncheckedColor = foreground.copy(alpha = .7f), checkmarkColor = background))
                    Box(Modifier.weight(1f).padding(start = (level * 12).dp)) {
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
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "Checklist item actions") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            // Moves go to the neighbouring visible row, so hidden completed rows are never the target.
                            if (visibleIndex > 0) DropdownMenuItem(text = { Text("Move up") }, onClick = { menu = false; actions.moveUp(id) })
                            if (visibleIndex < visible.lastIndex) DropdownMenuItem(text = { Text("Move down") }, onClick = { menu = false; actions.moveDown(id) })
                            if (level < ChecklistModel.maxIndentLevelAt(rows, index)) DropdownMenuItem(text = { Text("Indent") }, onClick = { menu = false; actions.setIndent(id, level + 1) })
                            if (level > 0) DropdownMenuItem(text = { Text("Outdent") }, onClick = { menu = false; actions.setIndent(id, level - 1) })
                            DropdownMenuItem(text = { Text("Remove item") }, leadingIcon = { Icon(Icons.Outlined.Close, null) }, onClick = { menu = false; actions.remove(id) })
                        }
                    }
                }
            }
        }
    }
}

/** The visible row before and after [id] in display order. */
internal fun neighbours(rows: List<JSONObject>, hideDone: Boolean, id: Long): Pair<JSONObject?, JSONObject?> {
    val visible = rows.filter { !hideDone || !it.optBoolean("done") }
    val position = visible.indexOfFirst { ChecklistModel.idOf(it) == id }
    return visible.getOrNull(position - 1) to visible.getOrNull(position + 1)
}
