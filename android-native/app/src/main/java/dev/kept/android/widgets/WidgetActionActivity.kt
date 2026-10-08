package dev.kept.android.widgets

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Toast
import dev.kept.android.KeptApplication
import dev.kept.android.MainActivity
import kotlinx.coroutines.launch

/**
 * Invisible landing point for widget row taps. A checklist toggle is committed through the repository (local Room write
 * plus outbox, like any edit) without starting the app UI; any other tap opens that note in the app.
 */
class WidgetActionActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val app = application as KeptApplication
        val noteSyncId = intent.getStringExtra("noteSyncId")
        if (noteSyncId != null && intent.hasExtra("itemId")) {
            val itemId = intent.getLongExtra("itemId", 0)
            app.scope.launch {
                app.settings.awaitReady()
                try {
                    app.repository.toggleChecklist(noteSyncId, itemId)
                    app.repository.flushWidgets()
                } catch (problem: Exception) {
                    runOnUiThread { Toast.makeText(app, problem.message ?: "The checklist item could not be changed", Toast.LENGTH_LONG).show() }
                }
            }
        } else if (noteSyncId != null) {
            startActivity(Intent(this, MainActivity::class.java).putExtra("noteSyncId", noteSyncId))
        }
        finish()
    }
}
