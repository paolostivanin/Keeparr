package dev.keeparr.android.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.keeparr.android.BuildConfig
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.MainActivity
import dev.keeparr.android.data.*
import dev.keeparr.android.ui.components.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.time.Instant

/** Full-screen settings, grouped into sections. About opens as a second full-screen page. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SettingsScreen(activity: MainActivity, app: KeeparrApplication, reminders: List<JSONObject>, occurrences: List<JSONObject>,
    theme: ThemeMode, onTheme: (ThemeMode) -> Unit, onClose: () -> Unit, onLogout: () -> Unit, onError: (String) -> Unit) {
    // Before the About branch, so returning from About doesn't replay the entrance.
    val enter = Modifier.screenEnter()
    var showAbout by rememberSaveable { mutableStateOf(false) }
    if (showAbout) { AboutScreen(onBack = { showAbout = false }); return }
    BackHandler(onBack = onClose)
    val scope = rememberCoroutineScope()
    val scheduler = app.reminders
    var alias by remember { mutableStateOf(app.settings.alias) }
    var confirmLogout by remember { mutableStateOf(false) }
    val moveCompletedToBottom by app.settings.moveCompletedToBottom.collectAsStateWithLifecycle()
    var pendingCount by remember { mutableIntStateOf(0) }
    var isAdmin by remember(app.settings.profile) { mutableStateOf(false) }
    var retentionDays by remember(app.settings.profile) { mutableStateOf<Int?>(null) }
    var retentionError by remember(app.settings.profile) { mutableStateOf<String?>(null) }
    var retentionRetry by remember(app.settings.profile) { mutableIntStateOf(0) }
    var showRetention by remember(app.settings.profile) { mutableStateOf(false) }
    var retentionInput by remember(app.settings.profile) { mutableStateOf("") }
    var retentionSaving by remember(app.settings.profile) { mutableStateOf(false) }
    var retentionSaveError by remember(app.settings.profile) { mutableStateOf<String?>(null) }
    LaunchedEffect(app.settings.profile, retentionRetry) {
        val connection = app.settings.snapshot()
        isAdmin = false; retentionDays = null; retentionError = null
        try {
            val user = JSONObject(app.repository.api.call("/api/users/me/preferences", connection = connection))
            if (app.settings.snapshot() != connection) return@LaunchedEffect
            isAdmin = user.optString("role") == "admin"
            if (isAdmin) {
                val result = JSONObject(app.repository.api.call("/api/trash-retention", connection = connection))
                if (app.settings.snapshot() != connection) return@LaunchedEffect
                retentionDays = result.getInt("days")
            }
        } catch (cancelled: CancellationException) { throw cancelled
        } catch (problem: Exception) { retentionError = problem.message ?: "Could not load server settings." }
    }
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
            } catch (cancelled: CancellationException) { throw cancelled
            } catch (problem: Exception) { onError(problem.message ?: "Could not create diagnostics") }
        }
    }

    SubpageScaffold("Settings", onBack = onClose, modifier = enter) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).centeredMaxWidth().padding(bottom = Spacing.xl)) {
            SettingsSection("Account") {
                SettingsRow(Icons.Outlined.Dns, "Server", app.settings.origin.ifBlank { "Not set" })
                SettingsDivider()
                SettingsRow(Icons.Outlined.VerifiedUser, "Client certificate", alias.ifBlank { "None selected" },
                    onClick = { activity.chooseCertificate(app.settings.origin) { alias = it; SyncWorker.enqueue(app) } })
                SettingsDivider()
                SettingsRow(Icons.AutoMirrored.Outlined.Logout, "Sign out", "Also removes cached notes and attachments from this device",
                    danger = true, onClick = { confirmLogout = true })
            }
            // Only once the account is known to be an administrator: an offline user whose role could not be read
            // shouldn't be shown an administration section.
            if (isAdmin) {
                SettingsSection("Administration") {
                    SettingsRow(Icons.Outlined.DeleteOutline, "Trash retention",
                        retentionError?.let { "$it Tap to retry." } ?: retentionDays?.let { "$it days · applies to all users" } ?: "Loading…",
                        onClick = if (retentionError != null) ({ retentionRetry++ }) else if (retentionDays != null) ({
                            retentionInput = retentionDays.toString(); retentionSaveError = null; showRetention = true
                        }) else null)
                }
            }
            SettingsSection("Appearance") {
                SettingsRow(Icons.Outlined.Contrast, "Theme", "Follow the system, or always light or dark")
                SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(start = Spacing.lg, end = Spacing.lg, bottom = Spacing.lg)) {
                    ThemeMode.entries.forEachIndexed { index, mode ->
                        SegmentedButton(selected = theme == mode, onClick = { onTheme(mode) },
                            shape = SegmentedButtonDefaults.itemShape(index, ThemeMode.entries.size),
                            icon = { SegmentedButtonDefaults.Icon(theme == mode) { Icon(themeIcon(mode), null, Modifier.size(SegmentedButtonDefaults.IconSize)) } }) {
                            Text(mode.name, maxLines = 1)
                        }
                    }
                }
                SettingsDivider()
                SettingsSwitchRow(Icons.Outlined.Checklist, "Move completed items to bottom",
                    "Checked items go to a collapsible section below the list", moveCompletedToBottom,
                    onChange = { app.settings.setMoveCompletedToBottom(it); app.refreshWidgets(app) })
            }
            SettingsSection("Reminders") {
                // `refresh` only exists to re-run these reads after returning from system settings.
                val notificationsAllowed = remember(refresh) { scheduler.notificationsAllowed() }
                val precise = remember(refresh) { scheduler.precise() }
                SettingsRow(Icons.Outlined.Notifications, "Notifications",
                    if (notificationsAllowed) "On" else "Notifications or the reminder channel are turned off",
                    warning = !notificationsAllowed, onClick = { activity.requestNotifications(); activity.notificationSettings() })
                SettingsDivider()
                SettingsRow(Icons.Outlined.Alarm, "Precise reminders",
                    if (precise) "On" else "Reminders may arrive late without alarm access. Tap to allow.",
                    warning = !precise, onClick = if (precise) null else ({ activity.requestPreciseAlarms() }))
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
        }
    }
    if (showRetention) {
        val valid = retentionInput.toIntOrNull()?.let { it in 7..365 } == true
        AlertDialog(onDismissRequest = { if (!retentionSaving) showRetention = false },
            icon = { Icon(Icons.Outlined.DeleteOutline, null) }, title = { Text("Trash retention") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
                    Text("Notes become eligible for permanent deletion after this many days. Changes apply to notes already in Trash.")
                    OutlinedTextField(retentionInput, { retentionInput = it.filter(Char::isDigit).take(3) }, label = { Text("Days") },
                        supportingText = { Text("Between 7 and 365") }, suffix = { Text("days") },
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true, isError = !valid,
                        modifier = Modifier.fillMaxWidth())
                    retentionSaveError?.let { StatusBanner(it, tone = BannerTone.Error) }
                }
            },
            confirmButton = { TextButton(enabled = !retentionSaving && valid,
                onClick = {
                    val days = retentionInput.toIntOrNull() ?: return@TextButton
                    val connection = app.settings.snapshot()
                    retentionSaving = true
                    retentionSaveError = null
                    scope.launch {
                        try {
                            val result = JSONObject(app.repository.api.call("/api/trash-retention", "PUT", JSONObject().put("days", days), connection))
                            if (app.settings.snapshot() == connection) { retentionDays = result.getInt("days"); showRetention = false }
                        } catch (cancelled: CancellationException) { throw cancelled
                        } catch (problem: Exception) { retentionSaveError = problem.message ?: "Could not save trash retention."
                        } finally { retentionSaving = false }
                    }
                }) { Text(if (retentionSaving) "Saving…" else "Save") } },
            dismissButton = { TextButton(enabled = !retentionSaving, onClick = { showRetention = false }) { Text("Cancel") } })
    }
    if (confirmLogout) ConfirmDialog(title = "Sign out?",
        text = if (pendingCount > 0) "This clears cached notes, attachments, and $pendingCount unsynchronized change(s), including recovered drafts and pending uploads, from this device."
            else "This clears cached notes and attachments from this device.",
        confirmLabel = "Clear and sign out", destructive = true, icon = Icons.AutoMirrored.Outlined.Logout,
        onConfirm = { confirmLogout = false; onLogout() }, onDismiss = { confirmLogout = false })
}

private fun themeIcon(mode: ThemeMode): ImageVector = when (mode) {
    ThemeMode.System -> Icons.Outlined.BrightnessAuto
    ThemeMode.Light -> Icons.Outlined.LightMode
    ThemeMode.Dark -> Icons.Outlined.DarkMode
}

/** A titled group of rows on a rounded tonal container. */
@Composable
internal fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = Spacing.md)) {
        Text(title, Modifier.padding(start = Spacing.xxl, end = Spacing.xxl, top = Spacing.sm, bottom = Spacing.sm).semantics { heading() },
            style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        Surface(Modifier.padding(horizontal = Dimens.screenGutter).fillMaxWidth(), shape = MaterialTheme.shapes.group,
            color = MaterialTheme.colorScheme.surfaceContainer) { Column(content = content) }
    }
}

/** Between rows of a section, starting at the text so the icons read as one column. */
@Composable
internal fun SettingsDivider() = HorizontalDivider(Modifier.padding(start = 56.dp), color = MaterialTheme.colorScheme.outlineVariant)

/**
 * One settings row. [danger] colors it as destructive, [warning] marks its icon as needing attention, and [external] adds an
 * open-in-new mark for a row that leaves the app.
 */
@Composable
internal fun SettingsRow(icon: ImageVector, title: String, supporting: String?, onClick: (() -> Unit)? = null, danger: Boolean = false,
    warning: Boolean = false, external: Boolean = false, trailing: (@Composable () -> Unit)? = null, modifier: Modifier = Modifier) {
    val tint = when {
        danger -> MaterialTheme.colorScheme.error
        warning -> MaterialTheme.extendedColors.warning
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    ListItem(
        headlineContent = { Text(title, color = if (danger) MaterialTheme.colorScheme.error else Color.Unspecified) },
        supportingContent = supporting?.let { text -> { Text(text) } },
        leadingContent = { Icon(icon, contentDescription = null, tint = tint) },
        trailingContent = trailing ?: if (external) ({
            Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "Opens in browser", Modifier.size(Dimens.iconSmall),
                tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }) else null,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = if (onClick != null) modifier.clickable(onClick = onClick) else modifier)
}

/** The whole row toggles, so the switch itself carries no click handler of its own. */
@Composable
internal fun SettingsSwitchRow(icon: ImageVector, title: String, supporting: String?, checked: Boolean, onChange: (Boolean) -> Unit) {
    SettingsRow(icon, title, supporting, trailing = { Switch(checked, onCheckedChange = null) },
        modifier = Modifier.toggleable(value = checked, role = Role.Switch, onValueChange = onChange))
}
