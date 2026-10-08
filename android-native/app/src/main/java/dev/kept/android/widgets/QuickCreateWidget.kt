package dev.kept.android.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import androidx.core.net.toUri
import dev.kept.android.MainActivity
import dev.kept.android.R

class QuickCreateWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.quick_create_widget)
            views.setOnClickPendingIntent(R.id.quick_create_note, createIntent(context, id, false))
            views.setOnClickPendingIntent(R.id.quick_create_checklist, createIntent(context, id, true))
            manager.updateAppWidget(id, views)
        }
    }

    private fun createIntent(context: Context, widgetId: Int, checklist: Boolean) = PendingIntent.getActivity(
        context, widgetId, quickCreateIntent(context, widgetId, checklist), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
}

// PendingIntents are told apart by action/data, not extras, so each widget and kind has its own data URI.
internal fun quickCreateIntent(context: Context, widgetId: Int, checklist: Boolean) =
    Intent(context, MainActivity::class.java).setAction(NotesWidget.CREATE)
        .setData("keptnative://widget/quick/$widgetId/${if (checklist) "checklist" else "note"}".toUri())
        .putExtra("createNote", !checklist).putExtra("createChecklist", checklist)
