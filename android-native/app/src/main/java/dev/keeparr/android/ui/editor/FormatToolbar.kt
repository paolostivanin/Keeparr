package dev.keeparr.android.ui.editor

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.FormatIndentDecrease
import androidx.compose.material.icons.automirrored.outlined.FormatIndentIncrease
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.FormatBold
import androidx.compose.material.icons.outlined.FormatClear
import androidx.compose.material.icons.outlined.FormatItalic
import androidx.compose.material.icons.outlined.FormatUnderlined
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.draw.alpha
import dev.keeparr.android.data.html.HtmlMode

/**
 * The formatting commands for the focused field (docs/note-content-contract.md section 4): H1 H2 Normal bullet indent
 * outdent B I U Clear Undo Redo for the body; B I U Clear Undo Redo for a checklist row (block buttons disabled); only
 * Undo and Redo while the title (or nothing) has the focus, since the title is plain text.
 */
@Composable
fun FormatToolbar(focus: RichEditorFocus, canUndo: Boolean, canRedo: Boolean, onUndo: () -> Unit, onRedo: () -> Unit, onCommand: () -> Unit,
    contentColor: Color, modifier: Modifier = Modifier) {
    val field = focus.current
    val formatting = field?.formatting.orEmpty()
    val body = field?.mode == HtmlMode.Body
    val any = field != null
    Row(modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
        TextCommand("H1", "Heading 1", "h1" in formatting, body, contentColor) { onCommand(); field?.run(EditorCommand.H1) }
        TextCommand("H2", "Heading 2", "h2" in formatting, body, contentColor) { onCommand(); field?.run(EditorCommand.H2) }
        TextCommand("Aa", "Normal text", false, body, contentColor) { onCommand(); field?.run(EditorCommand.Normal) }
        TextCommand("•", "Bulleted list", "bullet" in formatting, body, contentColor) { onCommand(); field?.run(EditorCommand.Bullet) }
        IconCommand(Icons.AutoMirrored.Outlined.FormatIndentIncrease, "Indent", false, body, contentColor) { onCommand(); field?.run(EditorCommand.Indent) }
        IconCommand(Icons.AutoMirrored.Outlined.FormatIndentDecrease, "Outdent", false, body, contentColor) { onCommand(); field?.run(EditorCommand.Outdent) }
        IconCommand(Icons.Outlined.FormatBold, "Bold", "b" in formatting, any, contentColor) { onCommand(); field?.run(EditorCommand.Bold) }
        IconCommand(Icons.Outlined.FormatItalic, "Italic", "i" in formatting, any, contentColor) { onCommand(); field?.run(EditorCommand.Italic) }
        IconCommand(Icons.Outlined.FormatUnderlined, "Underline", "u" in formatting, any, contentColor) { onCommand(); field?.run(EditorCommand.Underline) }
        IconCommand(Icons.Outlined.FormatClear, "Clear formatting", false, any, contentColor) { onCommand(); field?.run(EditorCommand.Clear) }
        IconCommand(Icons.AutoMirrored.Outlined.Undo, "Undo", false, canUndo, contentColor, onUndo)
        IconCommand(Icons.AutoMirrored.Outlined.Redo, "Redo", false, canRedo, contentColor, onRedo)
    }
}

@Composable
private fun IconCommand(icon: ImageVector, label: String, active: Boolean, enabled: Boolean, contentColor: Color, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.alpha(if (enabled) 1f else .38f).semantics { contentDescription = label; role = Role.Button; selected = active }) {
        Icon(icon, null, tint = if (active) MaterialTheme.colorScheme.primary else contentColor)
    }
}

@Composable
private fun TextCommand(text: String, label: String, active: Boolean, enabled: Boolean, contentColor: Color, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled, modifier = Modifier.alpha(if (enabled) 1f else .38f).semantics { contentDescription = label; role = Role.Button; selected = active }) {
        Text(text, color = if (active) MaterialTheme.colorScheme.primary else contentColor, style = MaterialTheme.typography.labelLarge)
    }
}
