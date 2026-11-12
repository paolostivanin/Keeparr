package dev.keeparr.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.max
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.data.Note
import dev.keeparr.android.data.ReminderFormat
import dev.keeparr.android.data.html.NoteHtml
import dev.keeparr.android.data.text
import dev.keeparr.android.ui.components.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.Instant

/** Pending reminders, soonest first. Tapping one opens its note; Dismiss and Delete act on the reminder alone. */
@Composable
internal fun ReminderList(app: KeeparrApplication, reminders: List<JSONObject>, notes: List<Note>, header: (@Composable () -> Unit)?,
    modifier: Modifier, onOpenNote: (Note) -> Unit, onError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var removing by remember { mutableStateOf<JSONObject?>(null) }
    val rows = reminders.filter { reminder ->
        reminder.text("status") == "pending" && reminder.text("dueAtUtc").isNotEmpty() &&
            (reminder.optLong("noteId") == 0L || notes.any { it.id == reminder.optLong("noteId") || it.syncId == reminder.text("noteSyncId") })
    }
        .sortedBy { runCatching { Instant.parse(ReminderFormat.displayDueAt(it)) }.getOrDefault(Instant.MAX) }
    if (rows.isEmpty()) Column(modifier.verticalScroll(rememberScrollState()).centeredMaxWidth().padding(horizontal = Spacing.md)) {
        header?.invoke()
        Box(Modifier.fillMaxWidth().padding(top = 48.dp), contentAlignment = Alignment.Center) {
            EmptyState(Icons.Outlined.Notifications, "No upcoming reminders", "Notes with a reminder appear here.")
        }
    }
    else BoxWithConstraints(modifier) {
        val side = max(Spacing.md, (maxWidth - Dimens.contentMaxWidth) / 2)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = side, end = side, top = Spacing.xs, bottom = Spacing.xl),
            verticalArrangement = Arrangement.spacedBy(Dimens.gridGutter)) {
            if (header != null) item(contentType = "view-header") { header() }
            items(rows, key = { it.text("syncId") }) { reminder ->
                val note = notes.find { it.id == reminder.optLong("noteId") || it.syncId == reminder.text("noteSyncId") }
                ReminderRow(reminder, note, onOpen = { note?.let(onOpenNote) },
                    onDismiss = { scope.launch {
                        try { app.repository.dismissReminder(reminder.text("syncId")) }
                        catch (cancelled: CancellationException) { throw cancelled }
                        catch (problem: Exception) { onError(problem.message ?: "Could not dismiss reminder") }
                    } },
                    onDelete = { removing = reminder })
            }
        }
    }
    removing?.let { reminder ->
        var deleteError by remember(reminder) { mutableStateOf<String?>(null) }
        var deleting by remember(reminder) { mutableStateOf(false) }
        val dialogAction = rememberActionRunner { deleteError = it; deleting = false }
        ConfirmDialog(title = "Delete reminder?", text = "This removes the reminder from this account.", confirmLabel = "Delete",
            destructive = true, error = deleteError, busy = deleting,
            onConfirm = { deleting = true; dialogAction { app.repository.deleteReminder(reminder.text("syncId")); removing = null } },
            onDismiss = { removing = null })
    }
}

@Composable
private fun ReminderRow(reminder: JSONObject, note: Note?, onOpen: () -> Unit, onDismiss: () -> Unit, onDelete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    val due = ReminderFormat.displayDueAt(reminder)
    val overdue = runCatching { Instant.parse(due).isBefore(Instant.now()) }.getOrDefault(false)
    val title = if (note?.locked == true) "Locked note reminder" else reminder.text("title", note?.let { NoteHtml.titleText(it.title) } ?: "Reminder").ifBlank { "Untitled note" }
    val border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)
    val content: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth().padding(start = Spacing.lg, top = Spacing.md, bottom = Spacing.md, end = Spacing.xs),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.lg)) {
            Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.secondaryContainer, CircleShape), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Alarm, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text((if (overdue) "Overdue · " else "") + ReminderFormat.dateTime(due), style = MaterialTheme.typography.bodyMedium,
                    color = if (overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
                repeatDescription(reminder)?.let {
                    Text("Repeats $it", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Done, "Dismiss reminder") }
            Box {
                IconButton(onClick = { menu = true }) { Icon(Icons.Outlined.MoreVert, "More reminder actions") }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (note != null) DropdownMenuItem(text = { Text("Open note") }, leadingIcon = { Icon(Icons.Outlined.OpenInFull, null) },
                        onClick = { menu = false; onOpen() })
                    DropdownMenuItem(text = { Text("Delete reminder") }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null) },
                        onClick = { menu = false; onDelete() })
                }
            }
        }
    }
    if (note != null) Surface(onClick = onOpen, shape = MaterialTheme.shapes.card, border = border, content = content)
    else Surface(shape = MaterialTheme.shapes.card, border = border, content = content)
}

/** The repeat rule in words ("daily", "every 3 days"), or null for a one-time reminder. */
private fun repeatDescription(reminder: JSONObject): String? {
    val rule = runCatching { JSONObject(reminder.text("repeatRule")) }.getOrNull() ?: return null
    return when (val type = rule.text("type")) {
        "" -> null
        "custom_days" -> rule.optInt("intervalDays", 1).let { if (it == 1) "daily" else "every $it days" }
        else -> type
    }
}
