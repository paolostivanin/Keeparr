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
import androidx.compose.foundation.lazy.items as listItems
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
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
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
import dev.keeparr.android.data.html.EmbedKind
import dev.keeparr.android.data.html.EmbedSpan
import dev.keeparr.android.data.html.HtmlMode
import dev.keeparr.android.data.html.NoteHtml
import dev.keeparr.android.ui.editor.*
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.runtime.saveable.rememberSaveable
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.time.*
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

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
    fun change(vararg touched: String, external: Boolean = false, structural: Boolean = false, block: (JSONObject) -> Unit) =
        draftViewModel.change(*touched, external = external, structural = structural, block = block)
    fun action(block: suspend () -> Unit) { scope.launch { try { block() } catch (problem: Exception) { onError(problem.message ?: "Action failed") } } }
    fun close() { action { draftViewModel.finish(); onClose() } }
    val externalEdits by draftViewModel.externalEdits.collectAsStateWithLifecycle()
    val canUndo by draftViewModel.canUndo.collectAsStateWithLifecycle()
    val canRedo by draftViewModel.canRedo.collectAsStateWithLifecycle()
    val restore by draftViewModel.restore.collectAsStateWithLifecycle()
    val focus = remember { RichEditorFocus() }
    val bodyState = rememberRichEditorState(HtmlMode.Body, "body")
    val rowStates = remember { mutableMapOf<Long, RichEditorState>() }
    val embeds = remember { EmbedBinder(app, scope) }
    var pendingFocus by remember { mutableStateOf<Pair<Long, Int?>?>(null) }
    var formatBar by rememberSaveable { mutableStateOf(false) }
    var embedDetail by remember { mutableStateOf<Pair<EmbedSpan, Int>?>(null) }
    // A checklist shows its body above the rows once the body has content (a hybrid note), and keeps showing it while it is edited.
    var bodyShown by rememberSaveable(original.syncId) { mutableStateOf(NoteHtml.hasMeaningfulBody(original.body)) }
    val hybrid = note.checklist && (bodyShown || NoteHtml.hasMeaningfulBody(note.body))
    val hideDone = raw.optBoolean("completedChecklistCollapsed")
    fun currentRows() = ChecklistModel.rows(draftViewModel.draft.value.optJSONArray("checkBoxes"))
    fun applyRows(rows: List<JSONObject>, external: Boolean = false, structural: Boolean = false) =
        change("checkBoxes", external = external, structural = structural) { it.put("checkBoxes", ChecklistModel.toJson(rows)) }
    // Without a row to follow, the new one goes at the end.
    fun addChecklistItem(afterId: Long? = null) {
        val rows = currentRows()
        val id = ChecklistModel.nextId(rows)
        applyRows(ChecklistModel.insertAfter(rows, afterId, id = id), structural = true)
        pendingFocus = id to 0
    }
    val checklistActions = remember(draftViewModel) {
        object : ChecklistActions {
            override fun setText(id: Long, html: String) {
                val rows = currentRows()
                val index = rows.indexOfFirst { ChecklistModel.idOf(it) == id }
                if (index >= 0) applyRows(rows.toMutableList().also { it[index] = it[index].shallowCopy().put("data", html) })
            }
            override fun toggle(id: Long, done: Boolean) { ChecklistModel.toggleDone(currentRows(), id)?.let { applyRows(it, structural = true) } }
            override fun split(id: Long, left: String, rest: List<String>, caret: Int) {
                val rows = currentRows()
                val first = ChecklistModel.nextId(rows)
                ChecklistModel.splitInto(rows, id, left, rest)?.let {
                    applyRows(it, external = true, structural = true)
                    if (rest.isNotEmpty()) pendingFocus = (first + rest.size - 1) to caret
                }
            }
            override fun backspaceAtStart(id: Long): Boolean {
                val rows = currentRows()
                val (previous, _) = neighbours(rows, draftViewModel.draft.value.optBoolean("completedChecklistCollapsed"), id)
                val visible = rows.filter { !draftViewModel.draft.value.optBoolean("completedChecklistCollapsed") || !it.optBoolean("done") }.map { ChecklistModel.idOf(it) }
                val row = rows.firstOrNull { ChecklistModel.idOf(it) == id } ?: return false
                val merged = ChecklistModel.mergeIntoPrevious(rows, id, visible) ?: return !ChecklistModel.isStructured(row)
                val junction = previous?.takeIf { !ChecklistModel.isStructured(it) }?.let { NoteHtml.parse(it.getString("data"), HtmlMode.Row).length }
                applyRows(merged, external = true, structural = true)
                if (previous != null) pendingFocus = ChecklistModel.idOf(previous) to junction
                return true
            }
            override fun moveUp(id: Long) {
                val rows = currentRows()
                val (previous, _) = neighbours(rows, draftViewModel.draft.value.optBoolean("completedChecklistCollapsed"), id)
                if (previous != null) ChecklistModel.moveBefore(rows, id, ChecklistModel.idOf(previous))?.let { applyRows(it, external = true, structural = true) }
            }
            override fun moveDown(id: Long) {
                val rows = currentRows()
                val hidden = draftViewModel.draft.value.optBoolean("completedChecklistCollapsed")
                val visible = rows.filter { !hidden || !it.optBoolean("done") }
                val position = visible.indexOfFirst { ChecklistModel.idOf(it) == id }
                if (position < 0 || position >= visible.lastIndex) return
                val before = visible.getOrNull(position + 2)?.let { ChecklistModel.idOf(it) }
                ChecklistModel.moveBefore(rows, id, before)?.let { applyRows(it, external = true, structural = true) }
            }
            override fun setIndent(id: Long, level: Int) { ChecklistModel.setIndent(currentRows(), id, level)?.let { applyRows(it, structural = true) } }
            override fun remove(id: Long) { ChecklistModel.remove(currentRows(), id)?.let { applyRows(it, external = true, structural = true) } }
        }
    }
    // Tapping blank editor space behaves like tapping the end of the content.
    fun focusEditorEnd() {
        if (note.checklist) {
            val last = note.items.lastOrNull { (!hideDone || !it.optBoolean("done")) && !ChecklistModel.isStructured(it) }
            if (last == null) addChecklistItem() else pendingFocus = ChecklistModel.idOf(last) to null
        } else bodyState.focus()
    }
    fun showCheckboxes() {
        val rows = currentRows()
        val (items, body) = ChecklistModel.show(rows, note.body)
        change("checkBoxes", external = true, structural = true) { it.put("isCbox", true).put("noteBody", body).put("checkBoxes", ChecklistModel.toJson(items)) }
        bodyShown = NoteHtml.hasMeaningfulBody(body)
        if (items.size == rows.size) addChecklistItem() else pendingFocus = ChecklistModel.idOf(items.last()) to null
    }
    fun hideCheckboxes() {
        ChecklistModel.hide(currentRows(), note.body)?.let { (items, body) ->
            change("checkBoxes", external = true, structural = true) { it.put("isCbox", false).put("noteBody", body).put("checkBoxes", ChecklistModel.toJson(items)) }
        }
    }
    // The new row is composed a frame after the draft changes, so retry on every draft update until its field exists.
    LaunchedEffect(pendingFocus, draftGeneration) {
        val (id, caret) = pendingFocus ?: return@LaunchedEffect
        val state = rowStates[id]
        if (state?.view != null) { state.focus(caret); pendingFocus = null }
    }
    // Undo and redo put the caret back where the step was recorded, once the fields have been reset.
    LaunchedEffect(restore) {
        val hint = restore ?: return@LaunchedEffect
        val state = when (val key = hint.focusKey) {
            null -> null
            "body" -> bodyState
            else -> key.removePrefix("row:").toLongOrNull()?.let { rowStates[it] }
        }
        val selection = hint.selection
        if (state?.view != null && selection != null) state.focus(selection[0], selection[1])
        draftViewModel.consumeRestore(hint)
    }
    LaunchedEffect(draftViewModel, focus) { draftViewModel.trackFocus { focus.current?.key to focus.current?.selection() } }
    fun insertInline(html: String) {
        val view = bodyState.view
        if (view != null) {
            val caret = if (view.hasFocus()) view.selectionEnd.coerceAtLeast(0) else view.text.length
            view.edit { text -> view.controller.insertEmbed(text, caret, html) }
        } else {
            bodyShown = true
            change("noteBody", external = true, structural = true) { it.put("noteBody", it.optString("noteBody") + html + "<div><br></div>") }
        }
    }
    // Online the picture is uploaded now and lands in the body at the caret; offline it joins the note's images and syncs later.
    fun addImage(uri: android.net.Uri) = action {
        val staged = Media(app).stage(uri)
        if (!InlineImages.isInlineImage(staged)) {
            draftViewModel.flushAndQueueSync(); app.repository.attach(Note(draftViewModel.draft.value), staged)
        } else {
            // Upload ownership outlives this composable, so rotation or closing
            // the editor cannot cancel the staged-file upload midway.
            app.scope.launch {
                try {
                    val outcome = InlineImages.place(staged, { Media(app).uploadInline(it) }) {
                        draftViewModel.flushAndQueueSync()
                        app.repository.attach(Note(draftViewModel.draft.value), staged)
                    }
                    withContext(Dispatchers.Main.immediate) {
                        if (outcome is InlineImages.Outcome.Inline) insertInline(outcome.html)
                        draftViewModel.flushAndQueueSync()
                    }
                } catch (error: Exception) {
                    withContext(Dispatchers.Main.immediate) { onError(error.message ?: "Image upload failed") }
                }
            }
        }
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
        if (uri != null) addImage(uri)
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
    // The stored color is data; the dark variant is derived at render time. Everything below draws on `color`/`foreground`.
    // A background image replaces the color (as on the web) and the text takes the theme's own color over it.
    val bgImage = note.raw.text("bgImage")
    val background = NoteBackground.parse(bgImage)
    val displayedColor = if (bgImage.isNotBlank()) null else NotePalette.display(note.raw.text("bgColor"), LocalDarkTheme.current)
    val color = displayedColor?.let { Color(it) } ?: MaterialTheme.colorScheme.surface
    val foreground = displayedColor?.let { Color(NotePalette.textColor(it)) } ?: MaterialTheme.colorScheme.onSurface
    CompositionLocalProvider(LocalRichEditorFocus provides focus) {
    NoteSurfaceTheme(color, foreground) {
    SystemBarsOverride(lightBackground = NotePalette.textColor(color.toArgb()) == NotePalette.TEXT_LIGHT_THEME)
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
                        if (note.checklist && ChecklistModel.canHide(note.items)) {
                            DropdownMenuItem(text = { Text("Hide checkboxes") }, leadingIcon = { Icon(Icons.Outlined.CheckBox, null) }, onClick = {
                                moreMenuExpanded = false
                                if (ChecklistModel.checkedCount(note.items) > 0) confirmHideCheckboxes = true else hideCheckboxes()
                            })
                        } else if (!note.checklist) {
                            DropdownMenuItem(text = { Text("Show checkboxes") }, leadingIcon = { Icon(Icons.Outlined.CheckBox, null) },
                                onClick = { moreMenuExpanded = false; showCheckboxes() })
                        }
                        DropdownMenuItem(text = { Text("Share a copy") }, leadingIcon = { Icon(Icons.Outlined.Share, null) }, onClick = {
                            moreMenuExpanded = false
                            val checklistText = note.items.joinToString("\n") {
                                (if (it.optBoolean("done")) "[x] " else "[ ] ") + NoteHtml.plainText(it.text("data"))
                            }
                            val text = NoteHtml.titleText(note.title) + "\n" + if (note.checklist) {
                                (if (hybrid) NoteHtml.previewText(note.body) + "\n" else "") + checklistText
                            } else NoteHtml.previewText(note.body)
                            activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                                .putExtra(Intent.EXTRA_TEXT, text), "Share note"))
                        })
                        DropdownMenuItem(text = { Text("Undo changes") }, leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Undo, null) },
                            onClick = { moreMenuExpanded = false; draftViewModel.undoAll() })
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
        Surface(color = color, contentColor = foreground, tonalElevation = 2.dp) {
          // The bar rides above the keyboard, so the formatting commands stay within reach while typing.
          Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
            if (formatBar) CompositionLocalProvider(LocalRichEditorFocus provides focus) {
                FormatToolbar(focus, canUndo, canRedo, onUndo = { draftViewModel.undo() }, onRedo = { draftViewModel.redo() },
                    onCommand = { draftViewModel.markStructural() }, contentColor = foreground, modifier = Modifier.padding(horizontal = 8.dp))
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                IconButton(onClick = { formatBar = !formatBar }, modifier = Modifier.semantics { selected = formatBar }) {
                    Icon(Icons.Outlined.TextFormat, if (formatBar) "Hide formatting toolbar" else "Show formatting toolbar",
                        tint = if (formatBar) MaterialTheme.colorScheme.primary else LocalContentColor.current)
                }
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
        }
    }) { padding ->
        Surface(Modifier.fillMaxSize().padding(padding), color = color, contentColor = foreground) {
        Column(Modifier.fillMaxSize().noteBackgroundImage(background, LocalDarkTheme.current, anchor = BackgroundAnchor.BottomCenter).clickable(remember { MutableInteractionSource() }, indication = null) { focusEditorEnd() }
            .verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            incoming?.let { serverNote ->
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("A newer server version is available", style = MaterialTheme.typography.titleSmall)
                        Text("Your draft is kept on this device. Saving it may require conflict resolution.", style = MaterialTheme.typography.bodySmall)
                        if (serverNote.title.isNotBlank()) Text("Server title: ${NoteHtml.titleText(serverNote.title)}", style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (!owner) Text("Shared by ${metadataNote.raw.text("ownerDisplayName", "another Keeparr user")}",
                style = MaterialTheme.typography.labelSmall, color = foreground.copy(alpha = .7f))
            editors[note.id].orEmpty().takeIf { it.isNotEmpty() }?.let { active ->
                Text("Editing with ${active.joinToString()}", style = MaterialTheme.typography.labelSmall, color = foreground.copy(alpha = .7f))
            }
            // The title is plain text: it shows the decoded text and stores it escaped, or untouched when the text did not change.
            val titleBaseline = remember(original.syncId, externalEdits) { note.title }
            val titleText = NoteHtml.titleText(note.title)
            BasicTextField(value = titleText, onValueChange = { text -> change("noteTitle") { it.put("noteTitle", NoteHtml.titleHtml(text, titleBaseline)) } },
                modifier = Modifier.fillMaxWidth().onFocusChanged { if (it.isFocused) focus.clear() }, singleLine = true,
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences,
                    imeAction = androidx.compose.ui.text.input.ImeAction.Next),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onNext = { focusEditorEnd() }),
                textStyle = MaterialTheme.typography.headlineSmall.copy(color = foreground), cursorBrush = SolidColor(foreground),
                decorationBox = { inner -> Box {
                    if (titleText.isBlank()) Text("Title", style = MaterialTheme.typography.headlineSmall, color = foreground.copy(alpha = .55f))
                    inner()
                } })
            if (titleText.isNotBlank()) HorizontalDivider(color = foreground.copy(alpha = .12f))
            val editorColors = EditorColors(foreground.toArgb(), LocalNoteLinkColor.current)
            // Mutations must be based on the draft. A metadata-first union here
            // can resurrect a just-removed image during the next placement edit.
            val images = note.raw.optJSONArray("images")?.objects().orEmpty()
            fun updateImages(next: List<JSONObject>) = change("images") { it.put("images", ChecklistModel.toJson(next)) }
            @Composable fun ImagesAt(placement: String) {
                images.filter { it.text("placement", "top") == placement }.forEach { image ->
                    Column {
                        MediaImage(app, image.text("dataUrl"))
                        Row {
                            TextButton(onClick = { updateImages(images.map { if (it === image) it.shallowCopy().put("placement", if (placement == "top") "bottom" else "top") else it }) }) {
                                Text(if (placement == "top") "Move below the text" else "Move above the text")
                            }
                            TextButton(onClick = { updateImages(images.filter { it !== image }) }) { Icon(Icons.Outlined.Close, null); Text("Remove image") }
                        }
                    }
                }
            }
            ImagesAt("top")
            if (!note.checklist || hybrid) {
                RichTextField(state = bodyState, html = note.body, externalEdits = externalEdits, colors = editorColors, hint = "Note",
                    modifier = Modifier.fillMaxWidth().heightIn(min = if (note.checklist) 24.dp else 160.dp), textSizeSp = 18f, minLines = if (note.checklist) 1 else 6, embeds = embeds,
                    onHtmlChange = { html -> change("noteBody") { it.put("noteBody", html) } },
                    onEmbedTap = { span, offset, onRemove ->
                        if (span.data.kind == EmbedKind.Image) { if (onRemove) bodyState.view?.let { view -> view.edit { text -> view.controller.removeEmbedAt(text, offset) } } }
                        else embedDetail = span to offset
                    },
                    onImageContent = { uri, _ -> addImage(uri) })
            }
            if (note.checklist) {
                val completedCount = note.items.count { it.optBoolean("done") }
                if (completedCount > 0) TextButton(onClick = { draftViewModel.updateChecklistCollapsed(!hideDone) }) {
                    Text(if (hideDone) "Show completed ($completedCount)" else "Hide completed ($completedCount)")
                }
                ChecklistRows(note.items, hideDone, externalEdits, editorColors, foreground, color, embeds, rowStates, checklistActions)
                TextButton(onClick = { addChecklistItem() }) { Icon(Icons.Outlined.Add, null); Text("List item") }
            }
            ImagesAt("bottom")
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
    }
    }
    embedDetail?.let { (span, offset) ->
        AlertDialog(onDismissRequest = { embedDetail = null }, title = { Text(span.data.label) },
            text = { Text(span.data.preview.ifBlank { "This content is preserved as it is and cannot be edited on this device." }) },
            confirmButton = { TextButton(onClick = {
                embedDetail = null
                bodyState.view?.let { view -> view.edit { text -> view.controller.removeEmbedAt(text, offset) } }
            }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { embedDetail = null }) { Text("Close") } })
    }
    if (palette) NoteColorPicker(note.raw.text("bgColor"), background, onDismiss = { palette = false }, onSelect = { selected ->
        change { it.put("bgColor", selected).put("bgImage", "") }
        palette = false
    }, onSelectImage = { selected ->
        // Like the web, picking an image leaves bgColor alone; picking a color (above) is what clears the image.
        change { it.put("bgImage", selected?.stored ?: "") }
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
        val checked = ChecklistModel.checkedCount(note.items)
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
private fun NoteColorPicker(selectedColor: String, selectedImage: NoteBackground?, onDismiss: () -> Unit, onSelect: (String) -> Unit,
    onSelectImage: (NoteBackground?) -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Background", style = MaterialTheme.typography.titleLarge)
            Text("Colors", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            LazyVerticalGrid(columns = GridCells.Fixed(5), modifier = Modifier.fillMaxWidth().heightIn(max = 320.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                items(NotePalette.colors) { swatch ->
                    val isSelected = NotePalette.sameColor(selectedColor, swatch.hex)
                    // The swatch shows the variant the note will be drawn in under the current theme.
                    val color = if (swatch.hex.isEmpty()) MaterialTheme.colorScheme.surfaceVariant
                        else Color(android.graphics.Color.parseColor(if (LocalDarkTheme.current) swatch.dark else swatch.hex))
                    val foreground = Color(NotePalette.textColor(color.toArgb()))
                    Box(Modifier.size(48.dp).clip(CircleShape).background(color)
                        .border(if (isSelected) 3.dp else 1.dp, if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, CircleShape)
                        .semantics { contentDescription = "${swatch.name} background color"; selected = isSelected; role = Role.RadioButton }
                        .clickable { onSelect(swatch.hex) }, contentAlignment = androidx.compose.ui.Alignment.Center) {
                        if (swatch.hex.isEmpty()) Text("×", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        else if (isSelected) Icon(Icons.Outlined.Check, "Selected color", tint = foreground)
                    }
                }
            }
            Text("Backgrounds", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val dark = LocalDarkTheme.current
            androidx.compose.foundation.lazy.LazyRow(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                listItems(listOf<NoteBackground?>(null) + NoteBackground.entries) { image ->
                    val isSelected = image == selectedImage
                    Box(Modifier.size(64.dp).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceVariant)
                        .noteBackgroundImage(image, dark, thumbnail = true, anchor = BackgroundAnchor.Center)
                        .border(if (isSelected) 3.dp else 1.dp, if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small)
                        .semantics { contentDescription = "${image?.label ?: "No"} background image"; selected = isSelected; role = Role.RadioButton }
                        .clickable { onSelectImage(image) }, contentAlignment = androidx.compose.ui.Alignment.Center) {
                        if (image == null) Text("×", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

@Composable
private fun ReminderDialog(activity: MainActivity, app: KeeparrApplication, existing: JSONObject?, onClose: () -> Unit,
    onSave: (String, String, String?) -> Unit, onRemove: () -> Unit) {
    // An existing reminder keeps its own time zone: re-saving it (for any reason) must not silently move a repeating
    // schedule to wherever the phone is today. A new reminder uses the phone's zone.
    val systemZone = remember(existing?.text("timezone")) {
        existing?.text("timezone")?.takeIf { it.isNotBlank() }?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: ZoneId.systemDefault()
    }
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
        Text((if (systemZone == ZoneId.systemDefault()) "Phone time" else "Reminder time zone") + " · $timezone", style = MaterialTheme.typography.bodySmall)
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
