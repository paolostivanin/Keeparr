package dev.kept.android

import android.Manifest
import android.app.AlarmManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.security.KeyChain
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import dev.kept.android.data.*
import dev.kept.android.ui.KeptScreen
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URI

class MainActivity : ComponentActivity() {
    val incoming = MutableStateFlow<Intent?>(null)
    private val app get() = application as KeptApplication
    private var alarmRecovery: Job? = null
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        app.scope.launch { app.repository.reconcile() }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        incoming.value = intent
        alarmRecovery = app.scope.launch {
            app.reminders.resetAlarmRegistry()
            app.repository.reconcile()
        }
        setContent { KeptScreen(this, app) }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); incoming.value = intent }
    override fun onStart() { super.onStart(); app.scope.launch { alarmRecovery?.join(); runCatching { app.repository.foreground(true); app.repository.sync() } } }
    override fun onStop() { app.scope.launch { app.repository.foreground(false) }; super.onStop() }
    override fun onResume() { super.onResume(); app.scope.launch { alarmRecovery?.join(); app.repository.reconcile() } }
    fun chooseCertificate(server: String, onSelected: (String) -> Unit) {
        val uri = runCatching { URI(server) }.getOrNull()
        KeyChain.choosePrivateKeyAlias(this, { alias -> runOnUiThread {
            if (alias != null) { app.settings.setAliasFor(server, alias); onSelected(alias) }
        } }, null, null, uri?.host, uri?.port?.takeIf { it > 0 } ?: 443, app.settings.aliasFor(server).ifBlank { null })
    }
    fun requestNotifications() { if (Build.VERSION.SDK_INT >= 33) notifications.launch(Manifest.permission.POST_NOTIFICATIONS) }
    fun requestPreciseAlarms() {
        if (Build.VERSION.SDK_INT >= 31) startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")))
    }
    fun notificationSettings() = startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
}
