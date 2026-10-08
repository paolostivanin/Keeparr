package dev.keeparr.android.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.*
import android.graphics.Color
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
        val color = NotePalette.parse(note.raw.text("bgColor")) ?: Color.WHITE
        val foreground = widgetForegroundColor(color)
        if (item != null) {
            val itemLabel = item?.let { Html.fromHtml(boundedWidgetText(it.text("data"), 4096), Html.FROM_HTML_MODE_COMPACT)
                .toString().ifBlank { "Checklist item" }.let { text -> boundedWidgetText(text, 256) } }
            val itemRow = RemoteViews(app.packageName, R.layout.widget_checklist_item_row)
            itemRow.setInt(R.id.checklist_card_background, "setColorFilter", color)
            itemRow.setTextColor(R.id.checklist_item_row, foreground)
            itemRow.setTextViewText(R.id.checklist_item_row,
                (if (item.optBoolean("done")) "☑  " else "☐  ") + itemLabel)
            itemRow.setContentDescription(R.id.checklist_item_row,
                "${if (item.optBoolean("done")) "Complete" else "Incomplete"}: $itemLabel. Toggle checklist item")
            itemRow.setOnClickFillInIntent(R.id.checklist_item_row, widgetFillIn(row))
            return itemRow
        }
        return RemoteViews(app.packageName, R.layout.widget_row).apply {
            val title = if (note.locked) "Locked note" else (if (note.pinned) "📌 " else "") + note.title
            setTextViewText(R.id.row_title, boundedWidgetText(title, 160))
            setViewVisibility(R.id.row_title, if (title.isBlank()) View.GONE else View.VISIBLE)
            setTextColor(R.id.row_title, foreground)
            val body = widgetNoteBodyText(note, single)
            setTextViewText(R.id.row_body, boundedWidgetText(body, if (single) 4096 else 1024))
            setViewVisibility(R.id.row_body, if (body.isBlank()) View.GONE else View.VISIBLE)
            setTextColor(R.id.row_body, foreground)
            setInt(R.id.row_body, "setMaxLines", if (single) WIDGET_SINGLE_NOTE_MAX_LINES else WIDGET_CARD_MAX_LINES)
            if (reminder != null) {
                val label = "⏰ ${ReminderFormat.dateTime(ReminderFormat.displayDueAt(reminder))}"
                setTextViewText(R.id.row_reminder, label)
                setTextColor(R.id.row_reminder, foreground)
                setContentDescription(R.id.row_reminder, "Reminder ${ReminderFormat.dateTime(ReminderFormat.displayDueAt(reminder))}")
                setViewVisibility(R.id.row_reminder, View.VISIBLE)
            } else setViewVisibility(R.id.row_reminder, View.GONE)
            setViewVisibility(R.id.row_checks, View.GONE)
            setInt(R.id.widget_card_background, "setColorFilter", color)
            setOnClickFillInIntent(R.id.widget_row, widgetFillIn(row))
        }
    }

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
    note.checklist -> note.items.take(8).joinToString("\n") {
        (if (it.optBoolean("done")) "☑ " else "☐ ") + boundedWidgetText(widgetPlainText(it.text("data"), 512), 128)
    }
    else -> widgetPlainText(note.body, 8192)
}

internal fun widgetForegroundColor(background: Int): Int =
    if (Color.luminance(background) > .4f) Color.rgb(41, 39, 32) else Color.rgb(245, 243, 239)

/** A tap toggles only an identifiable checklist item of an unlocked note; every other tap opens the note. */
internal fun widgetFillIn(row: Row): Intent = Intent().putExtra("noteSyncId", row.note.syncId).apply {
    val item = row.item
    if (item != null && item.has("id") && !row.note.locked) putExtra("itemId", item.optLong("id")).putExtra("widgetToggle", true)
}
