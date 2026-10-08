package dev.keeparr.android.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import dev.keeparr.android.BuildConfig
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.MainActivity
import dev.keeparr.android.data.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant

/** Full-screen settings, grouped into sections. About opens as a second full-screen page. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsScreen(activity: MainActivity, app: KeeparrApplication, reminders: List<JSONObject>, occurrences: List<JSONObject>,
    dark: Boolean, onDark: (Boolean) -> Unit, onClose: () -> Unit, onLogout: () -> Unit, onError: (String) -> Unit) {
    var showAbout by remember { mutableStateOf(false) }
    if (showAbout) { AboutScreen(onBack = { showAbout = false }); return }
    BackHandler(onBack = onClose)
    val scope = rememberCoroutineScope()
    val scheduler = app.reminders
    var alias by remember { mutableStateOf(app.settings.alias) }
    var confirmLogout by remember { mutableStateOf(false) }
    var pendingCount by remember { mutableIntStateOf(0) }
    // Permission state changes in system settings; re-read it when the user comes back.
    var refresh by remember { mutableIntStateOf(0) }
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { refresh++ }
    LaunchedEffect(app.settings.profile) { pendingCount = app.repository.store.pending(app.settings.profile).size }

    fun exportDiagnostics() {
        scope.launch {
            try {
                val report = withContext(Dispatchers.IO) {
                    val store = app.database.store()
                    val connection = app.settings.snapshot()
                    val profile = connection.profile
                    val pending = store.pending(profile)
                    val payload = RedactedDiagnostics.build(
                        app.packageManager.getPackageInfo(app.packageName, 0).versionName ?: "unknown",
                        android.os.Build.VERSION.SDK_INT, android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL,
                        connection, app.repository.connectionState.value::class.simpleName ?: "Unknown",
                        store.list(profile, "note").size, reminders.size, pending, scheduler.notificationsAllowed(),
                        scheduler.precise(), app.settings.message.isNotBlank())
                    val folder = java.io.File(app.cacheDir, "diagnostics").apply { mkdirs() }
                    java.io.File(folder, "keeparr-diagnostics.txt").apply { writeText(payload.toString(2)) }
                }
                val uri = FileProvider.getUriForFile(app, "dev.keeparr.android.files", report)
                activity.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_SUBJECT, "Redacted Keeparr diagnostics").putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), "Share diagnostics"))
            } catch (problem: Exception) { onError(problem.message ?: "Could not create diagnostics") }
        }
    }

    Scaffold(topBar = {
        TopAppBar(title = { Text("Settings") }, navigationIcon = {
            IconButton(onClick = onClose) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") }
        })
    }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            SettingsSection("Account") {
                SettingsRow(Icons.Outlined.Dns, "Server", app.settings.origin)
                SettingsDivider()
                SettingsRow(Icons.Outlined.Lock, "Client certificate", alias.ifBlank { "None selected" },
                    onClick = { activity.chooseCertificate(app.settings.origin) { alias = it; SyncWorker.enqueue(app) } })
            }
            SettingsSection("Appearance") {
                SettingsSwitchRow(Icons.Outlined.DarkMode, "Dark theme", null, dark, onDark)
            }
            SettingsSection("Reminders") {
                // `refresh` only exists to re-run these reads after returning from system settings.
                val notificationsAllowed = remember(refresh) { scheduler.notificationsAllowed() }
                val precise = remember(refresh) { scheduler.precise() }
                SettingsRow(Icons.Outlined.Notifications, "Notifications",
                    if (notificationsAllowed) "Enabled" else "Notifications or the reminder channel are disabled",
                    onClick = { activity.requestNotifications(); activity.notificationSettings() })
                SettingsDivider()
                SettingsRow(Icons.Outlined.Alarm, "Precise reminders",
                    if (precise) "Enabled" else "Delivery may be delayed without alarm access. Tap to allow.",
                    onClick = if (precise) null else ({ activity.requestPreciseAlarms() }))
                SettingsDivider()
                val nextDelivery = ReminderPlanner.nextDelivery(reminders, occurrences, Instant.now())
                SettingsRow(Icons.Outlined.Schedule, "Next reminder",
                    nextDelivery?.let { ReminderFormat.dateTime(it.toString()) } ?: "No upcoming reminders")
                SettingsDivider()
                SettingsRow(Icons.Outlined.NotificationsActive, "Send test notification", null,
                    onClick = { if (notificationsAllowed) scheduler.testNotification() else activity.requestNotifications() })
            }
            SettingsSection("Widgets") {
                SettingsRow(Icons.Outlined.Widgets, "Home screen widgets", "Widgets follow your note order and show cached notes offline.")
            }
            SettingsSection("Data and support") {
                SettingsRow(Icons.Outlined.BugReport, "Export redacted diagnostics", "Share a report with secrets removed",
                    onClick = ::exportDiagnostics)
                SettingsDivider()
                SettingsRow(Icons.Outlined.Info, "About Keeparr", "Version ${BuildConfig.VERSION_NAME}, licence and credits",
                    onClick = { showAbout = true })
            }
            SettingsSection("Danger zone") {
                SettingsRow(Icons.AutoMirrored.Outlined.Logout, "Sign out and clear local data",
                    "Removes cached notes and attachments from this device", danger = true, onClick = { confirmLogout = true })
            }
        }
    }
    if (confirmLogout) AlertDialog(onDismissRequest = { confirmLogout = false }, title = { Text("Sign out?") },
        text = { Text(if (pendingCount > 0) "This clears cached notes, attachments, and $pendingCount unsynchronized change(s), including recovered drafts and pending uploads, from this device." else "This clears cached notes and attachments from this device.") },
        confirmButton = { TextButton(onClick = { confirmLogout = false; onLogout() }) { Text("Clear and sign out") } },
        dismissButton = { TextButton(onClick = { confirmLogout = false }) { Text("Cancel") } })
}

/** A titled group of rows on a rounded container. */
@Composable
internal fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Text(title, Modifier.padding(horizontal = 28.dp, vertical = 8.dp), style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.primary)
        Surface(Modifier.padding(horizontal = 16.dp).fillMaxWidth(), shape = RoundedCornerShape(20.dp),
            color = MaterialTheme.colorScheme.surfaceContainer) { Column(content = content) }
    }
}

@Composable
internal fun SettingsDivider() = HorizontalDivider(Modifier.padding(start = 56.dp), color = MaterialTheme.colorScheme.outlineVariant)

@Composable
internal fun SettingsRow(icon: ImageVector, title: String, supporting: String?, onClick: (() -> Unit)? = null, danger: Boolean = false,
    trailing: (@Composable () -> Unit)? = null, modifier: Modifier = Modifier) {
    val tint = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
    ListItem(
        headlineContent = { Text(title, color = if (danger) MaterialTheme.colorScheme.error else Color.Unspecified) },
        supportingContent = supporting?.let { text -> { Text(text) } },
        leadingContent = { Icon(icon, contentDescription = null, tint = tint) },
        trailingContent = trailing,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = if (onClick != null) modifier.clickable(onClick = onClick) else modifier)
}

/** The whole row toggles, so the switch itself carries no click handler of its own. */
@Composable
internal fun SettingsSwitchRow(icon: ImageVector, title: String, supporting: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    SettingsRow(icon, title, supporting, trailing = { Switch(checked, onCheckedChange = null) },
        modifier = Modifier.toggleable(value = checked, role = Role.Switch, onValueChange = onChange))
}
