@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
package dev.kept.android.ui

import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.text.Html
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.staggeredgrid.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.kept.android.KeptApplication
import dev.kept.android.MainActivity
import dev.kept.android.data.*
import dev.kept.android.reminders.ReminderScheduler
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.time.*

private data class PendingLogin(val origin: String, val headers: String, val response: JSONObject)

@Composable
fun KeptScreen(activity: MainActivity, app: KeptApplication) {
    val repo = app.repository
    val scope = rememberCoroutineScope()
    val settingsReady by app.settings.ready.collectAsStateWithLifecycle()
    val settingsWriteError by app.settings.writeError.collectAsStateWithLifecycle()
    // Derived from the settings once they are ready, in the same composition: seeding these from a LaunchedEffect
    // painted one login/light-theme frame before the stored session and theme were applied.
    var signedInOverride by remember { mutableStateOf<Boolean?>(null) }
    var darkOverride by remember { mutableStateOf<Boolean?>(null) }
    val signedIn = settingsReady && StartupGate.signedIn(signedInOverride, app.settings.token)
    val dark = settingsReady && StartupGate.dark(darkOverride, app.settings.darkMode)
    var error by remember { mutableStateOf<String?>(null) }
    val sessions: EditorSessionStores = androidx.lifecycle.viewmodel.compose.viewModel(activity)
    // The open note survives activity re-creation (rotation, process restoration) as its syncId and is reloaded;
    // its draft is already persisted on every change.
    var editingId by rememberSaveable { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf<Note?>(null) }
    fun openEditor(note: Note?) { editing = note; editingId = note?.syncId }
    fun closeEditor() {
        editing?.let { sessions.release("${app.settings.profile}:${it.syncId}") }
        openEditor(null)
    }
    LaunchedEffect(editingId, signedIn) {
        val id = editingId
        if (id != null && editing == null && signedIn) openEditor(repo.note(id))
    }
    var showSettings by remember { mutableStateOf(false) }
    val incoming by activity.incoming.collectAsStateWithLifecycle()
    fun action(block: suspend () -> Unit) { scope.launch { try { block() } catch (problem: Exception) { error = problem.message ?: "Could not complete this action" } } }
    MaterialTheme(colorScheme = if (dark) darkColorScheme(primary = Color(0xFFFFCF45)) else lightColorScheme(primary = Color(0xFF765900))) {
        Surface(Modifier.fillMaxSize()) {
            if (!settingsReady) Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            } else if (!signedIn) LoginScreen(activity, app,
                onLogin = { signedInOverride = true; repo.authenticated(); action { SyncWorker.schedule(app); repo.sync(); repo.foreground(true) } },
                onCancel = { signedInOverride = true }, onError = { error = it })
            else {
                val notes by remember(app.settings.profile) { repo.notes() }.collectAsStateWithLifecycle(emptyList())
                val reminders by remember(app.settings.profile) { repo.reminders() }.collectAsStateWithLifecycle(emptyList())
                val occurrences by remember(app.settings.profile) { repo.occurrences() }.collectAsStateWithLifecycle(emptyList())
                val conflicts by remember(app.settings.profile) { repo.conflicts() }.collectAsStateWithLifecycle(emptyList())
                LaunchedEffect(incoming, signedIn) {
                    val intent = incoming ?: return@LaunchedEffect
                    try {
                        if (intent.hasExtra("itemId")) {
                            repo.toggleChecklist(intent.getStringExtra("noteSyncId") ?: "", intent.getLongExtra("itemId", 0))
                            activity.incoming.value = null; activity.finish(); return@LaunchedEffect
                        }
                        intent.getStringExtra("noteSyncId")?.let { id -> openEditor(repo.note(id)) }
                        val createChecklist = intent.getBooleanExtra("createChecklist", false)
                        if (intent.getBooleanExtra("createNote", false) || createChecklist || intent.action in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) {
                            val note = Note.create(app.settings.userId, createChecklist)
                            val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
                            note.raw.put("noteTitle", intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty())
                                .put("noteBody", Html.escapeHtml(text).replace("\n", "<br>"))
                            repo.save(note); openEditor(note)
                            val uris = if (intent.action == Intent.ACTION_SEND_MULTIPLE) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
                                else listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
                            for (uri in uris) repo.attach(note, Media(app).stage(uri))
                        }
                    } catch (problem: Exception) { error = problem.message }
                    activity.incoming.value = null
                }
                if (editing != null) key(editing!!.syncId) {
                    NoteEditor(activity, app, editing!!, reminders, onClose = { closeEditor() }, onError = { error = it })
                } else HomeScreen(app, notes, reminders, conflicts, onEdit = { openEditor(it) }, onCreate = { checklist ->
                    action { val note = Note.create(app.settings.userId, checklist); repo.save(note); openEditor(note) }
                }, onSettings = { showSettings = true }, onReauthenticate = { signedInOverride = false }, onError = { error = it })
                if (showSettings) SettingsDialog(activity, app, reminders, occurrences, dark, onDark = { darkOverride = it; app.settings.darkMode = it },
                    onClose = { showSettings = false }, onLogout = { action { repo.logout(); signedInOverride = false; showSettings = false } }, onError = { error = it })
            }
            val visibleError = settingsWriteError ?: error
            visibleError?.let { message ->
                val dismiss = {
                    if (settingsWriteError != null) app.settings.clearWriteError() else error = null
                }
                AlertDialog(onDismissRequest = dismiss, title = { Text("Kept") }, text = { Text(message) },
                    confirmButton = { TextButton(onClick = dismiss) { Text("OK") } })
            }
        }
    }
}

@Composable
private fun LoginScreen(activity: MainActivity, app: KeptApplication, onLogin: () -> Unit, onCancel: () -> Unit, onError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var server by remember { mutableStateOf(app.settings.origin) }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var totp by remember { mutableStateOf("") }
    var certificate by remember { mutableStateOf(app.settings.aliasFor(server)) }
    var headers by remember { mutableStateOf(app.settings.headersFor(server)) }
    var connectionStatus by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var pendingLogin by remember { mutableStateOf<PendingLogin?>(null) }
    suspend fun activate(login: PendingLogin) {
        app.settings.activateSession(
            login.origin,
            login.headers,
            login.response.getString("token"),
            login.response.getJSONObject("user").getLong("id")
        )
        pendingLogin = null
        onLogin()
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).imePadding().padding(28.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Spacer(Modifier.height(35.dp))
        Icon(Icons.Outlined.Lightbulb, null, Modifier.size(52.dp), tint = MaterialTheme.colorScheme.primary)
        Text("Your notes. Your server.", style = MaterialTheme.typography.headlineMedium)
        Text("Sign in to Kept", style = MaterialTheme.typography.titleMedium)
        app.settings.message.takeIf { it.isNotBlank() }?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
        OutlinedTextField(server, { value ->
            server = value
            certificate = app.settings.aliasFor(value)
            headers = app.settings.headersFor(value)
            connectionStatus = null
        }, label = { Text("Server address") }, placeholder = { Text("https://notes.example.com") }, modifier = Modifier.fillMaxWidth(), singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false))
        OutlinedButton(onClick = { activity.chooseCertificate(server) { certificate = it } }, modifier = Modifier.fillMaxWidth()) {
            Icon(Icons.Outlined.VerifiedUser, null); Spacer(Modifier.width(8.dp)); Text(if (certificate.isBlank()) "Select client certificate (optional)" else "Certificate: $certificate")
        }
        if (certificate.isNotBlank()) TextButton(onClick = { certificate = ""; app.settings.setAliasFor(server, "") }) { Text("Use no client certificate") }
        OutlinedButton(onClick = { scope.launch {
            busy = true
            connectionStatus = null
            try { connectionStatus = app.repository.api.testConnection(server, headers) }
            catch (problem: Exception) { connectionStatus = problem.message ?: "Connection test failed" }
            finally { busy = false }
        } }, enabled = !busy && server.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
            Text(if (busy) "Testing connection…" else "Test server connection")
        }
        connectionStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = if (it.startsWith("Connected")) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error) }
        OutlinedTextField(username, { username = it }, label = { Text("Username") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(password, { password = it }, label = { Text("Password") }, visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(totp, { totp = it }, label = { Text("2FA or backup code, if enabled") }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        OutlinedTextField(headers, { headers = it }, label = { Text("Gateway headers (optional JSON)") }, modifier = Modifier.fillMaxWidth(), minLines = 2)
        Button(onClick = { scope.launch {
            busy = true
            try {
                if (headers.isNotBlank()) JSONObject(headers)
                val response = app.repository.api.login(server, username, password, totp, headers)
                val targetOrigin = server.trim().trimEnd('/')
                val target = PendingLogin(targetOrigin, headers, response)
                val targetUserId = response.getJSONObject("user").getLong("id")
                if (ConnectionProfilePolicy.requiresConfirmation(app.settings.snapshot(), targetOrigin, targetUserId)) pendingLogin = target
                else activate(target)
            } catch (problem: Exception) { onError(problem.message ?: "Sign-in failed") }
            finally { busy = false }
        } }, enabled = !busy && server.isNotBlank() && username.isNotBlank() && password.isNotBlank(), modifier = Modifier.fillMaxWidth()) {
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Sign in")
        }
    }
    pendingLogin?.let { login ->
        val displayName = login.response.getJSONObject("user").text("displayName", login.response.getJSONObject("user").text("username", "this account"))
        AlertDialog(onDismissRequest = { pendingLogin = null; onCancel() }, title = { Text("Switch Kept profile?") },
            text = { Text("Sign in as $displayName on ${login.origin}? Your cached notes and pending work stay isolated in the previous profile.") },
            confirmButton = { TextButton(onClick = { scope.launch {
                runCatching { activate(login) }.onFailure { onError(it.message ?: "Could not activate this profile") }
            } }) { Text("Switch profile") } },
            dismissButton = { TextButton(onClick = { pendingLogin = null; onCancel() }) { Text("Stay with previous profile") } })
    }
}

@Composable
private fun HomeScreen(app: KeptApplication, notes: List<Note>, reminders: List<JSONObject>, conflicts: List<Outbox>, onEdit: (Note) -> Unit,
    onCreate: (Boolean) -> Unit, onSettings: () -> Unit, onReauthenticate: () -> Unit, onError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val status by app.repository.status.collectAsStateWithLifecycle()
    val connectionState by app.repository.connectionState.collectAsStateWithLifecycle()
    val home = remember { HomeState() }
    val projector = remember { HomeProjector() }
    var search by home::search
    var filter by home::filter
    var grid by home::grid
    val selectedIds = home.selectedIds
    var confirmBulkTrash by remember { mutableStateOf(false) }
    var conflict by remember { mutableStateOf<Outbox?>(null) }
    val noteBounds = remember { mutableStateMapOf<String, Rect>() }
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val reorderEnabled = home.reorderEnabled
    var projection by remember { mutableStateOf(EmptyHomeProjection, referentialEqualityPolicy()) }
    LaunchedEffect(notes, filter, search, reminders) {
        projection = withContext(Dispatchers.Default) { projector.project(notes, filter, search, reminders) }
    }
    val visible = projection.visibleNotes
    val selectedNotes = selectedIds.mapNotNull(projection.notesBySyncId::get)
    val canTrashSelected = selectedNotes.isNotEmpty() && selectedNotes.all { it.owner == app.settings.userId }
    val allSelectedTrashed = selectedNotes.isNotEmpty() && selectedNotes.all { it.trashed }
    fun selectNote(id: String) = home.select(id)
    fun toggleSelected(id: String) = home.toggle(id)
    fun action(block: suspend () -> Unit) { scope.launch { try { block() } catch (problem: Exception) { onError(problem.message ?: "Action failed") } } }
    ModalNavigationDrawer(drawerState = drawer, drawerContent = {
        ModalDrawerSheet(Modifier.verticalScroll(rememberScrollState())) {
            Text("Kept", Modifier.padding(24.dp), style = MaterialTheme.typography.headlineMedium)
            projection.filterChoices.forEach { (value, label) -> NavigationDrawerItem(label = { Text(label) }, selected = filter == value,
                onClick = { filter = value; scope.launch { drawer.close() } }, modifier = Modifier.padding(horizontal = 12.dp)) }
        }
    }) {
        Scaffold(topBar = {
            Column(Modifier.statusBarsPadding().padding(horizontal = 12.dp)) {
                Surface(shape = RoundedCornerShape(28.dp), color = MaterialTheme.colorScheme.surfaceContainer) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = { scope.launch { drawer.open() } }) { Icon(Icons.Outlined.Menu, "Navigation") }
                        TextField(search, { search = it }, placeholder = { Text("Search your notes") }, modifier = Modifier.weight(1f), singleLine = true,
                            colors = TextFieldDefaults.colors(unfocusedContainerColor = Color.Transparent, focusedContainerColor = Color.Transparent,
                                unfocusedIndicatorColor = Color.Transparent, focusedIndicatorColor = Color.Transparent))
                        IconButton(onClick = { grid = !grid }) { Icon(if (grid) Icons.Outlined.ViewAgenda else Icons.Outlined.GridView, "Switch grid or list") }
                        IconButton(onClick = onSettings) { Icon(Icons.Outlined.AccountCircle, "Settings") }
                    }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(status, Modifier.weight(1f).padding(start = 12.dp), style = MaterialTheme.typography.labelSmall, maxLines = 2)
                    if (connectionState is ConnectionState.SessionExpired) {
                        TextButton(onClick = onReauthenticate) { Text("Sign in again") }
                    }
                    IconButton(onClick = { action { app.repository.sync() } }) { Icon(Icons.Outlined.Sync, "Synchronize") }
                }
                if (conflicts.isNotEmpty()) TextButton(onClick = { conflict = conflicts.first() }) { Text("${conflicts.size} edit(s) need attention") }
                selectedIds.takeIf { it.isNotEmpty() }?.let { selection ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("${selection.size} selected", Modifier.weight(1f))
                        if (selection.size == 1 && reorderEnabled) {
                            val selectedId = selection.single()
                            val ids = visible.map { it.syncId }.toMutableList()
                            val index = ids.indexOf(selectedId)
                            IconButton(onClick = {
                                if (index > 0 && visible[index].pinned == visible[index - 1].pinned) {
                                    java.util.Collections.swap(ids, index, index - 1); action { app.repository.reorder(ids) }
                                }
                            }, enabled = index > 0 && visible[index].pinned == visible[index - 1].pinned) { Icon(Icons.Outlined.ArrowUpward, "Move earlier") }
                            IconButton(onClick = {
                                if (index >= 0 && index + 1 < ids.size && visible[index].pinned == visible[index + 1].pinned) {
                                    java.util.Collections.swap(ids, index, index + 1); action { app.repository.reorder(ids) }
                                }
                            }, enabled = index >= 0 && index + 1 < ids.size && visible[index].pinned == visible[index + 1].pinned) { Icon(Icons.Outlined.ArrowDownward, "Move later") }
                        }
                        if (canTrashSelected) IconButton(onClick = {
                            if (allSelectedTrashed) action { app.repository.setTrashed(selection.toList(), false); home.clearSelection() }
                            else confirmBulkTrash = true
                        }) { Icon(if (allSelectedTrashed) Icons.Outlined.RestoreFromTrash else Icons.Outlined.DeleteOutline,
                            if (allSelectedTrashed) "Restore selected notes" else "Move selected notes to Trash") }
                        IconButton(onClick = { home.clearSelection() }) { Icon(Icons.Outlined.Close, "Clear selection") }
                    }
                    if (!canTrashSelected) Text("Only notes you own can be moved to Trash.", style = MaterialTheme.typography.labelSmall)
                }
            }
        }, bottomBar = {
            Surface(shadowElevation = 4.dp, color = MaterialTheme.colorScheme.surfaceContainer) {
                Row(Modifier.navigationBarsPadding().fillMaxWidth().padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = { onCreate(false) }, modifier = Modifier.weight(1f)) { Text("Take a note…", Modifier.fillMaxWidth()) }
                    IconButton(onClick = { onCreate(true) }) { Icon(Icons.Outlined.CheckBox, "Create checklist") }
                    IconButton(onClick = { onCreate(false) }) { Icon(Icons.Outlined.Add, "Create note") }
                }
            }
        }) { padding ->
            if (filter == "reminders") ReminderList(app, reminders, notes, Modifier.fillMaxSize().padding(padding), onOpenNote = { note -> if (note != null) onEdit(note) }, onError = onError)
            else if (visible.isEmpty()) Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) { Icon(Icons.Outlined.Lightbulb, null, Modifier.size(80.dp)); Text("Your notes appear here", Modifier.padding(16.dp)) }
            } else LazyVerticalStaggeredGrid(columns = if (grid) StaggeredGridCells.Adaptive(170.dp) else StaggeredGridCells.Fixed(1), modifier = Modifier.fillMaxSize().padding(padding),
                contentPadding = PaddingValues(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalItemSpacing = 8.dp) {
                val pinned = projection.pinnedCards; val other = projection.otherCards
                if (pinned.isNotEmpty()) item(span = StaggeredGridItemSpan.FullLine, contentType = "section-header") { Text("PINNED", Modifier.padding(8.dp), style = MaterialTheme.typography.labelMedium) }
                items(pinned, key = { it.syncId }, contentType = { it.contentType }) { card -> NoteCard(app, card, card.syncId in selectedIds, reorderEnabled, noteBounds,
                    onClick = { if (selectedIds.isEmpty()) projection.notesBySyncId[card.syncId]?.let(onEdit) else toggleSelected(card.syncId) },
                    onLongClick = { selectNote(card.syncId) }, onDrop = { target ->
                        val source = projection.notesBySyncId[card.syncId]
                        if (source != null && reorderEnabled && selectedIds.size <= 1) moveDraggedNote(visible, source, target)?.let { ids -> action { app.repository.reorder(ids) } }
                    }) }
                if (pinned.isNotEmpty() && other.isNotEmpty()) item(span = StaggeredGridItemSpan.FullLine, contentType = "section-header") { Text("OTHER", Modifier.padding(8.dp), style = MaterialTheme.typography.labelMedium) }
                items(other, key = { it.syncId }, contentType = { it.contentType }) { card -> NoteCard(app, card, card.syncId in selectedIds, reorderEnabled, noteBounds,
                    onClick = { if (selectedIds.isEmpty()) projection.notesBySyncId[card.syncId]?.let(onEdit) else toggleSelected(card.syncId) },
                    onLongClick = { selectNote(card.syncId) }, onDrop = { target ->
                        val source = projection.notesBySyncId[card.syncId]
                        if (source != null && reorderEnabled && selectedIds.size <= 1) moveDraggedNote(visible, source, target)?.let { ids -> action { app.repository.reorder(ids) } }
                    }) }
            }
        }
    }
    conflict?.let { entry ->
        val result = JSONObject(entry.conflict!!)
        val latest = result.optJSONObject("latest")
        val primaryResolution = when (entry.type) {
            "note.upsert" -> if (latest == null) ConflictResolution.SAVE_AS_COPY else ConflictResolution.REPLACE_WITH_DRAFT
            "reminder.upsert" -> if (latest == null) ConflictResolution.DISCARD else ConflictResolution.REPLACE_WITH_DRAFT
            "media.upload" -> ConflictResolution.SAVE_AS_COPY
            else -> ConflictResolution.DISCARD
        }
        val primaryLabel = when (entry.type) {
            "note.upsert" -> if (latest == null) "Save draft as copy" else "Replace server version"
            "reminder.upsert" -> if (latest == null) "Discard schedule" else "Keep my schedule"
            "media.upload" -> "Save as copy"
            "reminder.action" -> "Discard outdated action"
            "note.view-state" -> "Use server preference"
            else -> "Resolve"
        }
        fun resolveWith(choice: ConflictResolution) {
            action {
                app.repository.resolve(entry, choice)
                app.repository.sync()
                conflict = null
            }
        }
        AlertDialog(onDismissRequest = { conflict = null }, title = { Text("Keep your draft safe") },
            text = { Column(Modifier.verticalScroll(rememberScrollState())) {
                Text(result.text("error", "This edit conflicts with a newer version."))
                if (entry.type == "note.upsert") {
                    val draft = JSONObject(entry.payload)
                    Text("Your draft: ${draft.text("noteTitle")}", Modifier.padding(top = 12.dp))
                    Text(NoteFormat.displayText(draft.text("noteBody")))
                    latest?.let { server ->
                        Text("Server version: ${server.text("noteTitle")}", Modifier.padding(top = 12.dp))
                        Text(NoteFormat.displayText(server.text("noteBody")))
                        val localItems = draft.optJSONArray("checkBoxes")?.objects().orEmpty().associateBy { it.optLong("id") }
                        val serverItems = server.optJSONArray("checkBoxes")?.objects().orEmpty().associateBy { it.optLong("id") }
                        val differing = (localItems.keys + serverItems.keys).filter { id ->
                            localItems[id]?.toString() != serverItems[id]?.toString()
                        }
                        if (differing.isNotEmpty()) {
                            Text("Checklist differences", Modifier.padding(top = 12.dp), style = MaterialTheme.typography.titleSmall)
                            differing.take(30).forEach { id ->
                                val localText = localItems[id]?.opt("data")?.toString() ?: "(missing)"
                                val serverText = serverItems[id]?.opt("data")?.toString() ?: "(missing)"
                                Text("Item $id · local: $localText · server: $serverText", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                } else if (entry.type == "media.upload") {
                    val upload = JSONObject(entry.payload)
                    Text("Pending file: ${upload.text("name", "attachment")}", Modifier.padding(top = 12.dp))
                    Text("You can save the local note and file as a new note on this account, or discard the pending upload.")
                } else if (entry.type == "reminder.upsert") {
                    val local = JSONObject(entry.payload)
                    Text("Your schedule: ${local.text("dueAtUtc")} · ${local.text("repeatRule", "once")}", Modifier.padding(top = 12.dp))
                    latest?.let { Text("Server schedule: ${it.text("dueAtUtc")} · ${it.text("repeatRule", "once")}") }
                } else if (entry.type == "reminder.action") {
                    Text("This reminder action is no longer valid for the current schedule. The reminder itself is unchanged.")
                }
            } }, confirmButton = { Row(Modifier.horizontalScroll(rememberScrollState())) {
                TextButton(onClick = { resolveWith(primaryResolution) }) { Text(primaryLabel) }
                if (entry.type == "note.upsert" && latest != null) {
                    TextButton(onClick = { resolveWith(ConflictResolution.SAVE_AS_COPY) }) { Text("Save as copy") }
                }
            } }, dismissButton = { TextButton(onClick = {
                resolveWith(if (latest != null) ConflictResolution.USE_SERVER else ConflictResolution.DISCARD)
            }) { Text(if (latest != null) "Use server" else "Discard") } })
    }
    if (confirmBulkTrash) AlertDialog(onDismissRequest = { confirmBulkTrash = false }, title = { Text("Move notes to Trash?") },
        text = { Text("${selectedIds.size} selected note(s) will move to Trash. You can restore them later.") },
        confirmButton = { TextButton(onClick = { action {
            app.repository.setTrashed(selectedIds.toList(), true)
            home.clearSelection()
            confirmBulkTrash = false
        } }) { Text("Move to Trash") } },
        dismissButton = { TextButton(onClick = { confirmBulkTrash = false }) { Text("Cancel") } })
}

@Composable
private fun ReminderList(app: KeptApplication, reminders: List<JSONObject>, notes: List<Note>, modifier: Modifier,
    onOpenNote: (Note?) -> Unit, onError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    var removing by remember { mutableStateOf<JSONObject?>(null) }
    val rows = reminders.filter { reminder ->
        reminder.text("status") == "pending" && reminder.text("dueAtUtc").isNotEmpty() &&
            (reminder.optLong("noteId") == 0L || notes.any { it.id == reminder.optLong("noteId") || it.syncId == reminder.text("noteSyncId") })
    }
        .sortedBy { runCatching { Instant.parse(ReminderFormat.displayDueAt(it)) }.getOrDefault(Instant.MAX) }
    if (rows.isEmpty()) Box(modifier, contentAlignment = Alignment.Center) { Text("No upcoming reminders") }
    else LazyColumn(modifier, contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        items(rows, key = { it.text("syncId") }) { reminder ->
            val note = notes.find { it.id == reminder.optLong("noteId") || it.syncId == reminder.text("noteSyncId") }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(if (note?.locked == true) "Locked note reminder" else reminder.text("title", note?.title ?: "Reminder"), style = MaterialTheme.typography.titleMedium)
                     Text(ReminderFormat.dateTime(ReminderFormat.displayDueAt(reminder)))
                    runCatching { JSONObject(reminder.text("repeatRule")) }.getOrNull()?.text("type")?.takeIf { it.isNotBlank() }?.let { type ->
                        val description = if (type == "custom_days") "every ${runCatching { JSONObject(reminder.text("repeatRule")).optInt("intervalDays", 1) }.getOrDefault(1)} days" else type
                        Text("Repeats: $description", style = MaterialTheme.typography.labelMedium)
                    }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        if (note != null) TextButton(onClick = { onOpenNote(note) }) { Text("Open note") }
                        TextButton(onClick = { scope.launch { runCatching { app.repository.dismissReminder(reminder.text("syncId")) }.onFailure { onError(it.message ?: "Could not dismiss reminder") } } }) { Text("Dismiss") }
                        TextButton(onClick = { removing = reminder }) { Text("Delete") }
                    }
                }
            }
        }
    }
    removing?.let { reminder -> AlertDialog(onDismissRequest = { removing = null }, title = { Text("Delete reminder?") },
        text = { Text("This removes the reminder from this account.") },
        confirmButton = { TextButton(onClick = { scope.launch { runCatching { app.repository.deleteReminder(reminder.text("syncId")) }.onFailure { onError(it.message ?: "Could not delete reminder") }; removing = null } }) { Text("Delete") } },
        dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } }) }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun NoteCard(app: KeptApplication, note: NoteCardUiModel, selected: Boolean, reorderEnabled: Boolean, bounds: MutableMap<String, Rect>,
    onClick: () -> Unit, onLongClick: () -> Unit, onDrop: (String) -> Unit) {
    var coordinates by remember(note.syncId) { mutableStateOf<LayoutCoordinates?>(null) }
    var target by remember(note.syncId) { mutableStateOf(note.syncId) }
    DisposableEffect(note.syncId) { onDispose { bounds.remove(note.syncId) } }
    val color = note.colorArgb?.let { Color(it) } ?: MaterialTheme.colorScheme.surface
    val foreground = if (color.luminance() > .4f) Color(0xFF272727) else Color(0xFFF1F1F1)
    Surface(shape = RoundedCornerShape(12.dp), color = color, contentColor = foreground,
        border = BorderStroke(if (selected) 3.dp else 1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().onGloballyPositioned { coordinates = it; bounds[note.syncId] = it.boundsInWindow() }
            .combinedClickable(onClick = onClick, onLongClick = onLongClick,
                onLongClickLabel = "Drag to reorder note".takeIf { reorderEnabled })
            .pointerInput(note.syncId, bounds.keys.toList(), reorderEnabled) {
                if (reorderEnabled) detectDragGesturesAfterLongPress(
                    onDragStart = { target = note.syncId; onLongClick() },
                    onDrag = { change, _ ->
                        val point: Offset? = coordinates?.takeIf { it.isAttached }?.localToWindow(change.position)
                        point?.let { location -> bounds.entries.firstOrNull { it.value.contains(location) }?.key?.let { target = it } }
                        change.consume()
                    },
                    onDragEnd = { if (target != note.syncId) onDrop(target) },
                    onDragCancel = { target = note.syncId }
                )
            }) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                if (note.locked) { Icon(Icons.Outlined.Lock, "Locked note"); Text("Locked note") }
                else {
                note.imagePath?.let { MediaImage(app, it) }
                if (note.title.isNotBlank()) Text(note.title, style = MaterialTheme.typography.titleMedium, maxLines = 3)
                if (note.checklist) note.checklistItems.forEach { item -> Row {
                    Text(if (item.done) "☑  " else "☐  "); Text(item.text, maxLines = 3)
                } } else if (note.bodyText.isNotBlank()) Text(note.bodyText, maxLines = 12)
                note.reminderText?.let { reminderText ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Schedule, "Reminder", Modifier.size(16.dp))
                        Text(reminderText, Modifier.padding(start = 5.dp), style = MaterialTheme.typography.labelSmall, maxLines = 1)
                    }
                }
                if (note.labels.isNotEmpty()) Text(note.labels.joinToString(" · "), style = MaterialTheme.typography.labelSmall)
                if (note.shared) Icon(Icons.Outlined.PeopleOutline, "Shared note", Modifier.size(18.dp))
            }
        }
    }
}

internal fun canReorderNotes(filter: String, search: String) = search.isBlank() && filter in setOf("home", "pinned")

internal fun searchVisibleNotes(notes: List<Note>, filter: String, search: String): List<Note> {
    val visible = NoteOrder.visible(notes, filter)
    if (search.isBlank()) return visible
    return visible.filter { note ->
        !note.locked && (note.title + " " + NoteFormat.displayText(note.body) + " " + note.items.joinToString { it.text("data") })
            .contains(search, true)
    }
}

internal fun moveDraggedNote(visible: List<Note>, source: Note, targetId: String): List<String>? {
    val from = visible.indexOfFirst { it.syncId == source.syncId }
    val to = visible.indexOfFirst { it.syncId == targetId }
    if (from < 0 || to < 0 || from == to || visible[from].pinned != visible[to].pinned) return null
    val ids = visible.map { it.syncId }.toMutableList()
    ids.add(to, ids.removeAt(from))
    return ids
}

@Composable
internal fun MediaImage(app: KeptApplication, path: String) {
    var bitmap by remember(app.settings.profile, path) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(app.settings.profile, path) {
        bitmap = Media(app).preview(path, maxDimension = 768)
    }
    bitmap?.let { Image(it.asImageBitmap(), "Note image", Modifier.fillMaxWidth().heightIn(max = 240.dp)) }
}

@Composable
private fun SettingsDialog(activity: MainActivity, app: KeptApplication, reminders: List<JSONObject>, occurrences: List<JSONObject>, dark: Boolean, onDark: (Boolean) -> Unit,
    onClose: () -> Unit, onLogout: () -> Unit, onError: (String) -> Unit) {
    val scope = rememberCoroutineScope()
    val scheduler = app.reminders
    var alias by remember { mutableStateOf(app.settings.alias) }
    var confirmLogout by remember { mutableStateOf(false) }
    var pendingCount by remember { mutableIntStateOf(0) }
    LaunchedEffect(app.settings.profile) { pendingCount = app.repository.store.pending(app.settings.profile).size }
    AlertDialog(onDismissRequest = onClose, title = { Text("Kept settings") }, text = { Column(Modifier.verticalScroll(rememberScrollState())) {
        Text(app.settings.origin, style = MaterialTheme.typography.bodySmall)
        Row(verticalAlignment = Alignment.CenterVertically) { Text("Dark theme", Modifier.weight(1f)); Switch(dark, onDark) }
        Text("Time reminders", style = MaterialTheme.typography.titleMedium)
        Text(if (scheduler.notificationsAllowed()) "Notifications and reminder channel enabled" else "Notifications or the reminder channel are disabled")
        TextButton(onClick = { activity.requestNotifications(); activity.notificationSettings() }) { Text("Notification settings") }
        Text(if (scheduler.precise()) "Precise reminders enabled" else "Reminder delivery may be delayed without alarm access")
        if (!scheduler.precise()) TextButton(onClick = { activity.requestPreciseAlarms() }) { Text("Allow precise reminders") }
        val nextDelivery = ReminderPlanner.nextDelivery(reminders, occurrences, Instant.now())
        Text(nextDelivery?.let { "Next reminder: ${ReminderFormat.dateTime(it.toString())}" }
            ?: "No upcoming reminders", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { if (scheduler.notificationsAllowed()) scheduler.testNotification() else activity.requestNotifications() }) { Text("Send test notification") }
        Text("Client certificate: ${alias.ifBlank { "none" }}", Modifier.padding(top = 12.dp))
        TextButton(onClick = { activity.chooseCertificate(app.settings.origin) { alias = it; SyncWorker.enqueue(app) } }) { Text("Replace client certificate") }
        Text("Widgets follow your note order and show cached notes offline.", style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { scope.launch {
            try {
                val report = withContext(Dispatchers.IO) {
                    val store = app.database.store()
                    val connection = app.settings.snapshot()
                    val profile = connection.profile
                    val pending = store.pending(profile)
                    val payload = RedactedDiagnostics.build(
                        app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "unknown",
                        android.os.Build.VERSION.SDK_INT, android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL,
                        connection, app.repository.connectionState.value::class.simpleName ?: "Unknown",
                        store.list(profile, "note").size, reminders.size, pending, scheduler.notificationsAllowed(),
                        scheduler.precise(), app.settings.message.isNotBlank())
                    val folder = java.io.File(app.cacheDir, "diagnostics").apply { mkdirs() }
                    java.io.File(folder, "kept-diagnostics.txt").apply { writeText(payload.toString(2)) }
                }
                val uri = FileProvider.getUriForFile(app, "dev.kept.android.files", report)
                activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, "Redacted Kept diagnostics").putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Share diagnostics"))
            } catch (problem: Exception) { onError(problem.message ?: "Could not create diagnostics") }
        } }) { Text("Export redacted diagnostics") }
        TextButton(onClick = { confirmLogout = true }) { Text("Sign out and clear local data") }
    } }, confirmButton = { TextButton(onClick = onClose) { Text("Done") } })
    if (confirmLogout) AlertDialog(onDismissRequest = { confirmLogout = false }, title = { Text("Sign out?") },
        text = { Text(if (pendingCount > 0) "This clears cached notes, attachments, and $pendingCount unsynchronized change(s), including recovered drafts and pending uploads, from this device." else "This clears cached notes and attachments from this device.") },
        confirmButton = { TextButton(onClick = { confirmLogout = false; onLogout() }) { Text("Clear and sign out") } },
        dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("Cancel") } })
}
