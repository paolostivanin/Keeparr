package dev.kept.android.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.*
import android.graphics.Color
import android.text.Html
import android.view.View
import android.widget.RemoteViews
import dev.kept.android.KeptApplication
import dev.kept.android.MainActivity
import dev.kept.android.R
import dev.kept.android.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import androidx.core.net.toUri
import org.json.JSONObject

class NotesWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = ids.forEach { render(context, it) }
    override fun onDeleted(context: Context, ids: IntArray) {
        val prefs = context.getSharedPreferences("widgets", Context.MODE_PRIVATE)
        ids.forEach { prefs.edit().remove("filter_$it").remove("profile_$it").apply() }
    }
    companion object {
        const val TOGGLE = "dev.kept.android.WIDGET_TOGGLE"
        fun render(context: Context, id: Int) {
            val app = context.applicationContext as KeptApplication
            app.scope.launch(Dispatchers.IO) {
                app.settings.awaitReady()
                val (rows, reminders, single) = load(app, id)
                val items = RemoteViews.RemoteCollectionItems.Builder().setHasStableIds(true).setViewTypeCount(2)
                rows.forEach { items.addItem(itemId(it), buildRow(app, it, reminders, single)) }
                val views = RemoteViews(context.packageName, R.layout.notes_widget)
                views.setRemoteAdapter(R.id.widget_list, items.build())
                val itemAction = Intent(context, MainActivity::class.java).setAction(TOGGLE)
                    .setData("keptnative://widget/action/$id".toUri())
                val open = PendingIntent.getActivity(context, id, itemAction, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                views.setPendingIntentTemplate(R.id.widget_list, open)
                views.setOnClickPendingIntent(R.id.widget_add, PendingIntent.getActivity(context, id + 20000,
                    Intent(context, MainActivity::class.java).putExtra("createNote", true), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                val message = if (app.settings.token.isEmpty()) "Open Kept to sign in" else app.settings.message
                views.setViewVisibility(R.id.widget_status, if (message.isEmpty()) View.GONE else View.VISIBLE)
                views.setTextViewText(R.id.widget_status, message)
                AppWidgetManager.getInstance(context).updateAppWidget(id, views)
            }
        }
        fun refresh(context: Context) {
            val ids = AppWidgetManager.getInstance(context).getAppWidgetIds(ComponentName(context, NotesWidget::class.java))
            ids.forEach { render(context, it) }
        }
    }
}

private data class Row(val note: Note, val item: JSONObject? = null, val itemIndex: Int = -1)
private data class Loaded(val rows: List<Row>, val reminders: Map<String, JSONObject>, val single: Boolean)

private suspend fun load(app: KeptApplication, widgetId: Int): Loaded {
    val preferences = app.getSharedPreferences("widgets", Context.MODE_PRIVATE)
    val filter = preferences.getString("filter_$widgetId", "home")!!
    val single = filter.startsWith("note:")
    val profile = preferences.getString("profile_$widgetId", app.settings.profile)!!
    if (profile != app.settings.profile || app.settings.token.isEmpty()) return Loaded(emptyList(), emptyMap(), single)
    val notes = NoteOrder.visible(app.database.store().list(profile, "note").map { Note(JSONObject(it.payload)) }, filter)
    val reminders = app.database.store().list(profile, "reminder").map { JSONObject(it.payload) }
    val note = notes.singleOrNull()
    val fullChecklist = note?.let(::singleNoteWidgetChecklistItems).orEmpty()
    val rows = if (single && fullChecklist.isNotEmpty()) listOf(Row(note!!)) + fullChecklist.mapIndexed { index, item -> Row(note, item, index) }
        else notes.map { Row(it) }
    return Loaded(rows, ReminderFormat.indexByNote(notes, reminders), single)
}

private fun itemId(row: Row): Long =
    if (row.item == null) row.note.id else "${row.note.syncId}:${row.item.optLong("id", row.itemIndex.toLong())}".hashCode().toLong()

private fun buildRow(app: KeptApplication, row: Row, reminders: Map<String, JSONObject>, single: Boolean): RemoteViews {
        val note = row.note
        val item = row.item
        val reminder = reminders[note.syncId]
        val interactiveChecklistItem = item != null && item.has("id") && !note.locked
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
            itemRow.setOnClickFillInIntent(R.id.checklist_item_row, Intent().putExtra("noteSyncId", note.syncId)
                .apply { if (interactiveChecklistItem) putExtra("itemId", item.optLong("id")).putExtra("widgetToggle", true) })
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
            setOnClickFillInIntent(R.id.widget_row, Intent().putExtra("noteSyncId", note.syncId))
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
    note.locked -> "Open Kept to view"
    single && note.checklist -> "Checklist · ${note.items.size} item(s)"
    note.checklist -> note.items.take(8).joinToString("\n") {
        (if (it.optBoolean("done")) "☑ " else "☐ ") + boundedWidgetText(widgetPlainText(it.text("data"), 512), 128)
    }
    else -> widgetPlainText(note.body, 8192)
}

internal fun widgetForegroundColor(background: Int): Int =
    if (Color.luminance(background) > .4f) Color.rgb(41, 39, 32) else Color.rgb(245, 243, 239)
