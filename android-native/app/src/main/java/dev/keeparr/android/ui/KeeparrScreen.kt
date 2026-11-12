package dev.keeparr.android.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.staggeredgrid.rememberLazyStaggeredGridState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.MainActivity
import dev.keeparr.android.data.*
import dev.keeparr.android.data.html.NoteHtml
import dev.keeparr.android.ui.components.LoadingState
import dev.keeparr.android.ui.components.LocalSnackbarHostState
import dev.keeparr.android.ui.components.rememberActionRunner
import kotlinx.coroutines.CancellationException

@Composable
fun KeeparrScreen(activity: MainActivity, app: KeeparrApplication) {
    val repo = app.repository
    val settingsReady by app.settings.ready.collectAsStateWithLifecycle()
    val settingsWriteError by app.settings.writeError.collectAsStateWithLifecycle()
    // Derived from the settings once they are ready, in the same composition: seeding these from a LaunchedEffect
    // painted one login/light-theme frame before the stored session and theme were applied.
    var signedInOverride by remember { mutableStateOf<Boolean?>(null) }
    var themeOverride by remember { mutableStateOf<ThemeMode?>(null) }
    val signedIn = settingsReady && StartupGate.signedIn(signedInOverride, app.settings.token)
    val dark = StartupGate.dark(themeOverride, if (settingsReady) app.settings.themeMode else null, isSystemInDarkTheme())
    // Platform dialogs and View resources follow the app theme, not just the system's. Changing the night mode recreates the
    // activity, which is why the open note and the settings screen are saved state.
    val themeMode = StartupGate.mode(themeOverride, app.settings.themeMode)
    LaunchedEffect(settingsReady, themeMode) { if (settingsReady) applyNightMode(activity, themeMode) }
    // One slot, shown as a snackbar by the topmost screen. A newer message replaces the one on screen, so a burst of the same
    // failure (an autosave retrying) shows once instead of queueing.
    var error by remember { mutableStateOf<String?>(null) }
    val reportError: (String) -> Unit = remember { { message -> error = message } }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(error) {
        val message = error ?: return@LaunchedEffect
        try { snackbar.showSnackbar(message, withDismissAction = true, duration = SnackbarDuration.Long) }
        finally { if (error == message) error = null }
    }
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
    var showSettings by rememberSaveable { mutableStateOf(false) }
    val incoming by activity.incoming.collectAsStateWithLifecycle()
    val action = rememberActionRunner(reportError)
    KeeparrTheme(dark) {
        CompositionLocalProvider(LocalSnackbarHostState provides snackbar) {
        Surface(Modifier.fillMaxSize()) {
            if (!settingsReady) LoadingState()
            else if (!signedIn) LoginScreen(activity, app,
                onLogin = { signedInOverride = true; repo.authenticated(); action { SyncWorker.schedule(app); repo.sync(); repo.foreground(true) } },
                onCancel = { signedInOverride = true })
            else {
                // Null until the database has answered, so the home screen can tell "loading" from "no notes".
                val notes by remember(app.settings.profile) { repo.notes() }.collectAsStateWithLifecycle(initialValue = null as List<Note>?)
                val reminders by remember(app.settings.profile) { repo.reminders() }.collectAsStateWithLifecycle(emptyList())
                val occurrences by remember(app.settings.profile) { repo.occurrences() }.collectAsStateWithLifecycle(emptyList())
                val conflicts by remember(app.settings.profile) { repo.conflicts() }.collectAsStateWithLifecycle(emptyList())
                // The home screen leaves the composition while a note or Settings is open; its view, query, layout, scroll
                // position and last projection live here so it comes back exactly as it was. Leaving this branch (sign-out,
                // a profile switch) starts them fresh.
                val home = rememberSaveable(saver = HomeState.Saver) { HomeState() }
                val gridState = rememberLazyStaggeredGridState()
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
                            note.raw.put("noteTitle", NoteHtml.titleHtml(intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()))
                                .put("noteBody", NoteHtml.plainTextToHtml(text))
                            repo.save(note); openEditor(note)
                            val uris = if (intent.action == Intent.ACTION_SEND_MULTIPLE) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
                                else listOfNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java))
                            for (uri in uris) repo.attach(note, Media(app).stage(uri))
                        }
                    } catch (cancelled: CancellationException) { throw cancelled
                    } catch (problem: Exception) { problem.message?.let(reportError) }
                    activity.incoming.value = null
                }
                // One screen at a time: an open note wins (a widget can open one over Settings), then Settings, then home.
                val current = editing
                when {
                    current != null -> key(current.syncId) {
                        NoteEditor(activity, app, current, reminders, onClose = { closeEditor() }, onError = reportError)
                    }
                    // A note that was open before re-creation is being reloaded: don't flash the home screen meanwhile.
                    editingId != null -> LoadingState()
                    showSettings -> SettingsScreen(activity, app, reminders, occurrences, themeMode,
                        onTheme = { themeOverride = it; app.settings.themeMode = it; app.refreshWidgets(app) },
                        onClose = { showSettings = false }, onLogout = { action { repo.logout(); signedInOverride = false; showSettings = false } },
                        onError = reportError)
                    else -> HomeScreen(app, home, gridState, notes, reminders, conflicts, onEdit = { openEditor(it) }, onCreate = { checklist ->
                        action { val note = Note.create(app.settings.userId, checklist); repo.save(note); openEditor(note) }
                    }, onSettings = { showSettings = true }, onReauthenticate = { signedInOverride = false }, onError = reportError)
                }
            }
            // A setting that could not be written must be acknowledged, so it stays a dialog rather than a snackbar.
            settingsWriteError?.let { message ->
                AlertDialog(onDismissRequest = app.settings::clearWriteError, title = { Text("Setting not saved") }, text = { Text(message) },
                    confirmButton = { TextButton(onClick = app.settings::clearWriteError) { Text("OK") } })
            }
        }
        }
    }
}
