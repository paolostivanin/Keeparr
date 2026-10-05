@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package dev.kept.android.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Intent
import android.text.*
import android.text.style.*
import android.widget.EditText
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.kept.android.KeptApplication
import dev.kept.android.MainActivity
import dev.kept.android.data.*
import dev.kept.android.reminders.ReminderScheduler
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.time.*

@Composable
internal fun NoteEditor(activity: MainActivity, app: KeptApplication, original: Note, reminders: List<JSONObject>, onClose: () -> Unit, onError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val draftViewModel: NoteEditorViewModel = viewModel(
        key = "${app.settings.profile}:${original.syncId}", factory = NoteEditorViewModel.Factory(app, original)
    )
    val raw by draftViewModel.draft.collectAsStateWithLifecycle()
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
    var inaccessible by remember { mutableStateOf(false) }
    val note = Note(raw)
    val lockSource = incoming ?: note
    val cachedNote by remember(note.syncId, app.settings.profile) { app.repository.observeNote(note.syncId) }.collectAsStateWithLifecycle(original)
    val metadataNote = incoming ?: cachedNote ?: note
    val owner = note.owner == app.settings.userId
    val syncStatus by app.repository.status.collectAsStateWithLifecycle()
    val selectedReminder = reminders.find { it.optLong("noteId") == note.id || it.text("noteSyncId") == note.syncId }
    fun change(block: (JSONObject) -> Unit) { draftViewModel.change(block) }
    fun action(block: suspend () -> Unit) { scope.launch { try { block() } catch (problem: Exception) { onError(problem.message ?: "Action failed") } } }
    fun close() { action { draftViewModel.flushAndQueueSync(); onClose() } }
    LaunchedEffect(draftViewModel) { draftViewModel.errors.collect(onError) }
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
    LaunchedEffect(raw.toString(), inaccessible) {
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
        TopAppBar(title = {}, navigationIcon = { IconButton(onClick = ::close) { Icon(Icons.Outlined.ArrowBack, "Save and go back") } }, actions = {
            IconButton(onClick = { change { it.put("pinned", !note.pinned) } }) { Icon(Icons.Outlined.PushPin, if (note.pinned) "Unpin" else "Pin", tint = if (note.pinned) MaterialTheme.colorScheme.primary else LocalContentColor.current) }
            IconButton(onClick = { reminderDialog = true }) { Icon(Icons.Outlined.NotificationAdd, "Set reminder") }
            if (owner) IconButton(onClick = { change { it.put("archived", !note.archived) }; close() }) { Icon(Icons.Outlined.Archive, if (note.archived) "Unarchive" else "Archive") }
        })
    }, bottomBar = {
        Row(Modifier.navigationBarsPadding().fillMaxWidth().horizontalScroll(rememberScrollState())) {
            IconButton(onClick = { picker.launch(arrayOf("*/*")) }) { Icon(Icons.Outlined.AttachFile, "Add image or attachment") }
            if (owner) {
                IconButton(onClick = { palette = true }) { Icon(Icons.Outlined.Palette, "Note color") }
                IconButton(onClick = { organizeDialog = true }) { Icon(Icons.Outlined.Label, "Labels and binder") }
                IconButton(onClick = { shareDialog = true }) { Icon(Icons.Outlined.PersonAdd, "Collaborators") }
            }
            IconButton(onClick = {
                val text = note.title + "\n" + if (note.checklist) note.items.joinToString("\n") { (if (it.optBoolean("done")) "[x] " else "[ ] ") + Html.fromHtml(it.text("data"), 0) } else Html.fromHtml(note.body, 0)
                activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share note"))
            }) { Icon(Icons.Outlined.Share, "Share a copy") }
            IconButton(onClick = { draftViewModel.replace(original.raw.copyJson()) }) { Icon(Icons.Outlined.Undo, "Undo this editing session") }
            if (owner) IconButton(onClick = { change { it.put("trashed", !note.trashed) }; close() }) { Icon(Icons.Outlined.DeleteOutline, if (note.trashed) "Restore note" else "Move to trash") }
        }
    }) { padding ->
        val color = runCatching { Color(android.graphics.Color.parseColor(note.raw.text("bgColor"))) }.getOrDefault(MaterialTheme.colorScheme.background)
        Column(Modifier.fillMaxSize().padding(padding).background(color).verticalScroll(rememberScrollState()).imePadding().padding(20.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(when {
                localSaving -> "Saving on this device…"
                localSaveFailed -> "Draft could not be saved on this device"
                else -> syncStatus
            }, style = MaterialTheme.typography.labelSmall)
             incoming?.let { serverNote ->
                 Card(Modifier.fillMaxWidth()) {
                     Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                         Text("A newer server version is available", style = MaterialTheme.typography.titleSmall)
                         Text("Your draft is kept on this device. Saving it may require conflict resolution.", style = MaterialTheme.typography.bodySmall)
                         if (serverNote.title.isNotBlank()) Text("Server title: ${serverNote.title}", style = MaterialTheme.typography.bodySmall)
                     }
                 }
             }
             val active = editors[note.id].orEmpty()
            Text(if (owner) "Owned by you" else "Owned by ${metadataNote.raw.text("ownerDisplayName", "another Kept user")}", style = MaterialTheme.typography.labelMedium)
            metadataNote.raw.optJSONArray("collaborators")?.objects()?.takeIf { it.isNotEmpty() }?.let { people ->
                Text("Can edit: ${people.joinToString { it.text("displayName", it.text("username", "Kept user")) }}", style = MaterialTheme.typography.labelSmall)
            }
            if (active.isNotEmpty()) Text("Editing: ${active.joinToString()}", style = MaterialTheme.typography.labelSmall)
            OutlinedTextField(note.title, { title -> change { it.put("noteTitle", title) } }, placeholder = { Text("Title") }, modifier = Modifier.fillMaxWidth(), textStyle = MaterialTheme.typography.headlineSmall)
            if (note.checklist) {
                val completedCount = note.items.count { it.optBoolean("done") }
                val collapsed = raw.optBoolean("completedChecklistCollapsed")
                if (completedCount > 0) TextButton(onClick = {
                    val next = !collapsed
                    draftViewModel.updateChecklistCollapsed(next)
                }) { Text(if (collapsed) "Show $completedCount completed item(s)" else "Hide $completedCount completed item(s)") }
                note.items.mapIndexed { index, item -> index to item }.filter { !collapsed || !it.second.optBoolean("done") }.forEach { (index, item) ->
                    key(item.optLong("id", index.toLong())) {
                        Row(Modifier.fillMaxWidth()) {
                            Checkbox(item.optBoolean("done"), onCheckedChange = { done -> change {
                                it.put("checkBoxes", ChecklistAdapter.setDone(it.getJSONArray("checkBoxes"), index, done))
                            } })
                            if (NoteFormat.checklistItemEditable(item.opt("data"))) OutlinedTextField(Html.fromHtml(item.text("data"), 0).toString(), { text ->
                                change { it.getJSONArray("checkBoxes").getJSONObject(index).put("data", NoteFormat.editedChecklistItem(item.opt("data"), text)) }
                            }, modifier = Modifier.weight(1f).padding(start = (item.optInt("indentLevel") * 12).dp), placeholder = { Text("List item") })
                            else Column(Modifier.weight(1f)) {
                                Text(if (item.opt("data") is String) Html.fromHtml(item.text("data"), 0).toString() else "Structured checklist item")
                                Text("This checklist item is preserved and read-only in the native editor.", style = MaterialTheme.typography.labelSmall)
                            }
                            IconButton(onClick = { change { json ->
                                val all = json.getJSONArray("checkBoxes").objects().toMutableList(); all.removeAt(index); json.put("checkBoxes", JSONArray(all))
                            } }) { Icon(Icons.Outlined.Close, "Remove checklist item") }
                        }
                        Row {
                            if (index > 0) TextButton(onClick = { change { json ->
                                json.put("checkBoxes", ChecklistAdapter.move(json.getJSONArray("checkBoxes"), index, index - 1))
                            } }) { Text("Move up") }
                            TextButton(onClick = { change {
                                it.put("checkBoxes", ChecklistAdapter.indent(it.getJSONArray("checkBoxes"), index, 1))
                            } }) { Text("Indent") }
                            if (item.optInt("indentLevel") > 0) TextButton(onClick = { change {
                                it.put("checkBoxes", ChecklistAdapter.indent(it.getJSONArray("checkBoxes"), index, -1))
                            } }) { Text("Outdent") }
                        }
                    }
                }
                TextButton(onClick = { change {
                    val all = it.optJSONArray("checkBoxes") ?: JSONArray()
                    all.put(JSONObject().put("id", System.currentTimeMillis()).put("done", false).put("data", "").put("indentLevel", 0))
                    it.put("checkBoxes", all)
                } }) { Icon(Icons.Outlined.Add, null); Text("List item") }
            } else if (NoteFormat.editable(note.body)) {
                StyledEditor(note.body, reset = note.body, onChange = { html -> change { it.put("noteBody", html) } })
            } else {
                Text(Html.fromHtml(note.body, 0).toString())
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
                    val uri = FileProvider.getUriForFile(app, "dev.kept.android.files", file)
                    activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, attachment.text("mimeType", "application/octet-stream")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                } }) { Icon(Icons.Outlined.AttachFile, null); Text(attachment.text("originalName")) }
            }
            if (metadataNote.labels.isNotEmpty()) Text(metadataNote.labels.joinToString(" · "), style = MaterialTheme.typography.labelMedium)
            if (metadataNote.binder.isNotEmpty()) Text("Binder: ${metadataNote.binder}", style = MaterialTheme.typography.labelMedium)
            selectedReminder?.let { TextButton(onClick = { reminderDialog = true }) { Icon(Icons.Outlined.Schedule, null); Text(it.text("dueAtUtc")) } }
        }
    }
    if (palette) AlertDialog(onDismissRequest = { palette = false }, title = { Text("Note color") }, text = {
        Column { listOf("", "#FFF8B8", "#F39F76", "#FAAFA8", "#E2F6D3", "#B4DDD3", "#D3BFDB", "#D4E4ED", "#E9E3D4").chunked(3).forEach { colors -> Row {
            colors.forEach { color -> Button(onClick = { change { it.put("bgColor", color) }; palette = false }, modifier = Modifier.padding(3.dp).size(64.dp),
                colors = ButtonDefaults.buttonColors(containerColor = if (color.isEmpty()) MaterialTheme.colorScheme.surface else Color(android.graphics.Color.parseColor(color)))) {
                if (color.isEmpty()) Text("×", color = MaterialTheme.colorScheme.onSurface)
            }
        } } } }
    }, confirmButton = {})
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
}

@Composable
private fun StyledEditor(initial: String, reset: String, onChange: (String) -> Unit) {
    val textColor = MaterialTheme.colorScheme.onSurface
    var editor by remember { mutableStateOf<EditText?>(null) }
    var lastEmitted by remember { mutableStateOf(initial) }
    var suppressTextWatcher by remember { mutableStateOf(false) }
    Column {
        Row {
            listOf("B" to android.graphics.Typeface.BOLD, "I" to android.graphics.Typeface.ITALIC).forEach { (label, style) -> TextButton(onClick = {
                editor?.let { view -> if (view.selectionStart < view.selectionEnd) view.text.setSpan(StyleSpan(style), view.selectionStart, view.selectionEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                editor?.let { lastEmitted = Html.toHtml(it.text, Html.TO_HTML_PARAGRAPH_LINES_CONSECUTIVE); onChange(lastEmitted) }
            }) { Text(label) } }
            TextButton(onClick = {
                editor?.let { view -> if (view.selectionStart < view.selectionEnd) view.text.setSpan(UnderlineSpan(), view.selectionStart, view.selectionEnd, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
                editor?.let { lastEmitted = Html.toHtml(it.text, Html.TO_HTML_PARAGRAPH_LINES_CONSECUTIVE); onChange(lastEmitted) }
            }) { Text("U") }
        }
        AndroidView(factory = { context -> EditText(context).apply {
            setText(Html.fromHtml(initial, Html.FROM_HTML_MODE_COMPACT)); hint = "Note"; setTextSize(18f); background = null
            setPadding(0, 8, 0, 8); minLines = 6; gravity = android.view.Gravity.TOP
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
                override fun afterTextChanged(s: Editable?) {
                    if (suppressTextWatcher) return
                    lastEmitted = Html.toHtml(s ?: return, Html.TO_HTML_PARAGRAPH_LINES_CONSECUTIVE)
                    onChange(lastEmitted)
                }
            }); editor = this
        } }, modifier = Modifier.fillMaxWidth().heightIn(min = 160.dp), update = { view ->
            view.setTextColor(android.graphics.Color.argb(255, (textColor.red * 255).toInt(), (textColor.green * 255).toInt(), (textColor.blue * 255).toInt()))
            if (reset != lastEmitted) {
                val selectionStart = view.selectionStart.coerceAtLeast(0)
                val selectionEnd = view.selectionEnd.coerceAtLeast(0)
                suppressTextWatcher = true
                try { view.setText(Html.fromHtml(reset, Html.FROM_HTML_MODE_COMPACT)) }
                finally { suppressTextWatcher = false }
                lastEmitted = reset
                view.setSelection(selectionStart.coerceAtMost(view.text.length), selectionEnd.coerceAtMost(view.text.length))
            }
        })
    }
}

@Composable
private fun ReminderDialog(activity: MainActivity, app: KeptApplication, existing: JSONObject?, onClose: () -> Unit,
    onSave: (String, String, String?) -> Unit, onRemove: () -> Unit) {
    val systemZone = ZoneId.systemDefault()
    val savedTimezone = existing?.text("timezone")?.takeIf { it.isNotBlank() } ?: systemZone.id
    val pickerZone = runCatching { ZoneId.of(savedTimezone) }.getOrDefault(systemZone)
    var timezone by remember(existing?.text("syncId"), savedTimezone) { mutableStateOf(pickerZone.id) }
    var time by remember(existing?.text("syncId"), existing?.text("dueAtUtc"), timezone) {
        mutableStateOf(runCatching { Instant.parse(existing?.text("dueAtUtc")) }.getOrNull()?.atZone(pickerZone)
            ?: ZonedDateTime.now(pickerZone).plusHours(1).withSecond(0).withNano(0))
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
        TextButton(onClick = { DatePickerDialog(activity, { _, year, month, day -> time = time.withDayOfMonth(1).withYear(year).withMonth(month + 1).withDayOfMonth(day) }, time.year, time.monthValue - 1, time.dayOfMonth).show() }) { Text(time.toLocalDate().toString()) }
        TextButton(onClick = { TimePickerDialog(activity, { _, hour, minute -> time = time.withHour(hour).withMinute(minute) }, time.hour, time.minute, true).show() }) { Text(time.toLocalTime().toString()) }
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
        Text("Time zone: $timezone", style = MaterialTheme.typography.bodySmall)
        if (!scheduler.notificationsAllowed()) TextButton(onClick = activity::requestNotifications) { Text("Allow reminder notifications") }
        if (!scheduler.precise()) TextButton(onClick = activity::requestPreciseAlarms) { Text("Allow precise delivery (otherwise may be delayed)") }
    } }, confirmButton = { TextButton(onClick = { onSave(time.toInstant().toString(), timezone, if (repeat == "none") null else JSONObject()
        .put("type", repeat).put("moveToTopOnTrigger", moveToTop)
        .also { if (repeat == "custom_days") it.put("intervalDays", intervalDays.toIntOrNull()?.coerceIn(1, 365) ?: 1) }.toString()) }) { Text("Save") } },
        dismissButton = { if (existing != null) TextButton(onClick = onRemove) { Text("Remove reminder") } else TextButton(onClick = onClose) { Text("Cancel") } })
}

@Composable
private fun ShareDialog(app: KeptApplication, note: Note, onClose: () -> Unit, onSave: (List<Long>) -> Unit, onError: (String) -> Unit) {
    var users by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var selected by remember { mutableStateOf(note.raw.optJSONArray("collaborators")?.objects().orEmpty().map { it.getLong("id") }.toSet()) }
    var loading by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        try { users = app.repository.shareUsers().filter { it.optLong("id") != app.settings.userId } }
        catch (problem: Exception) { onError(problem.message ?: "Connect to load collaborators") }
        finally { loading = false }
    }
    AlertDialog(onDismissRequest = onClose, title = { Text("Collaborators") }, text = { Column(Modifier.verticalScroll(rememberScrollState())) {
        Text("People on this Kept server can edit this note. Reminders remain personal.")
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
