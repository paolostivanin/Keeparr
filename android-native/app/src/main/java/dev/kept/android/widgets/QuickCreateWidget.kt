package dev.kept.android.widgets

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.widget.RemoteViews
import dev.kept.android.MainActivity
import dev.kept.android.R

class QuickCreateWidget : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        ids.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.quick_create_widget)
            views.setOnClickPendingIntent(R.id.quick_create_note, createIntent(context, id * 2, false))
            views.setOnClickPendingIntent(R.id.quick_create_checklist, createIntent(context, id * 2 + 1, true))
            manager.updateAppWidget(id, views)
        }
    }

    private fun createIntent(context: Context, requestCode: Int, checklist: Boolean) = PendingIntent.getActivity(
        context, requestCode,
        Intent(context, MainActivity::class.java).putExtra("createNote", !checklist).putExtra("createChecklist", checklist),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
}
