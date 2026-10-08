package dev.keeparr.android

import android.Manifest
import android.app.AlarmManager
import android.content.Intent
import androidx.core.net.toUri
import android.os.Bundle
import android.provider.Settings
import android.security.KeyChain
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.lifecycleScope
import dev.keeparr.android.data.*
import dev.keeparr.android.ui.KeeparrScreen
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.URI

class MainActivity : ComponentActivity() {
    val incoming = MutableStateFlow<Intent?>(null)
    private val app get() = application as KeeparrApplication
    private val notifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        app.scope.launch { app.repository.reconcile(EffectScope(alarms = true)) }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // A recreated activity still holds the intent that launched it; handling it again would repeat its
        // action (a share or quick-create would add another note after every rotation).
        if (savedInstanceState == null) incoming.value = intent
        app.ensureStartupRecovery()
        setContent { KeeparrScreen(this, app) }
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); incoming.value = intent }
    override fun onStart() {
        super.onStart()
        val recreated = app.recreatingForConfiguration
        app.recreatingForConfiguration = false
        app.repository.setForeground(true)
        if (!recreated) app.scope.launch { app.settings.awaitReady(); app.ensureStartupRecovery().join(); runCatching { app.repository.sync() } }
    }
    override fun onStop() {
        // The socket stays up across a configuration change; only a real background transition closes it.
        if (isChangingConfigurations) app.recreatingForConfiguration = true else app.repository.setForeground(false)
        super.onStop()
    }
    fun chooseCertificate(server: String, onSelected: (String) -> Unit) {
        val uri = runCatching { URI(server) }.getOrNull()
        KeyChain.choosePrivateKeyAlias(this, { alias -> runOnUiThread {
            if (alias != null) { app.settings.setAliasFor(server, alias); onSelected(alias) }
        } }, null, null, uri?.host, uri?.port?.takeIf { it > 0 } ?: 443, app.settings.aliasFor(server).ifBlank { null })
    }
    fun requestNotifications() = notifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    fun requestPreciseAlarms() = startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, "package:$packageName".toUri()))
    fun notificationSettings() = startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
}
