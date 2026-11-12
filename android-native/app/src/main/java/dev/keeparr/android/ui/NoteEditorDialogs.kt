@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class, androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
package dev.keeparr.android.ui

import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Label
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.MainActivity
import dev.keeparr.android.data.*
import dev.keeparr.android.ui.components.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.time.*
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/** The note's background: a color swatch or an illustration, each with a "none" choice first. */
@Composable
internal fun NoteColorPicker(selectedColor: String, selectedImage: NoteBackground?, onDismiss: () -> Unit, onSelect: (String) -> Unit,
    onSelectImage: (NoteBackground?) -> Unit) {
    val dark = LocalDarkTheme.current
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.xl).padding(bottom = Spacing.xl),
            verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
            Text("Background", style = MaterialTheme.typography.titleLarge)
            SectionHeader("Color")
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.md), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
                NotePalette.colors.forEach { swatch ->
                    val isSelected = NotePalette.sameColor(selectedColor, swatch.hex)
                    // The swatch shows the variant the note will be drawn in under the current theme.
                    val color = if (swatch.hex.isEmpty()) MaterialTheme.colorScheme.surfaceContainerHighest
                        else Color(android.graphics.Color.parseColor(if (dark) swatch.dark else swatch.hex))
                    val foreground = if (swatch.hex.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else Color(NotePalette.textColor(color.toArgb()))
                    Box(Modifier.size(Dimens.minTouchTarget).clip(CircleShape).background(color)
                        .border(if (isSelected) 3.dp else 1.dp, if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, CircleShape)
                        .semantics { contentDescription = "${swatch.name} background color"; selected = isSelected; role = Role.RadioButton }
                        .clickable { onSelect(swatch.hex) }, contentAlignment = Alignment.Center) {
                        if (swatch.hex.isEmpty()) Icon(Icons.Outlined.FormatColorReset, null, tint = foreground)
                        else if (isSelected) Icon(Icons.Outlined.Check, null, tint = foreground)
                    }
                }
            }
            SectionHeader("Illustration")
            LazyRow(horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                items(listOf<NoteBackground?>(null) + NoteBackground.entries) { image ->
                    val isSelected = image == selectedImage
                    Box(Modifier.size(64.dp).clip(MaterialTheme.shapes.card).background(MaterialTheme.colorScheme.surfaceContainerHighest)
                        .noteBackgroundImage(image, dark, thumbnail = true, anchor = BackgroundAnchor.Center)
                        .border(if (isSelected) 3.dp else 1.dp, if (isSelected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.card)
                        .semantics { contentDescription = "${image?.label ?: "No"} background image"; selected = isSelected; role = Role.RadioButton }
                        .clickable { onSelectImage(image) }, contentAlignment = Alignment.Center) {
                        if (image == null) Icon(Icons.Outlined.HideImage, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        }
    }
}

private val repeatChoices = listOf("none" to "Once", "daily" to "Daily", "weekly" to "Weekly", "monthly" to "Monthly", "custom_days" to "Every N days")

/**
 * Sets, changes or removes the note's reminder. [onSave] and [onRemove] run here, so a failure is shown in the dialog
 * (which stays open) rather than behind it.
 */
@Composable
internal fun ReminderDialog(activity: MainActivity, app: KeeparrApplication, existing: JSONObject?, onClose: () -> Unit,
    onSave: suspend (String, String, String?) -> Unit, onRemove: suspend () -> Unit) {
    // An existing reminder keeps its own time zone: re-saving it (for any reason) must not silently move a repeating
    // schedule to wherever the phone is today. A new reminder uses the phone's zone.
    val systemZone = remember(existing?.text("timezone")) {
        existing?.text("timezone")?.takeIf { it.isNotBlank() }?.let { runCatching { ZoneId.of(it) }.getOrNull() } ?: ZoneId.systemDefault()
    }
    val timezone = systemZone.id
    var time by remember(existing?.text("syncId"), existing?.text("dueAtUtc"), timezone) {
        mutableStateOf(runCatching { Instant.parse(existing?.let { ReminderFormat.displayDueAt(it) }) }.getOrNull()?.atZone(systemZone)
            ?: ZonedDateTime.now(systemZone).plusHours(1).withSecond(0).withNano(0))
    }
    val existingRepeat = remember(existing?.text("repeatRule")) { runCatching { JSONObject(existing?.text("repeatRule") ?: "") }.getOrNull() }
    var repeat by remember { mutableStateOf(existingRepeat?.text("type") ?: "none") }
    var intervalDays by remember { mutableStateOf((existingRepeat?.optInt("intervalDays", 2) ?: 2).coerceAtLeast(1).toString()) }
    var moveToTop by remember { mutableStateOf(existingRepeat?.optBoolean("moveToTopOnTrigger") ?: false) }
    var pickDate by remember { mutableStateOf(false) }
    var pickTime by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val dialogAction = rememberActionRunner { error = it; busy = false }
    val scheduler = app.reminders
    val today = ZonedDateTime.now(time.zone).toLocalDate()
    val is24Hour = DateFormat.is24HourFormat(activity)
    AlertDialog(onDismissRequest = { if (!busy) onClose() }, icon = { Icon(Icons.Outlined.Alarm, null) },
        title = { Text(if (existing != null) "Edit reminder" else "Remind me") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
            SectionHeader("When")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                FilterChip(time.toLocalDate() == today, { time = time.with(today) }, label = { Text("Today") })
                FilterChip(time.toLocalDate() == today.plusDays(1), { time = time.with(today.plusDays(1)) }, label = { Text("Tomorrow") })
            }
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                OutlinedButton(onClick = { pickDate = true }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = Spacing.md)) {
                    Icon(Icons.Outlined.CalendarToday, null, Modifier.size(Dimens.iconSmall)); Spacer(Modifier.width(Spacing.sm))
                    Text(time.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.getDefault())), maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                OutlinedButton(onClick = { pickTime = true }, Modifier.weight(1f), contentPadding = PaddingValues(horizontal = Spacing.md)) {
                    Icon(Icons.Outlined.Schedule, null, Modifier.size(Dimens.iconSmall)); Spacer(Modifier.width(Spacing.sm))
                    Text(time.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.getDefault())), maxLines = 1)
                }
            }
            if (repeat == "none" && time.isBefore(ZonedDateTime.now(time.zone))) StatusBanner("This time has already passed.", tone = BannerTone.Warning)
            SectionHeader("Repeat", Modifier.padding(top = Spacing.xs))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                repeatChoices.forEach { (type, label) -> FilterChip(repeat == type, { repeat = type }, label = { Text(label) }) }
            }
            if (repeat == "custom_days") OutlinedTextField(intervalDays, { value -> intervalDays = value.filter(Char::isDigit).take(3) },
                label = { Text("Interval in days") }, modifier = Modifier.fillMaxWidth(), singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
            if (repeat != "none") Row(Modifier.fillMaxWidth().heightIn(min = Dimens.minTouchTarget)
                .toggleable(moveToTop, role = Role.Switch, onValueChange = { moveToTop = it }), verticalAlignment = Alignment.CenterVertically) {
                Text("Move note to top when it fires", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                Switch(moveToTop, onCheckedChange = null)
            }
            Text((if (systemZone == ZoneId.systemDefault()) "Phone time" else "Reminder time zone") + " · $timezone",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!scheduler.notificationsAllowed()) StatusBanner("Reminder notifications are turned off.", tone = BannerTone.Warning,
                actionLabel = "Allow", onAction = activity::requestNotifications)
            if (!scheduler.precise()) StatusBanner("Without precise alarms, reminders may arrive late.", tone = BannerTone.Info,
                actionLabel = "Allow", onAction = activity::requestPreciseAlarms)
            error?.let { StatusBanner(it, tone = BannerTone.Error) }
        } },
        confirmButton = { TextButton(enabled = !busy, onClick = {
            busy = true
            error = null
            val rule = if (repeat == "none") null else JSONObject().put("type", repeat).put("moveToTopOnTrigger", moveToTop)
                .also { if (repeat == "custom_days") it.put("intervalDays", intervalDays.toIntOrNull()?.coerceIn(1, 365) ?: 1) }.toString()
            dialogAction("Could not save the reminder") { onSave(time.toInstant().toString(), timezone, rule) }
        }) { Text("Save") } },
        dismissButton = { Row {
            if (existing != null) TextButton(enabled = !busy, onClick = { busy = true; error = null; dialogAction("Could not remove the reminder") { onRemove() } },
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) { Text("Remove") }
            TextButton(onClick = onClose, enabled = !busy) { Text("Cancel") }
        } })
    if (pickDate) {
        // The picker works in UTC midnights: convert the reminder's own local date in and out, never the instant, so the
        // picked day is the day shown whatever the phone's or the reminder's zone.
        val state = rememberDatePickerState(initialSelectedDateMillis = time.toLocalDate().atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(onDismissRequest = { pickDate = false }, confirmButton = { TextButton(onClick = {
            state.selectedDateMillis?.let { millis -> time = time.with(Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()) }
            pickDate = false
        }) { Text("OK") } }, dismissButton = { TextButton(onClick = { pickDate = false }) { Text("Cancel") } }) {
            DatePicker(state)
        }
    }
    if (pickTime) TimeDialog(time.hour, time.minute, is24Hour, onDismiss = { pickTime = false }, onConfirm = { hour, minute ->
        time = time.withHour(hour).withMinute(minute)
        pickTime = false
    })
}

/**
 * Material 3's time picker in a dialog, with the usual switch between the clock dial and typed input. Typing is the default
 * where the dial would not fit: landscape phones and large font sizes.
 */
@Composable
private fun TimeDialog(hour: Int, minute: Int, is24Hour: Boolean, onDismiss: () -> Unit, onConfirm: (Int, Int) -> Unit) {
    val state = rememberTimePickerState(hour, minute, is24Hour)
    val configuration = LocalConfiguration.current
    var typing by rememberSaveable { mutableStateOf(configuration.screenHeightDp < 560 || configuration.fontScale >= 1.3f) }
    AlertDialog(onDismissRequest = onDismiss, title = { Text(if (typing) "Enter time" else "Select time") },
        text = { Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { if (typing) TimeInput(state) else TimePicker(state) } },
        confirmButton = { TextButton(onClick = { onConfirm(state.hour, state.minute) }) { Text("OK") } },
        dismissButton = { Row(verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { typing = !typing }) {
                Icon(if (typing) Icons.Outlined.Schedule else Icons.Outlined.Keyboard, if (typing) "Use the clock" else "Type the time")
            }
            TextButton(onClick = onDismiss) { Text("Cancel") }
        } })
}

/** Picks the people on this server who can edit the note. [onSave] runs here so a failure shows in the dialog. */
@Composable
internal fun ShareDialog(app: KeeparrApplication, note: Note, onClose: () -> Unit, onSave: suspend (List<Long>) -> Unit) {
    var users by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var selected by remember { mutableStateOf(note.raw.optJSONArray("collaborators")?.objects().orEmpty().map { it.getLong("id") }.toSet()) }
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    var saveError by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val dialogAction = rememberActionRunner { saveError = it; saving = false }
    LaunchedEffect(attempt) {
        loading = true
        loadError = null
        try { users = app.repository.shareUsers().filter { it.optLong("id") != app.settings.userId } }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (problem: Exception) { loadError = problem.message ?: "Connect to load collaborators" }
        finally { loading = false }
    }
    AlertDialog(onDismissRequest = { if (!saving) onClose() }, icon = { Icon(Icons.Outlined.PersonAdd, null) }, title = { Text("Collaborators") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
            Text("People on this Keeparr server can edit this note. Reminders stay personal.", style = MaterialTheme.typography.bodyMedium)
            when {
                loading -> Box(Modifier.fillMaxWidth().padding(Spacing.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                loadError != null -> StatusBanner(loadError!!, tone = BannerTone.Error, actionLabel = "Retry", onAction = { attempt++ })
                users.isEmpty() -> Text("Nobody else has an account on this server yet.", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                    users.forEach { user ->
                        val id = user.getLong("id")
                        val username = user.text("username")
                        val name = user.text("displayName", username).ifBlank { username }
                        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).clip(MaterialTheme.shapes.chip)
                            .toggleable(id in selected, role = Role.Checkbox) { selected = if (it) selected + id else selected - id }
                            .padding(horizontal = Spacing.xs), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                            Box(Modifier.size(36.dp).background(MaterialTheme.colorScheme.secondaryContainer, CircleShape), contentAlignment = Alignment.Center) {
                                Text(name.take(1).uppercase(), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
                            }
                            Column(Modifier.weight(1f)) {
                                Text(name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (username.isNotBlank() && username != name) Text(username, style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            Checkbox(id in selected, onCheckedChange = null)
                        }
                    }
                }
            }
            saveError?.let { StatusBanner(it, tone = BannerTone.Error) }
        } },
        confirmButton = { TextButton(onClick = { saving = true; saveError = null; dialogAction("Could not save collaborators") { onSave(selected.toList()) } },
            enabled = !loading && !saving && loadError == null) { Text("Save") } },
        dismissButton = { TextButton(onClick = onClose, enabled = !saving) { Text("Cancel") } })
}

/** Labels (comma separated) and the binder of a note. */
@Composable
internal fun OrganizeDialog(labels: List<String>, binder: String, onDismiss: () -> Unit, onSave: (List<String>, String) -> Unit) {
    var labelText by remember { mutableStateOf(labels.joinToString(", ")) }
    var binderText by remember { mutableStateOf(binder) }
    AlertDialog(onDismissRequest = onDismiss, icon = { Icon(Icons.AutoMirrored.Outlined.Label, null) }, title = { Text("Labels and binder") },
        text = { Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
            OutlinedTextField(labelText, { labelText = it }, label = { Text("Labels") }, supportingText = { Text("Separate labels with commas") },
                leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Label, null) }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(binderText, { binderText = it }, label = { Text("Binder") }, supportingText = { Text("Optional") },
                leadingIcon = { Icon(Icons.Outlined.Folder, null) }, modifier = Modifier.fillMaxWidth(), singleLine = true)
        } },
        confirmButton = { TextButton(onClick = {
            onSave(labelText.split(',').map { it.trim() }.filter { it.isNotEmpty() }.distinct(), binderText.trim())
        }) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } })
}

/**
 * Shown in place of a locked note until its passcode is entered: the note's own color, a back arrow, and the passcode field,
 * with a wrong passcode reported right there.
 */
@Composable
internal fun LockedNotePage(color: Color, foreground: Color, modifier: Modifier, onBack: () -> Unit, verify: suspend (String) -> Boolean,
    onUnlocked: () -> Unit) {
    var passcode by remember { mutableStateOf("") }
    var wrong by remember { mutableStateOf(false) }
    var checking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun unlock() {
        if (passcode.isEmpty() || checking) return
        checking = true
        scope.launch {
            try { if (verify(passcode)) onUnlocked() else wrong = true }
            finally { checking = false }
        }
    }
    NoteSurfaceTheme(color, foreground) {
        SystemBarsOverride(lightBackground = NotePalette.textColor(color.toArgb()) == NotePalette.TEXT_LIGHT_THEME)
        Scaffold(modifier, topBar = {
            TopAppBar(title = {}, navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "Back") } })
        }, snackbarHost = { KeeparrSnackbarHost() }) { padding ->
            Box(Modifier.fillMaxSize().padding(padding).imePadding().verticalScroll(rememberScrollState()), contentAlignment = Alignment.TopCenter) {
                Column(Modifier.widthIn(max = Dimens.formMaxWidth).fillMaxWidth().padding(Spacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Spacing.lg)) {
                    Box(Modifier.padding(top = Spacing.xl).size(72.dp).background(MaterialTheme.colorScheme.surfaceContainerHighest, CircleShape),
                        contentAlignment = Alignment.Center) { Icon(Icons.Outlined.Lock, null, Modifier.size(32.dp)) }
                    Text("This note is locked", style = MaterialTheme.typography.headlineSmall)
                    Text("Enter its passcode to open it.", style = MaterialTheme.typography.bodyMedium, color = foreground.copy(alpha = .75f))
                    PasswordField(passcode, { passcode = it; wrong = false }, "Note passcode", Modifier.fillMaxWidth(), onImeAction = ::unlock,
                        isError = wrong, supportingText = if (wrong) "Incorrect passcode. Try again." else null, enabled = !checking)
                    Button(onClick = ::unlock, enabled = passcode.isNotEmpty() && !checking, modifier = Modifier.fillMaxWidth().heightIn(min = Dimens.minTouchTarget)) {
                        Text(if (checking) "Checking…" else "Unlock")
                    }
                }
            }
        }
    }
}

internal fun verifyLock(note: Note, passcode: String): Boolean {
    val salt = note.raw.text("lockSalt"); val expected = note.raw.text("lockHash")
    val bytes = if (expected.startsWith("pbkdf2:")) javax.crypto.SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
        .generateSecret(javax.crypto.spec.PBEKeySpec(passcode.toCharArray(), salt.toByteArray(), 150000, 256)).encoded
    else java.security.MessageDigest.getInstance("SHA-256").digest("$salt:$passcode".toByteArray())
    val actual = (if (expected.startsWith("pbkdf2:")) "pbkdf2:" else "sha256:") + android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_PADDING or android.util.Base64.NO_WRAP)
    return java.security.MessageDigest.isEqual(actual.toByteArray(), expected.toByteArray())
}
