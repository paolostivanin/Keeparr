@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.ui.ExperimentalComposeUiApi::class)
package dev.keeparr.android.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Intent
import android.text.*
import android.text.format.DateFormat
import android.text.style.*
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.MainActivity
import dev.keeparr.android.data.*
import dev.keeparr.android.reminders.ReminderScheduler
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.time.*
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

// Lets the screen-level tap target reach the body EditText, which lives inside an AndroidView.
internal class BodyEditorHandle {
    var view: EditText? = null
    fun focusEnd() {
        val editor = view ?: return
        editor.requestFocus()
        editor.setSelection(editor.text.length)
        editor.post { editor.context.getSystemService(InputMethodManager::class.java)?.showSoftInput(editor, InputMethodManager.SHOW_IMPLICIT) }
    }
}

@Composable
internal fun NoteEditor(activity: MainActivity, app: KeeparrApplication, original: Note, reminders: List<JSONObject>, onClose: () -> Unit, onError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val sessions: EditorSessionStores = viewModel(activity)
    val sessionKey = "${app.settings.profile}:${original.syncId}"
    val draftViewModel: NoteEditorViewModel = viewModel(
        viewModelStoreOwner = sessions.ownerFor(sessionKey), key = sessionKey, factory = NoteEditorViewModel.Factory(app, original)
    )
    val raw by draftViewModel.draft.collectAsStateWithLifecycle()
    val draftGeneration by draftViewModel.draftGeneration.collectAsStateWithLifecycle()
    val changed by draftViewModel.dirty.collectAsStateWithLifecycle()
    val incoming by draftViewModel.incoming.collectAsStateWithLifecycle()
    val localSaving by draftViewModel.localSaving.collectAsStateWithLifecycle()
    val localSaveFailed by draftViewModel.localSaveFailed.collectAsStateWithLifecycle()
    var unlockedLockHash by remember(original.syncId) { mutableStateOf("") }
    var passcode by remember { mutableStateOf("") }
    var reminderDialog by remember { mutableStateOf(false) }
    var shareDialog by remember { mutableStateOf(false) }
    var organizeDialog by remember { mutableStateOf(false) }
    var palette by remember { mutableStateOf(false) }
    var moreMenuExpanded by remember { mutableStateOf(false) }
    var confirmMoveToTrash by remember { mutableStateOf(false) }
    var confirmHideCheckboxes by remember { mutableStateOf(false) }
    var inaccessible by remember { mutableStateOf(false) }
    val note = Note(raw)
    val lockSource = incoming ?: note
    val cachedNote by remember(note.syncId, app.settings.profile) { app.repository.observeNote(note.syncId) }.collectAsStateWithLifecycle(original)
    val metadataNote = incoming ?: cachedNote ?: note
    val owner = note.owner == app.settings.userId
    val syncStatus by app.repository.status.collectAsStateWithLifecycle()
    val selectedReminder = reminders.find { it.text("status") == "pending" && it.text("dueAtUtc").isNotBlank() &&
        (it.optLong("noteId") == note.id || it.text("noteSyncId") == note.syncId) }
    fun change(vararg touched: String, block: (JSONObject) -> Unit) { draftViewModel.change(*touched, block = block) }
    fun action(block: suspend () -> Unit) { scope.launch { try { block() } catch (problem: Exception) { onError(problem.message ?: "Action failed") } } }
    fun close() { action { draftViewModel.finish(); onClose() } }
    val bodyHandle = remember { BodyEditorHandle() }
    val keyboard = LocalSoftwareKeyboardController.current
    val itemFocus = remember { mutableMapOf<Long, FocusRequester>() }
    var pendingFocusItemId by remember { mutableStateOf<Long?>(null) }
    fun checklistItemId(item: JSONObject, index: Int) = item.optLong("id", index.toLong())
    fun addChecklistItem() {
        val id = System.currentTimeMillis()
        change("checkBoxes") {
            val all = it.optJSONArray("checkBoxes") ?: JSONArray()
            all.put(JSONObject().put("id", id).put("done", false).put("data", "").put("indentLevel", 0))
            it.put("checkBoxes", all)
        }
        pendingFocusItemId = id
    }
    // Tapping blank editor space behaves like tapping the end of the content.
    fun focusEditorEnd() {
        if (note.checklist) {
            val collapsed = raw.optBoolean("completedChecklistCollapsed")
            val last = note.items.withIndex().lastOrNull { (_, item) ->
                (!collapsed || !item.optBoolean("done")) && NoteFormat.checklistItemEditable(item.opt("data"))
            }
            if (last == null) addChecklistItem() else pendingFocusItemId = checklistItemId(last.value, last.index)
        } else if (NoteFormat.editable(note.body)) bodyHandle.focusEnd()
    }
    fun showCheckboxes() {
        val firstId = System.currentTimeMillis()
        var added = emptyList<JSONObject>()
        change { added = NoteFormat.showCheckboxes(it, firstId) }
        if (added.isEmpty()) addChecklistItem() else pendingFocusItemId = added.last().optLong("id")
    }
    fun hideCheckboxes() { change { NoteFormat.hideCheckboxes(it) } }
    // The new row is composed a frame after the draft changes, so retry on every draft update until its requester exists.
    LaunchedEffect(pendingFocusItemId, draftGeneration) {
        val requester = pendingFocusItemId?.let { itemFocus[it] } ?: return@LaunchedEffect
        if (runCatching { requester.requestFocus() }.isSuccess) { keyboard?.show(); pendingFocusItemId = null }
    }
    LaunchedEffect(draftViewModel) { draftViewModel.errors.collect(onError) }
    // The debounce window must not be lost when the editor leaves the foreground.
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, draftViewModel) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_STOP) app.scope.launch { runCatching { draftViewModel.flushLocal() } }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    BackHandler { if (inaccessible) onClose() else close() }
    LaunchedEffect(cachedNote) {
        if (original.id > 0 && cachedNote == null && !inaccessible) {
            val hadUnsavedChanges = changed
            inaccessible = true
            if (hadUnsavedChanges) draftViewModel.preserveForRecovery()
        }
    }
    LaunchedEffect(cachedNote?.id, cachedNote?.revision, changed) {
        val incoming = cachedNote
        if (incoming != null) draftViewModel.applyIncoming(incoming)
    }
    LaunchedEffect(draftGeneration, inaccessible) {
        if (changed && !inaccessible) {
            delay(600)
            if (!changed || inaccessible) return@LaunchedEffect
            if (changed && !inaccessible) draftViewModel.flushAndQueueSync()
        }
    }
    DisposableEffect(note.id, inaccessible) {
        app.repository.presence(note.id.takeUnless { inaccessible })
        onDispose { app.repository.presence(null) }
    }
    val editors by app.repository.editors.collectAsState()
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) action { draftViewModel.flushAndQueueSync(); app.repository.attach(Note(raw), Media(app).stage(uri)) }
    }
    if (inaccessible) {
        AlertDialog(onDismissRequest = onClose, title = { Text("Note access removed") },
            text = { Text("This note is no longer available on the server. Your current draft is saved on this device and will not be sent to that note.") },
            confirmButton = { TextButton(onClick = { action { app.repository.recoverDraftAsCopy(app.settings.profile, note.syncId); onClose() } }) { Text("Recover as new note") } },
            dismissButton = { TextButton(onClick = onClose) { Text("Keep for later") } })
        return
    }
    if (lockSource.locked && unlockedLockHash != lockSource.raw.text("lockHash")) {
        AlertDialog(onDismissRequest = onClose, title = { Text("Unlock note") }, text = {
            OutlinedTextField(passcode, { passcode = it }, label = { Text("Note passcode") }, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation())
        }, confirmButton = { TextButton(onClick = { action {
            if (withContext(Dispatchers.Default) { verifyLock(lockSource, passcode) }) unlockedLockHash = lockSource.raw.text("lockHash") else onError("Incorrect note passcode")
        } }) { Text("Unlock") } }, dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } })
        return
    }
    Scaffold(topBar = {
        TopAppBar(title = {},
            navigationIcon = { IconButton(onClick = ::close) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Save and go back") } }, actions = {
                IconButton(onClick = { change("pinned") { it.put("pinned", !note.pinned) } }) {
                    Icon(Icons.Outlined.PushPin, if (note.pinned) "Unpin" else "Pin",
                        tint = if (note.pinned) MaterialTheme.colorScheme.primary else LocalContentColor.current)
                }
                if (owner && !note.trashed) IconButton(onClick = { change { it.put("archived", !note.archived) }; close() }) {
                    Icon(Icons.Outlined.Archive, if (note.archived) "Unarchive" else "Archive")
                }
                Box {
                    IconButton(onClick = { moreMenuExpanded = true }) { Icon(Icons.Outlined.MoreVert, "More note actions") }
                    DropdownMenu(expanded = moreMenuExpanded, onDismissRequest = { moreMenuExpanded = false }) {
                        DropdownMenuItem(text = { Text("Remind me") }, leadingIcon = { Icon(Icons.Outlined.NotificationAdd, null) },
                            onClick = { moreMenuExpanded = false; reminderDialog = true })
                        if (owner) {
                            DropdownMenuItem(text = { Text("Labels and binder") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Label, null) },
                                onClick = { moreMenuExpanded = false; organizeDialog = true })
                            DropdownMenuItem(text = { Text("Collaborators") }, leadingIcon = { Icon(Icons.Outlined.PersonAdd, null) },
                                onClick = { moreMenuExpanded = false; shareDialog = true })
                        }
                        if (note.checklist && NoteFormat.canHideCheckboxes(note.items)) {
                            DropdownMenuItem(text = { Text("Hide checkboxes") }, leadingIcon = { Icon(Icons.Outlined.CheckBox, null) }, onClick = {
                                moreMenuExpanded = false
                                if (NoteFormat.checkedItemCount(note.items) > 0) confirmHideCheckboxes = true else hideCheckboxes()
                            })
                        } else if (!note.checklist && NoteFormat.editable(note.body)) {
                            DropdownMenuItem(text = { Text("Show checkboxes") }, leadingIcon = { Icon(Icons.Outlined.CheckBox, null) },
                                onClick = { moreMenuExpanded = false; showCheckboxes() })
                        }
                        DropdownMenuItem(text = { Text("Share a copy") }, leadingIcon = { Icon(Icons.Outlined.Share, null) }, onClick = {
                            moreMenuExpanded = false
                            val text = note.title + "\n" + if (note.checklist) note.items.joinToString("\n") {
                                (if (it.optBoolean("done")) "[x] " else "[ ] ") + NoteFormat.displayText(it.text("data"))
                            } else NoteFormat.displayText(note.body)
                            activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                                .putExtra(Intent.EXTRA_TEXT, text), "Share note"))
                        })
                        DropdownMenuItem(text = { Text("Undo changes") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Undo, null) },
                            onClick = { moreMenuExpanded = false; draftViewModel.replace(original.raw.copyJson()) })
                        if (owner) {
                            if (note.trashed) DropdownMenuItem(text = { Text("Restore") }, leadingIcon = { Icon(Icons.Outlined.RestoreFromTrash, null) },
                                onClick = { moreMenuExpanded = false; action {
                                    draftViewModel.flushAndQueueSync()
                                    app.repository.setTrashed(listOf(note.syncId), false)
                                    onClose()
                                } })
                            else DropdownMenuItem(text = { Text("Move to Trash") }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null) },
                                onClick = { moreMenuExpanded = false; confirmMoveToTrash = true })
                        }
                    }
                }
            })
    }, bottomBar = {
        val color = NotePalette.parse(note.raw.text("bgColor"))?.let { Color(it) } ?: MaterialTheme.colorScheme.surface
        Surface(color = color, tonalElevation = 2.dp) {
            Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 8.dp),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                IconButton(onClick = { picker.launch(arrayOf("*/*")) }) { Icon(Icons.Outlined.AttachFile, "Add image or attachment") }
                if (owner) IconButton(onClick = { palette = true }) { Icon(Icons.Outlined.Palette, "Background color") }
                IconButton(onClick = { reminderDialog = true }) { Icon(Icons.Outlined.NotificationAdd, "Reminder") }
                Spacer(Modifier.weight(1f))
                Text(when {
                    localSaving -> "Saving…"
                    localSaveFailed -> "Not saved"
                    syncStatus.isNotBlank() -> syncStatus
                    else -> "Saved"
                }, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(horizontal = 8.dp))
            }
        }
    }) { padding ->
        val color = NotePalette.parse(note.raw.text("bgColor"))?.let { Color(it) } ?: MaterialTheme.colorScheme.background
        val foreground = if (color.luminance() > .4f) Color(0xFF272727) else Color(0xFFF5F3EF)
        Surface(Modifier.fillMaxSize().padding(padding), color = color, contentColor = foreground) {
        Column(Modifier.fillMaxSize().clickable(remember { MutableInteractionSource() }, indication = null) { focusEditorEnd() }
            .verticalScroll(rememberScrollState()).imePadding().padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            incoming?.let { serverNote ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("A newer server version is available", style = MaterialTheme.typography.titleSmall)
                        Text("Your draft is kept on this device. Saving it may require conflict resolution.", style = MaterialTheme.typography.bodySmall)
                        if (serverNote.title.isNotBlank()) Text("Server title: ${serverNote.title}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (!owner) Text("Shared by ${metadataNote.raw.text("ownerDisplayName", "another Keeparr user")}",
                style = MaterialTheme.typography.labelSmall, color = foreground.copy(alpha = .7f))
            editors[note.id].orEmpty().takeIf { it.isNotEmpty() }?.let { active ->
                Text("Editing with ${active.joinToString()}", style = MaterialTheme.typography.labelSmall, color = foreground.copy(alpha = .7f))
            }
            BasicTextField(value = note.title, onValueChange = { title -> change("noteTitle") { it.put("noteTitle", title) } },
                modifier = Modifier.fillMaxWidth(), singleLine = true,
                textStyle = MaterialTheme.typography.headlineSmall.copy(color = foreground), cursorBrush = SolidColor(foreground),
                decorationBox = { inner -> Box {
                    if (note.title.isBlank()) Text("Title", style = MaterialTheme.typography.headlineSmall, color = foreground.copy(alpha = .55f))
                    inner()
                } })
            if (note.title.isNotBlank()) HorizontalDivider(color = foreground.copy(alpha = .12f))
            if (note.checklist) {
                val completedCount = note.items.count { it.optBoolean("done") }
                val collapsed = raw.optBoolean("completedChecklistCollapsed")
                if (completedCount > 0) TextButton(onClick = { draftViewModel.updateChecklistCollapsed(!collapsed) }) {
                    Text(if (collapsed) "Show completed ($completedCount)" else "Hide completed ($completedCount)")
                }
                note.items.mapIndexed { index, item -> index to item }.filter { !collapsed || !it.second.optBoolean("done") }.forEach { (index, item) ->
                    key(checklistItemId(item, index)) {
                        var itemMenuExpanded by remember { mutableStateOf(false) }
                        val requester = itemFocus.getOrPut(checklistItemId(item, index)) { FocusRequester() }
                        Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            Checkbox(item.optBoolean("done"), onCheckedChange = { done -> change("checkBoxes") {
                                it.put("checkBoxes", ChecklistAdapter.setDone(it.getJSONArray("checkBoxes"), index, done))
                            } })
                            if (NoteFormat.checklistItemEditable(item.opt("data"))) BasicTextField(
                                value = NoteFormat.displayText(item.text("data")),
                                onValueChange = { text -> change("checkBoxes") {
                                    it.getJSONArray("checkBoxes").getJSONObject(index).put("data", NoteFormat.editedChecklistItem(item.opt("data"), text))
                                } }, modifier = Modifier.weight(1f).padding(start = (item.optInt("indentLevel") * 12).dp).focusRequester(requester),
                                textStyle = MaterialTheme.typography.bodyLarge.copy(color = foreground), cursorBrush = SolidColor(foreground),
                                decorationBox = { inner -> Box {
                                    if (item.text("data").isBlank()) Text("List item", color = foreground.copy(alpha = .55f))
                                    inner()
                                } })
                            else Column(Modifier.weight(1f)) {
                                Text(if (item.opt("data") is String) NoteFormat.displayText(item.text("data")) else "Structured checklist item")
                                Text("This checklist item is preserved and read-only in the native editor.", style = MaterialTheme.typography.labelSmall)
                            }
                            Box {
                                IconButton(onClick = { itemMenuExpanded = true }) { Icon(Icons.Outlined.MoreVert, "Checklist item actions") }
                                DropdownMenu(expanded = itemMenuExpanded, onDismissRequest = { itemMenuExpanded = false }) {
                                    if (index > 0) DropdownMenuItem(text = { Text("Move up") }, onClick = { itemMenuExpanded = false; change("checkBoxes") {
                                        it.put("checkBoxes", ChecklistAdapter.move(it.getJSONArray("checkBoxes"), index, index - 1))
                                    } })
                                    DropdownMenuItem(text = { Text("Indent") }, onClick = { itemMenuExpanded = false; change("checkBoxes") {
                                        it.put("checkBoxes", ChecklistAdapter.indent(it.getJSONArray("checkBoxes"), index, 1))
                                    } })
                                    if (item.optInt("indentLevel") > 0) DropdownMenuItem(text = { Text("Outdent") }, onClick = { itemMenuExpanded = false; change("checkBoxes") {
                                        it.put("checkBoxes", ChecklistAdapter.indent(it.getJSONArray("checkBoxes"), index, -1))
                                    } })
                                    DropdownMenuItem(text = { Text("Remove item") }, leadingIcon = { Icon(Icons.Outlined.Close, null) },
                                        onClick = { itemMenuExpanded = false; change("checkBoxes") { json ->
                                            val all = json.getJSONArray("checkBoxes").objects().toMutableList()
                                            all.removeAt(index)
                                            json.put("checkBoxes", JSONArray(all))
                                        } })
                                }
                            }
                        }
                    }
                }
                TextButton(onClick = ::addChecklistItem) { Icon(Icons.Outlined.Add, null); Text("List item") }
            } else if (NoteFormat.editable(note.body)) {
                StyledEditor(note.body, reset = note.body, textColor = foreground, handle = bodyHandle, onChange = { html -> change("noteBody") { it.put("noteBody", html) } })
            } else {
                Text(NoteFormat.displayText(note.body))
                Text("This note contains formatting the native editor does not support yet. Its body is preserved; other fields remain editable.", style = MaterialTheme.typography.bodySmall)
            }
            val images = (metadataNote.raw.optJSONArray("images")?.objects().orEmpty() + note.raw.optJSONArray("images")?.objects().orEmpty())
                .distinctBy { it.text("dataUrl").ifBlank { it.text("id") } }
            images.forEach { MediaImage(app, it.text("dataUrl")) }
            val attachments = (metadataNote.raw.optJSONArray("attachments")?.objects().orEmpty() + note.raw.optJSONArray("attachments")?.objects().orEmpty())
                .distinctBy { it.text("syncId").ifBlank { it.optLong("id").toString() } }
            attachments.forEach { attachment ->
                TextButton(onClick = { action {
                    val file = Media(app).download("/api/attachments/${attachment.getLong("id")}")
                    val uri = FileProvider.getUriForFile(app, "dev.keeparr.android.files", file)
                    activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, attachment.text("mimeType", "application/octet-stream")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                } }) { Icon(Icons.Outlined.AttachFile, null); Text(attachment.text("originalName")) }
            }
            if (metadataNote.labels.isNotEmpty()) Text(metadataNote.labels.joinToString(" · "), style = MaterialTheme.typography.labelMedium)
            if (metadataNote.binder.isNotEmpty()) Text("Binder: ${metadataNote.binder}", style = MaterialTheme.typography.labelMedium)
            selectedReminder?.let { TextButton(onClick = { reminderDialog = true }) {
                Icon(Icons.Outlined.Schedule, null); Text(ReminderFormat.dateTime(ReminderFormat.displayDueAt(it)))
            } }
         }
         }
    }
    if (palette) NoteColorPicker(note.raw.text("bgColor"), onDismiss = { palette = false }, onSelect = { selected ->
        change { it.put("bgColor", selected).put("bgImage", "") }
        palette = false
    })
    if (organizeDialog) {
        var labels by remember { mutableStateOf(note.labels.joinToString(", ")) }
        var binder by remember { mutableStateOf(note.binder) }
        AlertDialog(onDismissRequest = { organizeDialog = false }, title = { Text("Organize note") }, text = { Column {
            OutlinedTextField(labels, { labels = it }, label = { Text("Labels, separated by commas") })
            OutlinedTextField(binder, { binder = it }, label = { Text("Binder (optional)") })
        } }, confirmButton = { TextButton(onClick = { change { it.put("labels", JSONArray(labels.split(',').map { label -> label.trim() }.filter { it.isNotEmpty() }.distinct().map { label -> JSONObject().put("name", label).put("added", true) })).put("binder", binder.trim()) }; organizeDialog = false }) { Text("Save") } })
    }
    if (reminderDialog) ReminderDialog(activity, app, selectedReminder, onClose = { reminderDialog = false }, onSave = { due, timezone, repeat ->
        action { draftViewModel.flushAndQueueSync(); app.repository.setReminder(Note(raw), due, timezone, repeat); reminderDialog = false }
    }, onRemove = { selectedReminder?.let { action { app.repository.deleteReminder(it.getString("syncId")); reminderDialog = false } } })
    if (shareDialog) ShareDialog(app, note, onClose = { shareDialog = false }, onSave = { ids -> action { draftViewModel.flushAndQueueSync(); app.repository.share(Note(raw), ids); shareDialog = false } }, onError)
    if (confirmHideCheckboxes) {
        val checked = NoteFormat.checkedItemCount(note.items)
        AlertDialog(onDismissRequest = { confirmHideCheckboxes = false }, title = { Text("Hide checkboxes?") },
            text = { Text("$checked checked ${if (checked == 1) "item" else "items"} will be removed. The other items become lines of text.") },
            confirmButton = { TextButton(onClick = { confirmHideCheckboxes = false; hideCheckboxes() }) { Text("Hide checkboxes") } },
            dismissButton = { TextButton(onClick = { confirmHideCheckboxes = false }) { Text("Cancel") } })
    }
    if (confirmMoveToTrash) AlertDialog(onDismissRequest = { confirmMoveToTrash = false }, title = { Text("Move note to Trash?") },
        text = { Text("This note will be moved to Trash. You can restore it later.") },
        confirmButton = { TextButton(onClick = { action {
            draftViewModel.flushAndQueueSync()
            app.repository.setTrashed(listOf(note.syncId), true)
            confirmMoveToTrash = false
            onClose()
        } }) { Text("Move to Trash") } },
        dismissButton = { TextButton(onClick = { confirmMoveToTrash = false }) { Text("Cancel") } })
}

@Composable
private fun NoteColorPicker(selectedColor: String, onDismiss: () -> Unit, onSelect: (String) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Background", style = MaterialTheme.typography.titleLarge)
            Text("Colors", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            LazyVerticalGrid(columns = GridCells.Fixed(5), modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                items(NotePalette.colors) { swatch ->
                    val isSelected = NotePalette.sameColor(selectedColor, swatch.hex)
                    val color = if (swatch.hex.isEmpty()) MaterialTheme.colorScheme.surfaceVariant
                        else Color(android.graphics.Color.parseColor(swatch.hex))
                    val foreground = if (color.luminance() > .4f) Color(0xFF272727) else Color(0xFFF5F3EF)
                    Box(Modifier.size(48.dp).clip(CircleShape).background(color)
                        .border(if (isSelected) 3.dp else 1.dp, if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, CircleShape)
                        .semantics { contentDescription = "${swatch.name} background color"; selected = isSelected; role = Role.RadioButton }
                        .clickable { onSelect(swatch.hex) }, contentAlignment = androidx.compose.ui.Alignment.Center) {
                        if (swatch.hex.isEmpty()) Text("×", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        else if (isSelected) Icon(Icons.Outlined.Check, "Selected color", tint = foreground)
                    }
                }
            }
        }
    }
}

@Composable
private fun StyledEditor(initial: String, reset: String, textColor: Color, handle: BodyEditorHandle, onChange: (String) -> Unit) {
    var editor by remember { mutableStateOf<EditText?>(null) }
    DisposableEffect(handle) { onDispose { handle.view = null } }
    var lastEmitted by remember { mutableStateOf(initial) }
    var suppressTextWatcher by remember { mutableStateOf(false) }
    Column {
        Row {
            listOf("B" to android.graphics.Typeface.BOLD, "I" to android.graphics.Typeface.ITALIC).forEach { (label, style) -> TextButton(onClick = {
                editor?.let { view -> if (view.selectionStart < view.selectionEnd) view.text.setSpan(StyleSpan(style), view.selectionStart, view.selectionEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                editor?.let { lastEmitted = NoteFormat.serialize(it.text); onChange(lastEmitted) }
            }) { Text(label) } }
            TextButton(onClick = {
                editor?.let { view -> if (view.selectionStart < view.selectionEnd) view.text.setSpan(UnderlineSpan(), view.selectionStart, view.selectionEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                editor?.let { lastEmitted = NoteFormat.serialize(it.text); onChange(lastEmitted) }
            }) { Text("U") }
        }
        AndroidView(factory = { context -> EditText(context).apply {
            setText(NoteFormat.spanned(initial)); hint = "Note"; setTextSize(18f); background = null
            setPadding(0, 8, 0, 8); minLines = 6; gravity = android.view.Gravity.TOP
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) {
                    if (suppressTextWatcher) return
                    lastEmitted = NoteFormat.serialize(s ?: return)
                    onChange(lastEmitted)
                }
            }); editor = this; handle.view = this
        } }, modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp), update = { view ->
            view.setTextColor(android.graphics.Color.argb(255, (textColor.red * 255).toInt(), (textColor.green * 255).toInt(), (textColor.blue * 255).toInt()))
            if (reset != lastEmitted) {
                val selectionStart = view.selectionStart.coerceAtLeast(0)
                val selectionEnd = view.selectionEnd.coerceAtLeast(0)
                suppressTextWatcher = true
                try { view.setText(NoteFormat.spanned(reset)) }
                finally { suppressTextWatcher = false }
                lastEmitted = reset
                view.setSelection(selectionStart.coerceAtMost(view.text.length), selectionEnd.coerceAtMost(view.text.length))
            }
        })
    }
}

@Composable
private fun ReminderDialog(activity: MainActivity, app: KeeparrApplication, existing: JSONObject?, onClose: () -> Unit,
    onSave: (String, String, String?) -> Unit, onRemove: () -> Unit) {
    val systemZone = ZoneId.systemDefault()
    val timezone = systemZone.id
    var time by remember(existing?.text("syncId"), existing?.text("dueAtUtc"), timezone) {
        mutableStateOf(runCatching { Instant.parse(existing?.let { ReminderFormat.displayDueAt(it) }) }.getOrNull()?.atZone(systemZone)
            ?: ZonedDateTime.now(systemZone).plusHours(1).withSecond(0).withNano(0))
    }
    val existingRepeat = remember(existing?.text("repeatRule")) { runCatching { JSONObject(existing?.text("repeatRule") ?: "") }.getOrNull() }
    var repeat by remember { mutableStateOf(existingRepeat?.text("type") ?: "none") }
    var intervalDays by remember { mutableStateOf((existingRepeat?.optInt("intervalDays", 2) ?: 2).coerceAtLeast(1).toString()) }
    var moveToTop by remember { mutableStateOf(existingRepeat?.optBoolean("moveToTopOnTrigger") ?: false) }
    val scheduler = app.reminders
    AlertDialog(onDismissRequest = onClose, title = { Text("Remind me") }, text = { Column {
        Row(Modifier.horizontalScroll(rememberScrollState())) {
            TextButton(onClick = { time = ZonedDateTime.now(time.zone).withHour(time.hour).withMinute(time.minute).withSecond(0).withNano(0) }) { Text("Today") }
            TextButton(onClick = { time = ZonedDateTime.now(time.zone).plusDays(1).withHour(time.hour).withMinute(time.minute).withSecond(0).withNano(0) }) { Text("Tomorrow") }
        }
        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            TextButton(onClick = { DatePickerDialog(activity, { _, year, month, day ->
                time = time.withDayOfMonth(1).withYear(year).withMonth(month + 1).withDayOfMonth(day)
            }, time.year, time.monthValue - 1, time.dayOfMonth).show() }) {
                Icon(Icons.Outlined.CalendarToday, null); Spacer(Modifier.width(6.dp))
                Text(time.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.getDefault())))
            }
            TextButton(onClick = { TimePickerDialog(activity, { _, hour, minute -> time = time.withHour(hour).withMinute(minute) },
                time.hour, time.minute, DateFormat.is24HourFormat(activity)).show() }) {
                Icon(Icons.Outlined.Schedule, null); Spacer(Modifier.width(6.dp))
                Text(time.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.getDefault())))
            }
        }
        Text("Repeat")
        Row(Modifier.horizontalScroll(rememberScrollState())) { listOf("none", "daily", "weekly", "monthly", "custom_days").forEach { type ->
            FilterChip(repeat == type, { repeat = type }, label = { Text(if (type == "custom_days") "Every N days" else type.replaceFirstChar { it.uppercase() }) }, modifier = Modifier.padding(2.dp))
        } }
        if (repeat == "custom_days") OutlinedTextField(intervalDays, { value -> intervalDays = value.filter(Char::isDigit).take(3) },
            label = { Text("Interval in days") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        if (repeat != "none") Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text("Move note to top when it fires", Modifier.weight(1f))
            Switch(moveToTop, { moveToTop = it })
        }
        Text("Phone time · $timezone", style = MaterialTheme.typography.bodySmall)
        if (!scheduler.notificationsAllowed()) TextButton(onClick = activity::requestNotifications) { Text("Allow reminder notifications") }
        if (!scheduler.precise()) TextButton(onClick = activity::requestPreciseAlarms) { Text("Allow precise delivery (otherwise may be delayed)") }
    } }, confirmButton = { TextButton(onClick = { onSave(time.toInstant().toString(), timezone, if (repeat == "none") null else JSONObject()
        .put("type", repeat).put("moveToTopOnTrigger", moveToTop)
        .also { if (repeat == "custom_days") it.put("intervalDays", intervalDays.toIntOrNull()?.coerceIn(1, 365) ?: 1) }.toString()) }) { Text("Save") } },
        dismissButton = { if (existing != null) TextButton(onClick = onRemove) { Text("Remove reminder") } else TextButton(onClick = onClose) { Text("Cancel") } })
}

@Composable
private fun ShareDialog(app: KeeparrApplication, note: Note, onClose: () -> Unit, onSave: (List<Long>) -> Unit, onError: (String) -> Unit) {
    var users by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var selected by remember { mutableStateOf(note.raw.optJSONArray("collaborators")?.objects().orEmpty().map { it.getLong("id") }.toSet()) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        try { users = app.repository.shareUsers().filter { it.optLong("id") != app.settings.userId } }
        catch (problem: Exception) { onError(problem.message ?: "Connect to load collaborators") }
        finally { loading = false }
    }
    AlertDialog(onDismissRequest = onClose, title = { Text("Collaborators") }, text = { Column(Modifier.verticalScroll(rememberScrollState())) {
        Text("People on this Keeparr server can edit this note. Reminders remain personal.")
        if (loading) CircularProgressIndicator()
        users.forEach { user -> Row {
            val id = user.getLong("id")
            Checkbox(id in selected, { selected = if (it) selected + id else selected - id })
            Text(user.text("displayName", user.text("username")), Modifier.padding(top = 12.dp))
        } }
    } }, confirmButton = { TextButton(onClick = { onSave(selected.toList()) }, enabled = !loading) { Text("Save") } }, dismissButton = { TextButton(onClick = onClose) { Text("Cancel") } })
}

private fun verifyLock(note: Note, passcode: String): Boolean {
    val salt = note.raw.text("lockSalt"); val expected = note.raw.text("lockHash")
    val bytes = if (expected.startsWith("pbkdf2:")) javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        .generateSecret(javax.crypto.spec.PBEKeySpec(passcode.toCharArray(), salt.toByteArray(), 150000, 256)).encoded
    else java.security.MessageDigest.getInstance("SHA-256").digest("$salt:$passcode".toByteArray())
    val actual = (if (expected.startsWith("pbkdf2:")) "pbkdf2:" else "sha256:") + android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
    return java.security.MessageDigest.isEqual(actual.toByteArray(), expected.toByteArray())
}
