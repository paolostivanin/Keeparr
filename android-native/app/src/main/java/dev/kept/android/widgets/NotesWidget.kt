package dev.kept.android.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.*
import android.graphics.Color
import android.net.Uri
import android.text.Html
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import dev.kept.android.KeptApplication
import dev.kept.android.MainActivity
import dev.kept.android.R
import dev.kept.android.data.*
import kotlinx.coroutines.*
import org.json.JSONObject

class NotesWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = ids.forEach { render(context, it) }
    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == REFRESH) SyncWorker.enqueue(context)
    }
    override fun onDeleted(context: Context, ids: IntArray) {
        val prefs = context.getSharedPreferences("widgets", Context.MODE_PRIVATE)
        ids.forEach { prefs.edit().remove("filter_$it").remove("profile_$it").apply() }
    }
    companion object {
        const val REFRESH = "dev.kept.android.WIDGET_REFRESH"
        const val TOGGLE = "dev.kept.android.WIDGET_TOGGLE"
        fun render(context: Context, id: Int) {
            val app = context.applicationContext as KeptApplication
            val filter = context.getSharedPreferences("widgets", Context.MODE_PRIVATE).getString("filter_$id", "home")!!
            val views = RemoteViews(context.packageName, R.layout.notes_widget)
            views.setTextViewText(R.id.widget_title, boundedWidgetText(when {
                filter == "home" -> "Kept"
                filter == "pinned" -> "Pinned notes"
                filter.startsWith("note:") -> "Kept note"
                else -> filter.substringAfter(':')
            }, 80))
            val service = Intent(context, NotesWidgetService::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
                .setData(Uri.parse("keptnative://widget/$id"))
            views.setRemoteAdapter(R.id.widget_list, service)
            views.setEmptyView(R.id.widget_list, R.id.widget_empty)
            val itemAction = Intent(context, MainActivity::class.java).setAction(TOGGLE)
                .setData(Uri.parse("keptnative://widget/action/$id"))
            val open = PendingIntent.getActivity(context, id, itemAction, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
            views.setPendingIntentTemplate(R.id.widget_list, open)
            views.setOnClickPendingIntent(R.id.widget_title, PendingIntent.getActivity(context, id + 10000,
                Intent(context, WidgetConfigActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            views.setOnClickPendingIntent(R.id.widget_add, PendingIntent.getActivity(context, id + 20000,
                Intent(context, MainActivity::class.java).putExtra("createNote", true), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            views.setOnClickPendingIntent(R.id.widget_add_checklist, PendingIntent.getActivity(context, id + 30000,
                Intent(context, MainActivity::class.java).putExtra("createChecklist", true), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            views.setOnClickPendingIntent(R.id.widget_refresh, PendingIntent.getBroadcast(context, id,
                Intent(context, NotesWidget::class.java).setAction(REFRESH), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            val message = if (app.settings.token.isEmpty()) "Open Kept to sign in" else app.settings.message
            views.setViewVisibility(R.id.widget_status, if (message.isEmpty()) View.GONE else View.VISIBLE)
            views.setTextViewText(R.id.widget_status, message)
            AppWidgetManager.getInstance(context).updateAppWidget(id, views)
        }
        fun refresh(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, NotesWidget::class.java))
            ids.forEach { render(context, it) }
            manager.notifyAppWidgetViewDataChanged(ids, R.id.widget_list)
        }
    }
}

class NotesWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = Factory(applicationContext as KeptApplication,
        intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1))
    private class Factory(private val app: KeptApplication, private val widgetId: Int) : RemoteViewsFactory {
        private data class Row(val note: Note, val item: JSONObject? = null, val itemIndex: Int = -1)
        private var rows = emptyList<Row>()
        private var single = false
        override fun onCreate() = Unit
        override fun onDestroy() = Unit
        override fun onDataSetChanged() {
            val preferences = app.getSharedPreferences("widgets", Context.MODE_PRIVATE)
            val filter = preferences.getString("filter_$widgetId", "home")!!
            single = filter.startsWith("note:")
            val profile = preferences.getString("profile_$widgetId", app.settings.profile)!!
            val notes = if (profile != app.settings.profile || app.settings.token.isEmpty()) emptyList() else runBlocking(Dispatchers.IO) {
                NoteOrder.visible(app.database.store().list(profile, "note").map { Note(JSONObject(it.payload)) }, filter)
            }
            val note = notes.singleOrNull()
            val fullChecklist = note?.let(::singleNoteWidgetChecklistItems).orEmpty()
            rows = if (single && fullChecklist.isNotEmpty()) {
                listOf(Row(note!!)) + fullChecklist.mapIndexed { index, item -> Row(note, item, index) }
            } else notes.map { Row(it) }
        }
        override fun getCount() = rows.size
        override fun getViewAt(position: Int): RemoteViews? {
            val row = rows.getOrNull(position) ?: return null
            val note = row.note
            val item = row.item
            val interactiveChecklistItem = item != null && item.has("id") && !note.locked
            return RemoteViews(app.packageName, R.layout.widget_row).apply {
                val itemLabel = item?.let { Html.fromHtml(boundedWidgetText(it.text("data"), 4096), Html.FROM_HTML_MODE_COMPACT)
                    .toString().ifBlank { "Checklist item" }.let { text -> boundedWidgetText(text, 256) } }
                val title = if (item != null) "Item ${row.itemIndex + 1} of ${note.items.size}"
                    else if (note.locked) "Locked note" else (if (note.pinned) "📌 " else "") + note.title.ifBlank { "Untitled" }
                setTextViewText(R.id.row_title, boundedWidgetText(title, 160))
                val body = when {
                    note.locked -> "Open Kept to view"
                    item != null -> (if (item.optBoolean("done")) "☑ " else "☐ ") + itemLabel
                    single && note.checklist -> "Checklist · ${note.items.size} item(s)"
                    note.checklist -> note.items.take(8).joinToString("\n") {
                        (if (it.optBoolean("done")) "☑ " else "☐ ") + Html.fromHtml(boundedWidgetText(it.text("data"), 512), 0).toString().let { text -> boundedWidgetText(text, 128) }
                    }
                    else -> Html.fromHtml(boundedWidgetText(note.body, 8192), 0).toString()
                }
                setTextViewText(R.id.row_body, boundedWidgetText(body, if (single) 4096 else 1024))
                setInt(R.id.row_body, "setMaxLines", if (single && item == null) 30 else if (item != null) 4 else 8)
                setViewVisibility(R.id.row_checks, View.GONE)
                val color = runCatching { Color.parseColor(note.raw.text("bgColor")) }.getOrDefault(Color.WHITE)
                setInt(R.id.widget_row, "setBackgroundColor", color)
                setOnClickFillInIntent(R.id.widget_row, Intent().putExtra("noteSyncId", note.syncId)
                    .apply { if (interactiveChecklistItem) putExtra("itemId", item!!.optLong("id")).putExtra("widgetToggle", true) })
                if (interactiveChecklistItem) setContentDescription(R.id.widget_row,
                    "${if (item!!.optBoolean("done")) "Complete" else "Incomplete"}: $itemLabel. Toggle checklist item")
            }
        }
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 1
        override fun getItemId(position: Int): Long {
            val row = rows.getOrNull(position) ?: return 0
            return if (row.item == null) row.note.id else "${row.note.syncId}:${row.item.optLong("id", row.itemIndex.toLong())}".hashCode().toLong()
        }
        override fun hasStableIds() = true
    }
}

internal fun singleNoteWidgetChecklistItems(note: Note): List<JSONObject> =
    if (note.checklist && !note.locked) note.items else emptyList()

internal fun boundedWidgetText(text: String, maxCharacters: Int) = text.take(maxCharacters.coerceAtLeast(0))
