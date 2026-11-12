package dev.keeparr.android.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.staggeredgrid.rememberLazyStaggeredGridState
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.MainActivity
import dev.keeparr.android.data.ConnectionState
import dev.keeparr.android.data.Note
import dev.keeparr.android.data.ThemeMode
import dev.keeparr.android.ui.components.BrandMark
import dev.keeparr.android.ui.components.LocalSnackbarHostState
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.annotation.LooperMode
import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * Renders the real screens with sample notes, in light and dark, at a large font scale and on a tablet width, and writes
 * each one to build/reports/ui-gallery/ for review. Besides the pictures it is a smoke test: every screen and dialog has to
 * compose, lay out and draw. Window insets are zero here, so edge-to-edge spacing is not represented.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@LooperMode(LooperMode.Mode.PAUSED)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xhdpi")
class UiGalleryTest {
    @get:Rule val compose = createEmptyComposeRule()
    private lateinit var app: KeeparrApplication
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeeparrApplication
        app.scope.cancel()
        app.enqueueSync = {}
    }

    @After fun tearDown() {
        scenario?.close()
        app.repository.connectionState.value = ConnectionState.Configured
        app.database.close()
    }

    private fun launch(qualifiers: String? = null, fontScale: Float? = null) {
        qualifiers?.let { RuntimeEnvironment.setQualifiers(it) }
        fontScale?.let { RuntimeEnvironment.setFontScale(it) }
        // The editor treats a saved note that is missing from the database as removed from the server.
        runBlocking { notes.forEach { app.repository.save(it, synchronize = false) } }
        scenario = ActivityScenario.launch(MainActivity::class.java)
    }

    private var generation = 0

    /** Each scene composes from scratch: setContent alone would carry the previous scene's state (an open drawer) over. */
    private fun show(dark: Boolean, content: @Composable (MainActivity) -> Unit) {
        val scene = ++generation
        scenario!!.onActivity { activity -> activity.setContent { key(scene) {
            KeeparrTheme(dark) {
                CompositionLocalProvider(LocalSnackbarHostState provides remember { SnackbarHostState() }) {
                    Surface(Modifier.fillMaxSize()) { content(activity) }
                }
            }
        } } }
        compose.waitForIdle()
    }

    /** Every window on screen (the activity, then dialogs, sheets and popup menus) in the order they were added. */
    private fun windowRoots(): List<View> {
        val global = Class.forName("android.view.WindowManagerGlobal").getMethod("getInstance").invoke(null)
        val views = global.javaClass.getDeclaredField("mViews").apply { isAccessible = true }.get(global) as List<*>
        return views.filterIsInstance<View>().filter { it.isAttachedToWindow && it.width > 0 && it.height > 0 }
    }

    /**
     * Draws the activity and any window above it into one picture, dimming behind dialogs as the system would. Software
     * drawing, since Robolectric never runs a hardware draw pass (which captureToImage waits for).
     */
    private fun capture(name: String) {
        compose.waitForIdle()
        var base: View? = null
        scenario!!.onActivity { base = it.window.decorView }
        val activityRoot = base!!
        val bitmap = Bitmap.createBitmap(activityRoot.width, activityRoot.height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        activityRoot.draw(canvas)
        windowRoots().filter { it !== activityRoot }.forEach { view ->
            val params = view.layoutParams as? WindowManager.LayoutParams
            if (params != null && params.flags and WindowManager.LayoutParams.FLAG_DIM_BEHIND != 0)
                canvas.drawColor(android.graphics.Color.argb((params.dimAmount * 255).toInt(), 0, 0, 0))
            val location = IntArray(2).also(view::getLocationOnScreen)
            canvas.save()
            canvas.translate(location[0].toFloat(), location[1].toFloat())
            view.draw(canvas)
            canvas.restore()
        }
        File("build/reports/ui-gallery/$name.png").apply { parentFile!!.mkdirs() }.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun note(id: Long, title: String, body: String = "", color: String = "", pinned: Boolean = false, labels: List<String> = emptyList(),
        checklist: List<Pair<String, Boolean>>? = null, shared: Boolean = false): Note {
        val note = Note.create(app.settings.userId, checklist != null)
        note.raw.put("id", id).put("syncId", "note-$id").put("noteTitle", title).put("noteBody", body).put("bgColor", color)
            .put("pinned", pinned).put("sortOrder", 100.0 - id)
            .put("labels", JSONArray(labels.map { JSONObject().put("name", it).put("added", true) }))
        checklist?.let { rows -> note.raw.put("checkBoxes", JSONArray(rows.mapIndexed { index, (text, done) ->
            JSONObject().put("id", index + 1L).put("data", text).put("done", done) })) }
        if (shared) note.raw.put("collaborators", JSONArray().put(JSONObject().put("id", 99)))
        return note
    }

    private val notes by lazy { listOf(
        note(1, "Groceries", color = "#fff8b8", pinned = true, labels = listOf("Home"),
            checklist = listOf("Oat milk" to false, "Sourdough loaf" to false, "Basil" to true, "Lemons" to false)),
        note(2, "Trip to Lisbon", "<div>Book the tram tour, try the pastéis de nata in Belém, and check the miradouro opening hours.</div>",
            color = "#d2e3fc", pinned = true, labels = listOf("Travel", "2026")),
        note(3, "Ideas for the garden", "<div>Raised beds along the south fence. Ask about drip irrigation.</div>", labels = listOf("Home")),
        note(4, "Quarterly review", "<div>Wins, misses, and three priorities for next quarter.</div>", color = "#e6f4d7", shared = true),
        note(5, "", "<div>Remember to call the plumber about the kitchen tap before Friday.</div>"),
        note(6, "Books to read", color = "#fdcfe8", checklist = listOf("The Overstory" to true, "Piranesi" to false, "Klara and the Sun" to false)),
        note(7, "Wi-Fi at the cabin", "<div>Network: Pinecone · password on the fridge</div>", color = "#5b3a21", labels = listOf("Travel")),
    ) }

    private val reminders by lazy { listOf(JSONObject().put("syncId", "r1").put("status", "pending").put("noteSyncId", "note-5").put("noteId", 5)
        .put("title", "Call the plumber").put("timezone", "UTC")
        .put("dueAtUtc", Instant.now().plus(1, ChronoUnit.DAYS).truncatedTo(ChronoUnit.HOURS).toString())) }

    private var home = HomeState()

    /** Shows the home screen and waits for its projection, which runs off the main thread where waitForIdle can't see it. */
    private fun showHome(dark: Boolean, filter: String = "home", grid: Boolean = true, list: List<Note>? = notes, select: String? = null) {
        home = HomeState(filter).also { it.grid = grid }
        val state = home
        show(dark) {
            HomeScreen(app, state, rememberLazyStaggeredGridState(), list, reminders, emptyList(), onEdit = {}, onCreate = {}, onSettings = {},
                onReauthenticate = {}, onError = {})
        }
        compose.waitUntil(5_000) { state.projected }
        select?.let(state::select)
        compose.waitForIdle()
    }

    @Test fun home() {
        launch()
        for (dark in listOf(false, true)) {
            val theme = if (dark) "dark" else "light"
            showHome(dark)
            capture("home-grid-$theme")
            compose.onNodeWithContentDescription("Open navigation").performClick()
            capture("home-drawer-$theme")
            showHome(dark, grid = false)
            capture("home-list-$theme")
            showHome(dark, select = "note-2")
            capture("home-selection-$theme")
        }
        showHome(false, list = emptyList())
        capture("home-empty-light")
        showHome(false, filter = "trash", list = emptyList())
        capture("home-trash-empty-light")
        showHome(false, filter = "reminders")
        capture("home-reminders-light")
        showHome(false, filter = "label:Travel")
        capture("home-label-light")
        app.repository.connectionState.value = ConnectionState.Offline("The server did not respond in time. Check your network and try again.")
        showHome(false)
        capture("home-offline-light")
        app.repository.connectionState.value = ConnectionState.SessionExpired("Your session expired. Sign in again to keep syncing.")
        showHome(true)
        capture("home-session-expired-dark")
    }

    @Test fun signIn() {
        launch()
        show(false) { LoginScreen(it, app, onLogin = {}, onCancel = {}) }
        capture("login-light")
        compose.onNodeWithText("Advanced connection options").performClick()
        capture("login-advanced-light")
        show(true) { LoginScreen(it, app, onLogin = {}, onCancel = {}) }
        capture("login-dark")
        show(false) { SecondFactor(code = "4821", backup = false, error = null) }
        capture("login-2fa-light")
        show(false) { SecondFactor(code = "482193", backup = false, error = "Invalid 2FA code or backup code.") }
        capture("login-2fa-error-light")
        show(true) { SecondFactor(code = "K7Q2", backup = true, error = null) }
        capture("login-2fa-backup-dark")
    }

    /** The second sign-in step as the sign-in screen lays it out, below the brand mark. */
    @Composable
    private fun SecondFactor(code: String, backup: Boolean, error: String?) {
        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            BrandMark(56.dp, Modifier.padding(top = 16.dp))
            SecondFactorStep("paolo", "https://notes.example.com", code, onCodeChange = {}, backupCode = backup, onToggleBackupCode = {},
                error = error, verifying = false, onVerify = {}, onBack = {})
        }
    }

    @Test fun editor() {
        launch()
        val checklist = notes[0]
        val text = notes[1]
        for (dark in listOf(false, true)) {
            val theme = if (dark) "dark" else "light"
            show(dark) { NoteEditor(it, app, checklist, reminders, onClose = {}, onError = {}) }
            capture("editor-checklist-$theme")
            show(dark) { NoteEditor(it, app, text, reminders, onClose = {}, onError = {}) }
            compose.onNodeWithContentDescription("Formatting").performClick()
            capture("editor-text-format-$theme")
        }
        show(false) { NoteEditor(it, app, notes[4], reminders, onClose = {}, onError = {}) }
        capture("editor-plain-reminder-light")
        compose.onNodeWithContentDescription("Edit reminder").performClick()
        capture("dialog-reminder-light")
        show(false) { NoteEditor(it, app, text, reminders, onClose = {}, onError = {}) }
        compose.onNodeWithContentDescription("Background color").performClick()
        capture("sheet-background-light")
        show(true) { NoteEditor(it, app, text, reminders, onClose = {}, onError = {}) }
        compose.onNodeWithContentDescription("More note actions").performClick()
        capture("editor-menu-dark")
        val locked = note(20, "Secret", color = "#cbf0f8").also { it.raw.put("locked", true).put("lockHash", "sha256:x").put("lockSalt", "s") }
        runBlocking { app.repository.save(locked, synchronize = false) }
        show(false) { NoteEditor(it, app, locked, emptyList(), onClose = {}, onError = {}) }
        capture("editor-locked-light")
    }

    @Test fun settingsAndAbout() {
        launch()
        for (dark in listOf(false, true)) {
            val theme = if (dark) "dark" else "light"
            show(dark) { SettingsScreen(it, app, reminders, emptyList(), ThemeMode.System, onTheme = {}, onClose = {}, onLogout = {}, onError = {}) }
            capture("settings-$theme")
        }
        show(false) { AboutScreen(onBack = {}) }
        capture("about-light")
    }

    @Test fun largeFont() {
        launch(fontScale = 1.5f)
        showHome(false)
        capture("font150-home-light")
        show(false) { LoginScreen(it, app, onLogin = {}, onCancel = {}) }
        capture("font150-login-light")
        show(false) { NoteEditor(it, app, notes[0], reminders, onClose = {}, onError = {}) }
        capture("font150-editor-light")
    }

    @Test fun tablet() {
        launch(qualifiers = "w840dp-h1100dp-mdpi")
        showHome(false)
        capture("tablet-home-light")
        showHome(false, grid = false)
        capture("tablet-home-list-light")
        show(true) { SettingsScreen(it, app, reminders, emptyList(), ThemeMode.Dark, onTheme = {}, onClose = {}, onLogout = {}, onError = {}) }
        capture("tablet-settings-dark")
        show(false) { NoteEditor(it, app, notes[1], reminders, onClose = {}, onError = {}) }
        capture("tablet-editor-light")
    }
}
