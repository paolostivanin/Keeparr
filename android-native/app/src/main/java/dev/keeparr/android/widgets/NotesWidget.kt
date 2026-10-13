package dev.keeparr.android.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.*
import android.text.Html
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.MainActivity
import dev.keeparr.android.R
import dev.keeparr.android.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import androidx.core.net.toUri
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import java.nio.ByteBuffer
import java.security.MessageDigest

class NotesWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = ids.forEach { render(context, it) }
    override fun onDeleted(context: Context, ids: IntArray) {
        val prefs = context.getSharedPreferences("widgets", Context.MODE_PRIVATE)
        ids.forEach { prefs.edit().remove("filter_$it").remove("profile_$it").apply() }
    }
    companion object {
        const val TOGGLE = "dev.keeparr.android.WIDGET_TOGGLE"
        const val CREATE = "dev.keeparr.android.WIDGET_CREATE"

        /**
         * Publishes the widget frame (adapter binding, click templates, status). Rows are not part of it: the system pulls
         * them one at a time from [NotesWidgetFactory], so a large collection never has to fit in one binder transaction.
         */
        fun render(context: Context, id: Int) {
            val app = context.applicationContext as KeeparrApplication
            app.scope.launch(Dispatchers.IO) {
                app.settings.awaitReady()
                val views = RemoteViews(context.packageName, R.layout.notes_widget)
                views.setRemoteAdapter(R.id.widget_list, Intent(context, NotesWidgetService::class.java)
                    .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id).setData("keeparrnative://widget/list/$id".toUri()))
                val itemAction = Intent(context, WidgetActionActivity::class.java).setAction(TOGGLE)
                    .setData("keeparrnative://widget/action/$id".toUri())
                views.setPendingIntentTemplate(R.id.widget_list, PendingIntent.getActivity(context, id, itemAction,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE))
                views.setOnClickPendingIntent(R.id.widget_add, PendingIntent.getActivity(context, id,
                    Intent(context, MainActivity::class.java).setAction(CREATE).setData("keeparrnative://widget/add/$id".toUri())
                        .putExtra("createNote", true), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                applyStatus(app, views)
                applyFrameColors(app, views, app.settings.themeMode)
                AppWidgetManager.getInstance(context).updateAppWidget(id, views)
            }
        }

        private fun applyStatus(app: KeeparrApplication, views: RemoteViews) {
            val message = if (app.settings.token.isEmpty()) "Open Keeparr to sign in" else app.settings.message
            views.setViewVisibility(R.id.widget_status, if (message.isEmpty()) View.GONE else View.VISIBLE)
            views.setTextViewText(R.id.widget_status, message)
        }

        /** Full recovery: republish every widget frame and reload every collection. */
        fun refresh(context: Context) {
            val ids = AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, NotesWidget::class.java))
            ids.forEach { render(context, it) }
        }

        /**
         * Reloads only the widgets whose notes, order or reminders [scope] can have changed. The frame and the adapter binding
         * stay as published, so the list keeps its scroll position and stable row ids anchor it through the change.
         */
        fun refresh(context: Context, scope: EffectScope) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, NotesWidget::class.java))
            val preferences = context.getSharedPreferences("widgets", Context.MODE_PRIVATE)
            val affected = ids.filter { scope.affectsWidget(preferences.getString("filter_$it", "home")!!) }
            if (affected.isEmpty()) return
            val app = context.applicationContext as KeeparrApplication
            app.scope.launch(Dispatchers.IO) {
                app.settings.awaitReady()
                val status = RemoteViews(context.packageName, R.layout.notes_widget).also { applyStatus(app, it) }
                affected.forEach {
                    manager.partiallyUpdateAppWidget(it, status)
                    manager.notifyAppWidgetViewDataChanged(it, R.id.widget_list)
                }
            }
        }
    }
}

/** Supplies widget rows lazily; the system asks for each visible row, so IPC per call is one bounded row. */
class NotesWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        NotesWidgetFactory(application as KeeparrApplication, intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID))
}

class NotesWidgetFactory(private val app: KeeparrApplication, private val widgetId: Int) : RemoteViewsService.RemoteViewsFactory {
    @Volatile private var loaded = Loaded(emptyList(), emptyMap(), false)
    override fun onCreate() = Unit
    // The system calls this on a binder thread and allows it to block.
    override fun onDataSetChanged() { loaded = runBlocking(Dispatchers.IO) { app.settings.awaitReady(); load(app, widgetId) } }
    override fun onDestroy() { loaded = Loaded(emptyList(), emptyMap(), false) }
    override fun getCount() = loaded.rows.size
    override fun getViewAt(position: Int): RemoteViews? {
        val snapshot = loaded
        val row = snapshot.rows.getOrNull(position) ?: return null
        return buildRow(app, row, snapshot.reminders, snapshot.single)
    }
    override fun getLoadingView(): RemoteViews? = null
    override fun getViewTypeCount() = 2
    override fun getItemId(position: Int) = loaded.rows.getOrNull(position)?.id ?: position.toLong()
    override fun hasStableIds() = true
}

internal data class Row(val note: Note, val item: JSONObject? = null, val itemIndex: Int = -1, val id: Long = widgetRowId(note.syncId))
internal data class Loaded(val rows: List<Row>, val reminders: Map<String, JSONObject>, val single: Boolean)

/**
 * A row's identity comes from the note's syncId (and the checklist item's id), never from the numeric note id that changes
 * when the server accepts a new note, and is a 64-bit digest so unrelated rows do not collide.
 */
internal fun widgetRowId(syncId: String, itemKey: String? = null): Long {
    val digest = MessageDigest.getInstance("SHA-256")
        .digest((if (itemKey == null) "note\u0000$syncId" else "item\u0000$syncId\u0000$itemKey").toByteArray())
    return ByteBuffer.wrap(digest).long
}

internal suspend fun load(app: KeeparrApplication, widgetId: Int): Loaded {
    val preferences = app.getSharedPreferences("widgets", Context.MODE_PRIVATE)
    val filter = preferences.getString("filter_$widgetId", "home")!!
    val single = filter.startsWith("note:")
    val profile = preferences.getString("profile_$widgetId", app.settings.profile)!!
    if (profile != app.settings.profile || app.settings.token.isEmpty()) return Loaded(emptyList(), emptyMap(), single)
    val notes = NoteOrder.visible(app.database.store().list(profile, "note").map { Note(JSONObject(it.payload)) }, filter)
    val reminders = app.database.store().list(profile, "reminder").map { JSONObject(it.payload) }
    val note = notes.singleOrNull()
    val fullChecklist = note?.let(::singleNoteWidgetChecklistItems).orEmpty()
    val rows = if (single && fullChecklist.isNotEmpty()) {
        val seen = HashSet<String>()
        listOf(Row(note!!)) + fullChecklist.mapIndexed { index, item ->
            val key = item.opt("id")?.toString()?.takeIf { seen.add(it) } ?: "#$index"
            Row(note, item, index, widgetRowId(note.syncId, key))
        }
    } else notes.map { Row(it) }
    return Loaded(rows, ReminderFormat.indexByNote(notes, reminders), single)
}

internal fun buildRow(app: KeeparrApplication, row: Row, reminders: Map<String, JSONObject>, single: Boolean): RemoteViews {
        val note = row.note
        val item = row.item
        val reminder = reminders[note.syncId]
        // A note's own color is shown as its light or dark variant. Under ThemeMode.System both are handed to the host, which
        // picks by the system night mode without the row being rebuilt; a forced mode sends the one explicit color.
        val mode = app.settings.themeMode
        val colors = WidgetColors(app)
        val card = colors.card(note.raw.text("bgColor"))
        val foreground = colors.text(note.raw.text("bgColor"))
        if (item != null) {
            val itemLabel = item?.let { Html.fromHtml(boundedWidgetText(it.text("data"), 4096), Html.FROM_HTML_MODE_COMPACT)
                .toString().ifBlank { "Checklist item" }.let { text -> boundedWidgetText(text, 256) } }
            val done = item.optBoolean("done")
            val itemRow = RemoteViews(app.packageName, R.layout.widget_checklist_item_row)
            itemRow.tint(R.id.checklist_card_background, "setColorFilter", mode, card)
            itemRow.tint(R.id.checklist_item_row, "setTextColor", mode, foreground)
            itemRow.setImageViewResource(R.id.checklist_item_check, checkIcon(done))
            itemRow.tint(R.id.checklist_item_check, "setColorFilter", mode, foreground)
            itemRow.setTextViewText(R.id.checklist_item_row, itemLabel)
            itemRow.setContentDescription(R.id.checklist_item_content,
                "${if (done) "Complete" else "Incomplete"}: $itemLabel. Toggle checklist item")
            itemRow.setOnClickFillInIntent(R.id.checklist_item_content, widgetFillIn(row))
            return itemRow
        }
        return RemoteViews(app.packageName, R.layout.widget_row).apply {
            val title = if (note.locked) "Locked note" else (if (note.pinned) "📌 " else "") + note.title
            setTextViewText(R.id.row_title, boundedWidgetText(title, 160))
            setViewVisibility(R.id.row_title, if (title.isBlank()) View.GONE else View.VISIBLE)
            tint(R.id.row_title, "setTextColor", mode, foreground)
            val body = widgetNoteBodyText(note, single)
            setTextViewText(R.id.row_body, boundedWidgetText(body, if (single) 4096 else 1024))
            setViewVisibility(R.id.row_body, if (body.isBlank()) View.GONE else View.VISIBLE)
            tint(R.id.row_body, "setTextColor", mode, foreground)
            setInt(R.id.row_body, "setMaxLines", if (single) WIDGET_SINGLE_NOTE_MAX_LINES else WIDGET_CARD_MAX_LINES)
            // A recycled row view still holds the previous note's lines, so they are always cleared first.
            removeAllViews(R.id.row_checks)
            val lines = if (single) emptyList() else widgetChecklistLines(note)
            lines.forEach { (done, text) ->
                addView(R.id.row_checks, RemoteViews(app.packageName, R.layout.widget_check_line).apply {
                    setImageViewResource(R.id.check_line_icon, checkIcon(done))
                    setContentDescription(R.id.check_line_icon, if (done) "Complete" else "Incomplete")
                    tint(R.id.check_line_icon, "setColorFilter", mode, foreground)
                    setTextViewText(R.id.check_line_text, text)
                    tint(R.id.check_line_text, "setTextColor", mode, foreground)
                })
            }
            setViewVisibility(R.id.row_checks, if (lines.isEmpty()) View.GONE else View.VISIBLE)
            if (reminder != null) {
                val label = "⏰ ${ReminderFormat.dateTime(ReminderFormat.displayDueAt(reminder))}"
                setTextViewText(R.id.row_reminder, label)
                tint(R.id.row_reminder, "setTextColor", mode, foreground)
                setContentDescription(R.id.row_reminder, "Reminder ${ReminderFormat.dateTime(ReminderFormat.displayDueAt(reminder))}")
                setViewVisibility(R.id.row_reminder, View.VISIBLE)
            } else setViewVisibility(R.id.row_reminder, View.GONE)
            setViewVisibility(R.id.row_shared, if (note.shared) View.VISIBLE else View.GONE)
            tint(R.id.row_shared, "setColorFilter", mode, foreground)
            tint(R.id.widget_card_background, "setColorFilter", mode, card)
            setOnClickFillInIntent(R.id.widget_row, widgetFillIn(row))
        }
    }

/** A color for the light and for the dark theme. */
internal data class WidgetColor(val light: Int, val dark: Int)

/** The widget's colors per theme: a note's own color through [NotePalette], everything else from the color resources. */
internal class WidgetColors(private val app: KeeparrApplication) {
    // Resolving the resources in each night configuration gives both variants whatever the system mode is, which a forced
    // ThemeMode needs because the host only knows the system's.
    private val lightResources = app.createConfigurationContext(configuration(night = false))
    private val darkResources = app.createConfigurationContext(configuration(night = true))

    private fun configuration(night: Boolean) = android.content.res.Configuration(app.resources.configuration).apply {
        uiMode = (uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK.inv()) or
            if (night) android.content.res.Configuration.UI_MODE_NIGHT_YES else android.content.res.Configuration.UI_MODE_NIGHT_NO
    }

    fun resource(@androidx.annotation.ColorRes id: Int) = WidgetColor(lightResources.getColor(id), darkResources.getColor(id))

    /** The card background for a note's stored color, or the widget's default card when it has none. */
    fun card(stored: String): WidgetColor = NotePalette.parse(stored)?.let {
        WidgetColor(NotePalette.display(it, false), NotePalette.display(it, true))
    } ?: resource(R.color.widget_note_card)

    /** The text color drawn on [card] for the same stored color. */
    fun text(stored: String): WidgetColor {
        val card = card(stored)
        return if (NotePalette.parse(stored) == null) resource(R.color.widget_text)
        else WidgetColor(NotePalette.textColor(card.light), NotePalette.textColor(card.dark))
    }
}

internal fun RemoteViews.tint(viewId: Int, method: String, mode: ThemeMode, color: WidgetColor) = when (mode) {
    ThemeMode.System -> setColorInt(viewId, method, color.light, color.dark)
    ThemeMode.Light -> setInt(viewId, method, color.light)
    ThemeMode.Dark -> setInt(viewId, method, color.dark)
}

/** Same for a ColorStateList method, which is how a shape drawable background is recolored without losing its corners. */
private fun RemoteViews.tintList(viewId: Int, method: String, mode: ThemeMode, color: WidgetColor) {
    fun list(value: Int) = android.content.res.ColorStateList.valueOf(value)
    when (mode) {
        ThemeMode.System -> setColorStateList(viewId, method, list(color.light), list(color.dark))
        ThemeMode.Light -> setColorStateList(viewId, method, list(color.light), list(color.light))
        ThemeMode.Dark -> setColorStateList(viewId, method, list(color.dark), list(color.dark))
    }
}

/**
 * The frame's default colors. Under ThemeMode.System the layout's own color resources already follow the host's night mode;
 * a forced mode has to say so explicitly.
 */
internal fun applyFrameColors(app: KeeparrApplication, views: RemoteViews, mode: ThemeMode) {
    if (mode == ThemeMode.System) return
    val colors = WidgetColors(app)
    views.tintList(R.id.widget_frame, "setBackgroundTintList", mode, colors.resource(R.color.widget_background))
    views.tintList(R.id.widget_status, "setBackgroundTintList", mode, colors.resource(R.color.widget_card))
    views.tint(R.id.widget_status, "setTextColor", mode, colors.resource(R.color.widget_text_status))
    views.tintList(R.id.widget_add, "setBackgroundTintList", mode, colors.resource(R.color.widget_fab))
    views.tintList(R.id.widget_add, "setImageTintList", mode, colors.resource(R.color.widget_fab_icon))
}

private fun checkIcon(done: Boolean) = if (done) R.drawable.ic_widget_check_on else R.drawable.ic_widget_check_off

internal fun singleNoteWidgetChecklistItems(note: Note): List<JSONObject> =
    if (note.checklist && !note.locked) note.items else emptyList()

internal fun boundedWidgetText(text: String, maxCharacters: Int) = text.take(maxCharacters.coerceAtLeast(0))

internal const val WIDGET_CARD_MAX_LINES = 6
internal const val WIDGET_SINGLE_NOTE_MAX_LINES = 30

// Compact mode keeps one newline between paragraphs; the legacy flag adds blank lines that eat the card's line budget.
private fun widgetPlainText(html: String, maxCharacters: Int) =
    Html.fromHtml(boundedWidgetText(html, maxCharacters), Html.FROM_HTML_MODE_COMPACT).toString().trim()

internal fun widgetNoteBodyText(note: Note, single: Boolean): String = when {
    note.locked -> "Open Keeparr to view"
    single && note.checklist -> "Checklist · ${note.items.size} item(s)"
    // A checklist's items are drawn as icon rows (see widgetChecklistLines), not as body text.
    note.checklist -> ""
    // Bullets are spans, not characters, so only a body with a list needs the bullet-aware conversion; every other body
    // keeps the widget's own whitespace handling.
    note.body.contains("<li", ignoreCase = true) -> NoteFormat.previewText(boundedWidgetText(note.body, 8192)).trim()
    else -> widgetPlainText(note.body, 8192)
}

/** The checklist rows a card shows (done, text), at most as many as the card has lines. */
internal fun widgetChecklistLines(note: Note): List<Pair<Boolean, String>> =
    if (note.checklist && !note.locked) note.items.take(WIDGET_CARD_MAX_LINES).map {
        it.optBoolean("done") to boundedWidgetText(widgetPlainText(it.text("data"), 512), 128)
    } else emptyList()

/** A tap toggles only an identifiable checklist item of an unlocked note; every other tap opens the note. */
internal fun widgetFillIn(row: Row): Intent = Intent().putExtra("noteSyncId", row.note.syncId).apply {
    val item = row.item
    if (item != null && item.has("id") && !row.note.locked) putExtra("itemId", item.optLong("id")).putExtra("widgetToggle", true)
}
