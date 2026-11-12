@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.ui.ExperimentalComposeUiApi::class,
    androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
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
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
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
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
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
import dev.keeparr.android.ui.components.*
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
    var reminderDialog by remember { mutableStateOf(false) }
    var shareDialog by remember { mutableStateOf(false) }
    var organizeDialog by remember { mutableStateOf(false) }
    var palette by remember { mutableStateOf(false) }
    var moreMenuExpanded by remember { mutableStateOf(false) }
    var confirmMoveToTrash by remember { mutableStateOf(false) }
    var confirmHideCheckboxes by remember { mutableStateOf(false) }
    var inaccessible by remember { mutableStateOf(false) }
    val note = Note(raw)
    var editorSessionActive by remember(note.syncId) { mutableStateOf(true) }
    val lockSource = incoming ?: note
    val cachedNote by remember(note.syncId, app.settings.profile) { app.repository.observeNote(note.syncId) }.collectAsStateWithLifecycle(original)
    val metadataNote = incoming ?: cachedNote ?: note
    val owner = note.owner == app.settings.userId
    val syncStatus by app.repository.status.collectAsStateWithLifecycle()
    val selectedReminder = reminders.find { it.text("status") == "pending" && it.text("dueAtUtc").isNotBlank() &&
        (it.optLong("noteId") == note.id || it.text("noteSyncId") == note.syncId) }
    fun change(vararg touched: String, external: Boolean = false, structural: Boolean = false, block: (JSONObject) -> Unit) =
        draftViewModel.change(*touched, external = external, structural = structural, block = block)
    val action = rememberActionRunner(onError)
    fun openNoteLink(rawUrl: String) {
        val value = rawUrl.trim()
        val scheme = android.net.Uri.parse(value).scheme?.lowercase()
        val target = when (scheme) {
            "http", "https", "mailto", "tel" -> value
            null -> app.settings.origin.trimEnd('/') + if (value.startsWith('/')) value else "/$value"
            else -> { onError("This link type is not supported."); return }
        }
        action { activity.startActivity(Intent(Intent.ACTION_VIEW, android.net.Uri.parse(target))) }
    }
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
    // Checked rows go to a section below the others unless that is turned off in Settings; the section starts collapsed.
    val moveCompleted by app.settings.moveCompletedToBottom.collectAsStateWithLifecycle()
    val splitCompleted = rememberUpdatedState(moveCompleted)
    val completedCollapsed = raw.optBoolean("completedChecklistCollapsed", true)
    val sections = ChecklistSections.of(note.items, moveCompleted, completedCollapsed)
    fun currentRows() = ChecklistModel.rows(draftViewModel.draft.value.optJSONArray("checkBoxes"))
    fun currentSections() = ChecklistSections.of(currentRows(), splitCompleted.value,
        draftViewModel.draft.value.optBoolean("completedChecklistCollapsed", true))
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
                val shown = currentSections()
                val (previous, _) = neighbours(shown, id)
                val visible = shown.sectionOf(id).map { ChecklistModel.idOf(it) }
                val row = rows.firstOrNull { ChecklistModel.idOf(it) == id } ?: return false
                val merged = ChecklistModel.mergeIntoPrevious(rows, id, visible) ?: return !ChecklistModel.isStructured(row)
                val junction = previous?.takeIf { !ChecklistModel.isStructured(it) }?.let { NoteHtml.parse(it.getString("data"), HtmlMode.Row).length }
                applyRows(merged, external = true, structural = true)
                if (previous != null) pendingFocus = ChecklistModel.idOf(previous) to junction
                return true
            }
            override fun moveBefore(id: Long, beforeId: Long?): Boolean {
                val moved = ChecklistModel.moveBefore(currentRows(), id, beforeId) ?: return false
                applyRows(moved, external = true, structural = true)
                return true
            }
            override fun moveUp(id: Long) {
                val (previous, _) = neighbours(currentSections(), id)
                if (previous != null) moveBefore(id, ChecklistModel.idOf(previous))
            }
            override fun moveDown(id: Long) {
                val visible = currentSections().sectionOf(id)
                val position = visible.indexOfFirst { ChecklistModel.idOf(it) == id }
                if (position < 0 || position >= visible.lastIndex) return
                moveBefore(id, visible.getOrNull(position + 2)?.let { ChecklistModel.idOf(it) })
            }
            override fun setIndent(id: Long, level: Int) { ChecklistModel.setIndent(currentRows(), id, level)?.let { applyRows(it, structural = true) } }
            override fun remove(id: Long) { ChecklistModel.remove(currentRows(), id)?.let { applyRows(it, external = true, structural = true) } }
        }
    }
    // The editor scrolls as one column; a checklist drag reads its viewport and scrolls it near the edges.
    val editorScroll = rememberScrollState()
    val editorViewport = remember { arrayOfNulls<androidx.compose.ui.layout.LayoutCoordinates>(1) }
    // Tapping blank editor space behaves like tapping the end of the content.
    fun focusEditorEnd() {
        if (note.checklist) {
            val last = sections.open.lastOrNull { !ChecklistModel.isStructured(it) }
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
            if (editorSessionActive) draftViewModel.flushAndQueueSync()
            app.repository.attach(note.syncId, staged)
        } else {
            if (editorSessionActive) draftViewModel.flushAndQueueSync()
            // Upload ownership outlives this composable, so rotation or closing
            // the editor cannot cancel the staged-file upload midway.
            app.scope.launch {
                try {
                    val outcome = InlineImages.place(staged, { Media(app).uploadInline(it) }) {
                        app.repository.attach(note.syncId, staged)
                    }
                    withContext(Dispatchers.Main.immediate) {
                        if (outcome is InlineImages.Outcome.Inline) {
                            if (editorSessionActive && bodyState.view != null) {
                                insertInline(outcome.html)
                                draftViewModel.flushAndQueueSync()
                            } else {
                                app.repository.appendInlineImage(note.syncId, outcome.html)
                            }
                        }
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
    DisposableEffect(note.syncId) {
        editorSessionActive = true
        onDispose { editorSessionActive = false }
    }
    DisposableEffect(lifecycleOwner, draftViewModel) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_STOP) app.scope.launch { runCatching { draftViewModel.flushLocal() } }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    // Until it is unlocked a locked note has no draft to save, so leaving it just closes it, as leaving a removed note does.
    val locked = lockSource.locked && unlockedLockHash != lockSource.raw.text("lockHash")
    BackHandler { if (inaccessible || locked) onClose() else close() }
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
            if (changed && !inaccessible) {
                try { draftViewModel.flushAndQueueSync() }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (error: Exception) { onError(error.message ?: "Could not save changes") }
            }
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
    val enter = Modifier.screenEnter(ScreenEnter.Rise)
    // The stored color is data; the dark variant is derived at render time. Everything below draws on `color`/`foreground`.
    // The stored color shows through transparent parts of the illustration; text follows the theme over artwork.
    val bgImage = note.raw.text("bgImage")
    val background = NoteBackground.parse(bgImage)
    val displayedColor = NotePalette.display(note.raw.text("bgColor"), LocalDarkTheme.current)
    val color = displayedColor?.let { Color(it) } ?: MaterialTheme.colorScheme.surface
    val foreground = if (bgImage.isNotBlank()) MaterialTheme.colorScheme.onSurface
        else displayedColor?.let { Color(NotePalette.textColor(it)) } ?: MaterialTheme.colorScheme.onSurface
    if (inaccessible) {
        var recoverError by remember { mutableStateOf<String?>(null) }
        var recovering by remember { mutableStateOf(false) }
        val dialogAction = rememberActionRunner { recoverError = it; recovering = false }
        // The note's own color behind the dialog, rather than an empty screen.
        Surface(enter.fillMaxSize(), color = color) {}
        ConfirmDialog(title = "Note access removed",
            text = "This note is no longer available on the server. Your current draft is saved on this device and will not be sent to that note.",
            confirmLabel = "Recover as new note", dismissLabel = "Keep for later", icon = Icons.Outlined.LinkOff, error = recoverError, busy = recovering,
            onConfirm = {
                recovering = true
                dialogAction { app.repository.recoverDraftAsCopy(app.settings.profile, note.syncId); onClose() }
            }, onDismiss = onClose)
        return
    }
    if (locked) {
        LockedNotePage(color, foreground, enter, onBack = onClose,
            verify = { passcode -> withContext(Dispatchers.Default) { verifyLock(lockSource, passcode) } },
            onUnlocked = { unlockedLockHash = lockSource.raw.text("lockHash") })
        return
    }
    // The top bar tints once the content scrolls under it, and a hairline marks more content below. Both read the scroll
    // state directly: checklist auto-scroll and the text field's bring-into-view don't go through nested scrolling.
    val scrolled by remember { derivedStateOf { editorScroll.canScrollBackward } }
    val moreBelow by remember { derivedStateOf { editorScroll.canScrollForward } }
    CompositionLocalProvider(LocalRichEditorFocus provides focus) {
    NoteSurfaceTheme(color, foreground,
        linkColor = if (bgImage.isNotBlank()) if (LocalDarkTheme.current) NotePalette.LINK_DARK_THEME else NotePalette.LINK_LIGHT_THEME else null) {
    SystemBarsOverride(lightBackground = NotePalette.textColor(color.toArgb()) == NotePalette.TEXT_LIGHT_THEME)
    val barColor by animateColorAsState(if (scrolled) MaterialTheme.colorScheme.surfaceContainer else color, tween(Motion.BASE), label = "editor bar")
    val muted = foreground.copy(alpha = .7f)
    Scaffold(enter, topBar = {
        TopAppBar(title = {}, colors = TopAppBarDefaults.topAppBarColors(containerColor = barColor),
            navigationIcon = { IconButton(onClick = ::close) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Save and go back") } }, actions = {
                IconButton(onClick = { change("pinned") { it.put("pinned", !note.pinned) } }) {
                    Icon(if (note.pinned) Icons.Filled.PushPin else Icons.Outlined.PushPin, if (note.pinned) "Unpin" else "Pin",
                        tint = if (note.pinned) MaterialTheme.colorScheme.primary else LocalContentColor.current)
                }
                if (owner && !note.trashed) IconButton(onClick = { change { it.put("archived", !note.archived) }; close() }) {
                    Icon(if (note.archived) Icons.Outlined.Unarchive else Icons.Outlined.Archive, if (note.archived) "Unarchive" else "Archive")
                }
                Box {
                    IconButton(onClick = { moreMenuExpanded = true }) { Icon(Icons.Outlined.MoreVert, "More note actions") }
                    DropdownMenu(expanded = moreMenuExpanded, onDismissRequest = { moreMenuExpanded = false }) {
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
                            HorizontalDivider()
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
        Surface(color = color, contentColor = foreground) {
          // The bar rides above the keyboard, so the formatting commands stay within reach while typing.
          Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))) {
            // Always laid out (only its color changes), so the content above never shifts by its height.
            HorizontalDivider(color = foreground.copy(alpha = if (moreBelow) .12f else 0f))
            if (formatBar) CompositionLocalProvider(LocalRichEditorFocus provides focus) {
                FormatToolbar(focus, canUndo, canRedo, onUndo = { draftViewModel.undo() }, onRedo = { draftViewModel.redo() },
                    onCommand = { draftViewModel.markStructural() }, contentColor = foreground, modifier = Modifier.padding(horizontal = Spacing.sm))
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
                IconToggleButton(checked = formatBar, onCheckedChange = { formatBar = it }, colors = IconButtonDefaults.iconToggleButtonColors(
                    checkedContainerColor = MaterialTheme.colorScheme.secondaryContainer, checkedContentColor = MaterialTheme.colorScheme.onSecondaryContainer)) {
                    Icon(Icons.Outlined.TextFormat, "Formatting")
                }
                IconButton(onClick = { picker.launch(arrayOf("*/*")) }) { Icon(Icons.Outlined.AddPhotoAlternate, "Add image or attachment") }
                if (owner) IconButton(onClick = { palette = true }) { Icon(Icons.Outlined.Palette, "Background color") }
                IconButton(onClick = { reminderDialog = true }) {
                    if (selectedReminder != null) Icon(Icons.Outlined.NotificationsActive, "Edit reminder", tint = MaterialTheme.colorScheme.primary)
                    else Icon(Icons.Outlined.NotificationAdd, "Add reminder")
                }
                Spacer(Modifier.weight(1f))
                SaveStatus(localSaving, localSaveFailed, syncStatus, muted, Modifier.padding(horizontal = Spacing.sm))
            }
          }
        }
    }, snackbarHost = { KeeparrSnackbarHost() }) { padding ->
        Surface(Modifier.fillMaxSize().padding(padding), color = color, contentColor = foreground) {
        // The scroll, the art and the blank-space tap cover the full width; the content inside stops at a readable width.
        Column(Modifier.fillMaxSize().onGloballyPositioned { editorViewport[0] = it }.noteBackgroundImage(background, LocalDarkTheme.current, anchor = BackgroundAnchor.BottomCenter).clickable(remember { MutableInteractionSource() }, indication = null) { focusEditorEnd() }
            .verticalScroll(editorScroll)) {
        Column(Modifier.centeredMaxWidth().padding(horizontal = Spacing.lg, vertical = Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
            incoming?.let { serverNote ->
                StatusBanner(buildString {
                    append("Your draft is kept on this device. Saving it may need conflict resolution.")
                    if (serverNote.title.isNotBlank()) append("\nServer title: ${NoteHtml.titleText(serverNote.title)}")
                }, title = "A newer version is on the server", icon = Icons.Outlined.CloudSync)
            }
            val activeEditors = editors[note.id].orEmpty()
            if (!owner || activeEditors.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                if (!owner) MetaLine(Icons.Outlined.PeopleOutline, "Shared by ${metadataNote.raw.text("ownerDisplayName", "another Keeparr user")}", muted)
                if (activeEditors.isNotEmpty()) MetaLine(Icons.Outlined.Edit, "Editing now: ${activeEditors.joinToString()}", muted)
            }
            // The title is plain text: it shows the decoded text and stores it escaped, or untouched when the text did not change.
            // It wraps, but stays one paragraph: a typed or pasted line break moves on to the body instead.
            val titleBaseline = remember(original.syncId, externalEdits) { note.title }
            val titleText = NoteHtml.titleText(note.title)
            fun setTitle(text: String) { if (text != titleText) change("noteTitle") { it.put("noteTitle", NoteHtml.titleHtml(text, titleBaseline)) } }
            BasicTextField(value = titleText, onValueChange = { text ->
                    if ('\n' in text || '\r' in text) { setTitle(text.split('\n', '\r').filter { it.isNotEmpty() }.joinToString(" ")); focusEditorEnd() }
                    else setTitle(text)
                },
                // Inset like the body below it, whose platform text field keeps a small built-in padding.
                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.xs).onFocusChanged { if (it.isFocused) focus.clear() },
                keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(capitalization = androidx.compose.ui.text.input.KeyboardCapitalization.Sentences,
                    imeAction = androidx.compose.ui.text.input.ImeAction.Next),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onNext = { focusEditorEnd() }),
                textStyle = MaterialTheme.typography.headlineSmall.copy(color = foreground), cursorBrush = SolidColor(foreground),
                decorationBox = { inner -> Box {
                    if (titleText.isBlank()) Text("Title", style = MaterialTheme.typography.headlineSmall, color = foreground.copy(alpha = .55f))
                    inner()
                } })
            val editorColors = EditorColors(foreground.toArgb(), LocalNoteLinkColor.current)
            // Mutations must be based on the draft. A metadata-first union here
            // can resurrect a just-removed image during the next placement edit.
            val images = note.raw.optJSONArray("images")?.objects().orEmpty()
            fun updateImages(next: List<JSONObject>) = change("images") { it.put("images", ChecklistModel.toJson(next)) }
            @Composable fun ImagesAt(placement: String) {
                images.filter { it.text("placement", "top") == placement }.forEach { image -> key(image.text("dataUrl")) {
                    var imageMenu by remember { mutableStateOf(false) }
                    Box(Modifier.fillMaxWidth().clip(MaterialTheme.shapes.card)) {
                        MediaImage(app, image.text("dataUrl"))
                        Box(Modifier.align(Alignment.TopEnd).padding(Spacing.xs)) {
                            FilledIconButton(onClick = { imageMenu = true }, colors = IconButtonDefaults.filledIconButtonColors(
                                containerColor = Color.Black.copy(alpha = .5f), contentColor = Color.White)) { Icon(Icons.Outlined.MoreVert, "Image options") }
                            DropdownMenu(expanded = imageMenu, onDismissRequest = { imageMenu = false }) {
                                DropdownMenuItem(text = { Text(if (placement == "top") "Move below the text" else "Move above the text") },
                                    leadingIcon = { Icon(if (placement == "top") Icons.Outlined.ArrowDownward else Icons.Outlined.ArrowUpward, null) },
                                    onClick = { imageMenu = false; updateImages(images.map { if (it === image) it.shallowCopy().put("placement", if (placement == "top") "bottom" else "top") else it }) })
                                DropdownMenuItem(text = { Text("Remove image") }, leadingIcon = { Icon(Icons.Outlined.DeleteOutline, null) },
                                    onClick = { imageMenu = false; updateImages(images.filter { it !== image }) })
                            }
                        }
                    }
                } }
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
                    onLinkTap = ::openNoteLink,
                    onImageContent = { uri, _ -> addImage(uri) })
            }
            if (note.checklist) {
                @Composable fun Rows(shown: List<JSONObject>) = ChecklistRows(note.items, shown, externalEdits, editorColors, foreground, color,
                    embeds, rowStates, checklistActions, ::openNoteLink, { uri, _ -> addImage(uri) },
                    viewport = { editorViewport[0]?.takeIf { it.isAttached }?.boundsInWindow() }, scrollBy = { editorScroll.scrollBy(it) })
                Column {
                    Rows(sections.open)
                    AddChecklistItemRow(muted) { addChecklistItem() }
                    val completedCount = ChecklistModel.checkedCount(note.items)
                    if (moveCompleted && completedCount > 0) {
                        HorizontalDivider(Modifier.padding(vertical = Spacing.xs), color = foreground.copy(alpha = .16f))
                        CompletedItemsHeader(completedCount, completedCollapsed, foreground) { draftViewModel.updateChecklistCollapsed(!completedCollapsed) }
                        // A separate call, so a drag in one section never reorders the other.
                        if (sections.completed.isNotEmpty()) Rows(sections.completed)
                    }
                }
            }
            ImagesAt("bottom")
            val attachments = (metadataNote.raw.optJSONArray("attachments")?.objects().orEmpty() + note.raw.optJSONArray("attachments")?.objects().orEmpty())
                .distinctBy { it.text("syncId").ifBlank { it.optLong("id").toString() } }
            if (attachments.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                attachments.forEach { attachment ->
                    val name = attachment.text("originalName").ifBlank { "Attachment" }
                    Surface(onClick = { action {
                        val file = Media(app).download("/api/attachments/${attachment.getLong("id")}")
                        val uri = FileProvider.getUriForFile(app, "dev.keeparr.android.files", file)
                        activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, attachment.text("mimeType", "application/octet-stream")).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
                    } }, shape = MaterialTheme.shapes.card, color = Color.Transparent, border = BorderStroke(1.dp, foreground.copy(alpha = .2f))) {
                        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = Spacing.lg, end = Spacing.xs),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                            Icon(Icons.Outlined.AttachFile, null, tint = muted)
                            Column(Modifier.weight(1f).padding(vertical = Spacing.sm)) {
                                Text(name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                attachment.text("mimeType").takeIf { it.isNotBlank() }?.let {
                                    Text(it, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                            if (owner) IconButton(onClick = { action { app.repository.deleteAttachment(note.syncId, attachment.text("syncId")) } }) {
                                Icon(Icons.Outlined.DeleteOutline, "Remove $name")
                            }
                        }
                    }
                }
            }
            // Reminder, labels and binder as chips at the end of the note; tapping one edits it.
            val reminderChip = selectedReminder?.let { ReminderFormat.dateTime(ReminderFormat.displayDueAt(it)) }
            if (reminderChip != null || metadataNote.labels.isNotEmpty() || metadataNote.binder.isNotEmpty()) {
                FlowRow(Modifier.padding(top = Spacing.xs), horizontalArrangement = Arrangement.spacedBy(Spacing.sm), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    reminderChip?.let { MetaChip(it, icon = Icons.Outlined.Alarm, onClick = { reminderDialog = true }) }
                    val organize: (() -> Unit)? = if (owner) ({ organizeDialog = true }) else null
                    metadataNote.labels.forEach { MetaChip(it, icon = Icons.AutoMirrored.Outlined.Label, onClick = organize) }
                    if (metadataNote.binder.isNotEmpty()) MetaChip(metadataNote.binder, icon = Icons.Outlined.Folder, onClick = organize)
                }
            }
        }
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
    if (organizeDialog) OrganizeDialog(note.labels.toList(), note.binder, onDismiss = { organizeDialog = false }, onSave = { labels, binder ->
        change { it.put("labels", JSONArray(labels.map { label -> JSONObject().put("name", label).put("added", true) })).put("binder", binder) }
        organizeDialog = false
    })
    if (reminderDialog) ReminderDialog(activity, app, selectedReminder, onClose = { reminderDialog = false }, onSave = { due, timezone, repeat ->
        draftViewModel.flushAndQueueSync(); app.repository.setReminder(Note(raw), due, timezone, repeat); reminderDialog = false
    }, onRemove = { selectedReminder?.let { app.repository.deleteReminder(it.getString("syncId")) }; reminderDialog = false })
    if (shareDialog) ShareDialog(app, note, onClose = { shareDialog = false }, onSave = { ids ->
        draftViewModel.flushAndQueueSync(); app.repository.share(Note(raw), ids); shareDialog = false
    })
    if (confirmHideCheckboxes) {
        val checked = ChecklistModel.checkedCount(note.items)
        ConfirmDialog(title = "Hide checkboxes?",
            text = "$checked checked ${if (checked == 1) "item" else "items"} will be removed. The other items become lines of text.",
            confirmLabel = "Hide checkboxes", destructive = true,
            onConfirm = { confirmHideCheckboxes = false; hideCheckboxes() }, onDismiss = { confirmHideCheckboxes = false })
    }
    if (confirmMoveToTrash) {
        var trashError by remember { mutableStateOf<String?>(null) }
        var trashing by remember { mutableStateOf(false) }
        val dialogAction = rememberActionRunner { trashError = it; trashing = false }
        ConfirmDialog(title = "Move note to Trash?", text = "You can restore it from Trash later.", confirmLabel = "Move to Trash",
            icon = Icons.Outlined.DeleteOutline, error = trashError, busy = trashing,
            onConfirm = {
                trashing = true
                dialogAction {
                    draftViewModel.flushAndQueueSync()
                    app.repository.setTrashed(listOf(note.syncId), true)
                    confirmMoveToTrash = false
                    onClose()
                }
            }, onDismiss = { confirmMoveToTrash = false })
    }
}

/** A quiet one-line fact about the note: who shared it, who is editing it now. */
@Composable
private fun MetaLine(icon: ImageVector, text: String, color: Color) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
        Icon(icon, null, Modifier.size(16.dp), tint = color)
        Text(text, style = MaterialTheme.typography.labelMedium, color = color, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** "+ List item", lined up with the checkboxes of the rows above it. */
@Composable
private fun AddChecklistItemRow(color: Color, onAdd: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = Dimens.minTouchTarget).clip(MaterialTheme.shapes.chip)
        .clickable(role = Role.Button, onClick = onAdd), verticalAlignment = Alignment.CenterVertically) {
        Spacer(Modifier.width(Dimens.checklistGripWidth))
        Box(Modifier.size(Dimens.minTouchTarget), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Add, null, tint = color) }
        Text("List item", style = MaterialTheme.typography.bodyLarge, color = color)
    }
}

/** Where this note's changes are: being saved, saved on the device, or synced, in a word and an icon. */
@Composable
private fun SaveStatus(saving: Boolean, failed: Boolean, syncStatus: String, color: Color, modifier: Modifier = Modifier) {
    val (icon, text) = when {
        saving -> Icons.Outlined.CloudUpload to "Saving…"
        failed -> Icons.Outlined.ErrorOutline to "Not saved"
        syncStatus == "Syncing…" -> Icons.Outlined.Sync to "Syncing…"
        syncStatus == "Synced" -> Icons.Outlined.CloudDone to "Synced"
        syncStatus.contains("attention", true) -> Icons.Outlined.SyncProblem to "Needs attention"
        else -> Icons.Outlined.PhoneAndroid to "Saved on device"
    }
    Row(modifier.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs + Spacing.xxs)) {
        Icon(icon, null, Modifier.size(16.dp), tint = if (failed) MaterialTheme.colorScheme.error else color)
        Text(text, style = MaterialTheme.typography.labelMedium, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
