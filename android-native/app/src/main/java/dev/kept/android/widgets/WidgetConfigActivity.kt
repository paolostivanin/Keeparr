package dev.kept.android.widgets

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.kept.android.KeptApplication
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class WidgetConfigActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setResult(RESULT_CANCELED)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (id == AppWidgetManager.INVALID_APPWIDGET_ID) { finish(); return }
        val app = application as KeptApplication
        setContent {
            val scope = rememberCoroutineScope()
            var choices by remember { mutableStateOf(listOf("home" to "All notes, in app order", "pinned" to "Pinned notes")) }
            LaunchedEffect(Unit) {
                val notes = app.repository.notes().first()
                choices = choices + notes.flatMap { it.labels }.distinct().sorted().map { "label:$it" to "Label: $it" } +
                    notes.map { it.binder }.filter { it.isNotBlank() }.distinct().sorted().map { "binder:$it" to "Binder: $it" } +
                    notes.filter { !it.archived && !it.trashed }.map { "note:${it.syncId}" to "Single note: ${if (it.locked) "Locked note" else it.title.ifBlank { "Untitled" }}" }
            }
            MaterialTheme {
                Surface(Modifier.fillMaxSize()) {
                    Column(Modifier.padding(20.dp)) {
                        Text("Choose widget notes", style = MaterialTheme.typography.headlineSmall)
                        Text("Each view follows the order in Kept.", Modifier.padding(vertical = 12.dp))
                        LazyColumn {
                            items(choices) { (filter, label) ->
                                TextButton(onClick = {
                                    getSharedPreferences("widgets", MODE_PRIVATE).edit().putString("filter_$id", filter)
                                        .putString("profile_$id", app.settings.profile).commit()
                                    NotesWidget.render(this@WidgetConfigActivity, id)
                                    AppWidgetManager.getInstance(this@WidgetConfigActivity).apply {
                                        notifyAppWidgetViewDataChanged(intArrayOf(id), dev.kept.android.R.id.widget_list)
                                    }
                                    setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
                                    finish()
                                }, modifier = Modifier.fillMaxWidth()) { Text(label) }
                            }
                        }
                    }
                }
            }
        }
    }
}
