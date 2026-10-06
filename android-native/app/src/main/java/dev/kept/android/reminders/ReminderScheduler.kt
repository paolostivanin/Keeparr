package dev.kept.android.reminders

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.kept.android.KeptApplication
import dev.kept.android.MainActivity
import dev.kept.android.R
import dev.kept.android.data.*
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.time.Clock
import java.time.Instant

interface ReminderAlarmScheduler {
    fun canScheduleExactAlarms(): Boolean
    fun scheduleExact(atMillis: Long, pendingIntent: PendingIntent)
    fun scheduleInexact(atMillis: Long, pendingIntent: PendingIntent)
    fun cancel(pendingIntent: PendingIntent)
}

interface ReminderNotificationSink {
    fun notificationsAllowed(): Boolean
    fun ensureChannel()
    fun showTestNotification()
    suspend fun show(occurrence: JSONObject, key: String, note: Note?): Boolean
    suspend fun showCatchUpSummary(key: String, count: Int, firstDueAtUtc: String, lastDueAtUtc: String, note: Note?): Boolean
    fun cancel(key: String)
    fun cancelAll()
}

interface ReminderController {
    fun precise(): Boolean
    fun notificationsAllowed(): Boolean
    fun now(): Instant
    suspend fun reconcile()
    suspend fun resetAlarmRegistry()
    suspend fun deliver(key: String, occurrence: JSONObject)
    suspend fun act(key: String, occurrence: JSONObject, state: String, snoozeUntil: String?): Boolean
    fun cancelAll()
    fun testNotification()
    fun cancelNotification(key: String)
}

private class AndroidReminderAlarmScheduler(context: Context) : ReminderAlarmScheduler {
    private val alarmManager = context.getSystemService(AlarmManager::class.java)
    override fun canScheduleExactAlarms() = alarmManager.canScheduleExactAlarms()
    override fun scheduleExact(atMillis: Long, pendingIntent: PendingIntent) =
        alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pendingIntent)
    override fun scheduleInexact(atMillis: Long, pendingIntent: PendingIntent) =
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pendingIntent)
    override fun cancel(pendingIntent: PendingIntent) = alarmManager.cancel(pendingIntent)
}

private class AndroidReminderNotificationSink(private val app: KeptApplication) : ReminderNotificationSink {
    override fun notificationsAllowed(): Boolean {
        if (!NotificationManagerCompat.from(app).areNotificationsEnabled()) return false
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return false
        if (app.getSystemService(NotificationManager::class.java)
                .getNotificationChannel("kept_time_reminders")?.importance == NotificationManager.IMPORTANCE_NONE) return false
        return true
    }

    override fun ensureChannel() {
        app.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("kept_time_reminders", "Time reminders", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Notifications for scheduled note reminders"; enableVibration(true)
            })
    }

    override fun showTestNotification() {
        ensureChannel()
        if (!notificationsAllowed()) return
        val intent = PendingIntent.getActivity(app, 0, Intent(app, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        NotificationManagerCompat.from(app).notify("test", 0, NotificationCompat.Builder(app, "kept_time_reminders")
            .setSmallIcon(R.drawable.ic_kept).setContentTitle("Kept reminders are ready")
            .setContentText("Your Android notification channel is working.").setContentIntent(intent).setAutoCancel(true).build())
    }

    override suspend fun show(occurrence: JSONObject, key: String, note: Note?): Boolean {
        ensureChannel()
        if (!notificationsAllowed()) return false
        val open = Intent(app, MainActivity::class.java).setData(Uri.parse("keptnative://note/${Uri.encode(key)}"))
            .putExtra("noteSyncId", note?.syncId)
        val content = PendingIntent.getActivity(app, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        fun action(state: String): PendingIntent = PendingIntent.getBroadcast(app, 0,
            Intent(app, ReminderReceiver::class.java).setAction(state).setData(Uri.parse("keptnative://action/$state/${Uri.encode(key)}"))
                .putExtra("profile", app.settings.profile).putExtra("occurrence", occurrence.toString()).putExtra("alarmKey", key),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title = if (note?.locked == true) "Kept reminder" else note?.title?.ifBlank { null } ?: occurrence.text("title", "Kept reminder")
        val body = if (note?.locked == true) "Open Kept to view this note" else occurrence.text("body")
        val notification = NotificationCompat.Builder(app, "kept_time_reminders").setSmallIcon(R.drawable.ic_kept)
            .setContentTitle(title).setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(content).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .addAction(0, "Snooze 10 min", action("snoozed")).addAction(0, "Dismiss", action("dismissed")).build()
        NotificationManagerCompat.from(app).notify(key, 0, notification)
        return true
    }

    override suspend fun showCatchUpSummary(key: String, count: Int, firstDueAtUtc: String, lastDueAtUtc: String, note: Note?): Boolean {
        ensureChannel()
        if (!notificationsAllowed()) return false
        val open = Intent(app, MainActivity::class.java).setData(Uri.parse("keptnative://note/${Uri.encode(key)}"))
            .putExtra("noteSyncId", note?.syncId)
        val content = PendingIntent.getActivity(app, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val title = if (note?.locked == true) "Kept reminder" else note?.title?.ifBlank { null } ?: "Kept reminders"
        val body = if (note?.locked == true) "$count older reminders were missed. Open Kept to view this note."
            else "$count older reminders were missed ($firstDueAtUtc – $lastDueAtUtc)."
        val notification = NotificationCompat.Builder(app, "kept_time_reminders").setSmallIcon(R.drawable.ic_kept)
            .setContentTitle(title).setContentText(body).setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setContentIntent(content).setAutoCancel(true).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build()
        NotificationManagerCompat.from(app).notify(key, 0, notification)
        return true
    }

    override fun cancel(key: String) = NotificationManagerCompat.from(app).cancel(key, 0)
    override fun cancelAll() = NotificationManagerCompat.from(app).cancelAll()
}

class ReminderScheduler(
    private val app: KeptApplication,
    private val clock: Clock = Clock.systemDefaultZone(),
    private val alarms: ReminderAlarmScheduler = AndroidReminderAlarmScheduler(app),
    private val notifications: ReminderNotificationSink = AndroidReminderNotificationSink(app)
) : ReminderController {
    private val alarmMutationLock = Any()
    private val registry = app.getSharedPreferences("scheduled_alarms", Context.MODE_PRIVATE)
    private val summaryRegistry = app.getSharedPreferences("reminder_catchup_summaries", Context.MODE_PRIVATE)
    private val store = app.database.store()
    override fun precise(): Boolean = alarms.canScheduleExactAlarms()
    override fun notificationsAllowed(): Boolean = notifications.notificationsAllowed()
    override fun now(): Instant = Instant.now(clock)

    override suspend fun resetAlarmRegistry() = lock.withLock {
        synchronized(alarmMutationLock) {
            for ((key, value) in registry.all) if (value is String) {
                runCatching { alarms.cancel(pending(key, JSONObject(value))) }
            }
            registry.edit().clear().commit()
        }
        Unit
    }

    private fun pending(key: String, raw: JSONObject): PendingIntent {
        val intent = Intent(app, ReminderReceiver::class.java).setAction("dev.kept.android.REMIND")
            .setData(Uri.parse("keptnative://reminder/${Uri.encode(key)}"))
            .putExtra("profile", app.settings.profile).putExtra("occurrence", raw.toString()).putExtra("alarmKey", key)
        return PendingIntent.getBroadcast(app, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    override suspend fun reconcile() = lock.withLock {
        notifications.ensureChannel()
        if (app.settings.token.isBlank()) { cancelAll(); return@withLock }
        if (!notificationsAllowed()) { cancelAll(); return@withLock }
        val profile = app.settings.profile
        val notes = store.list(profile, "note").map { Note(JSONObject(it.payload)) }
        val reminders = store.list(profile, "reminder").map { JSONObject(it.payload) }
        val valid = reminders.filter { reminder ->
            reminder.text("status") != "dismissed" && (reminder.optLong("noteId") == 0L || notes.any { note ->
                (note.id == reminder.optLong("noteId") || note.syncId == reminder.text("noteSyncId")) && !note.archived && !note.trashed
            })
        }
        for ((key, value) in summaryRegistry.all) {
            val summary = (value as? String)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: continue
            val stillCurrent = valid.any { it.text("syncId") == summary.text("syncId") &&
                it.optLong("scheduleVersion", 1) == summary.optLong("scheduleVersion", 1) }
            if (!stillCurrent) {
                notifications.cancel(key)
                summaryRegistry.edit().remove(key).apply()
            }
        }
        val wanted = linkedMapOf<String, JSONObject>()
        val now = now()
        val deliveredKeys = store.deliveredKeys(profile).toSet()
        for (reminder in valid.filter { it.text("status") == "pending" && it.text("dueAtUtc").isNotEmpty() }) {
            val plan = ReminderPlanner.plan(reminder, now, profile, deliveredKeys)
            for (occurrence in plan.overdue) {
                val deliveryKey = deliveryKey(occurrence, profile)
                wanted[deliveryKey] = occurrence
            }
            plan.next?.let { occurrence ->
                val deliveryKey = deliveryKey(occurrence, profile)
                if (deliveryKey !in deliveredKeys) wanted[deliveryKey] = occurrence
            }
            plan.expired?.let { window ->
                val summaryKey = ReminderPlanner.catchUpSummaryKey(profile, reminder.text("syncId"),
                    reminder.optLong("scheduleVersion", 1), window)
                if (summaryKey !in deliveredKeys) {
                    val note = notes.find { it.id == reminder.optLong("noteId") || it.syncId == reminder.text("noteSyncId") }
                    try {
                        if (!notifications.showCatchUpSummary(summaryKey, window.count, window.firstDueAtUtc, window.lastDueAtUtc, note)) {
                            cancelAll()
                            return@withLock
                        }
                        if (app.settings.profile != profile || app.settings.token.isBlank()) {
                            notifications.cancel(summaryKey)
                            return@withLock
                        }
                        store.delivered(Delivery(profile, summaryKey, clock.millis()))
                        synchronized(alarmMutationLock) {
                            if (app.settings.profile == profile && app.settings.token.isNotBlank()) {
                                summaryRegistry.edit().putString(summaryKey, JSONObject().put("syncId", reminder.text("syncId"))
                                    .put("scheduleVersion", reminder.optLong("scheduleVersion", 1)).toString()).apply()
                            } else notifications.cancel(summaryKey)
                        }
                    } catch (_: SecurityException) {
                        cancelAll()
                        return@withLock
                    }
                }
            }
        }
        for (row in store.list(profile, "occurrence")) {
            val raw = JSONObject(row.payload)
            if (valid.none { it.text("syncId") == raw.text("syncId") }) continue
            val key = deliveryKey(raw, profile)
            when (raw.text("state")) {
                "dismissed" -> wanted.remove(key)
                "snoozed" -> {
                    wanted.remove(key)
                    val snooze = raw.text("snoozeUntil")
                    val snoozeKey = "$key/snooze/$snooze"
                    val snoozeAt = runCatching { Instant.parse(snooze) }.getOrNull()
                    if (snoozeAt != null && snoozeAt.isAfter(now) && snoozeKey !in deliveredKeys) wanted[snoozeKey] = raw.copyJson().put("alarmTime", snooze)
                    else if (snooze.isNotEmpty() && snoozeKey !in deliveredKeys) {
                        store.delivered(Delivery(profile, snoozeKey, clock.millis()))
                    }
                }
                else -> if (key !in deliveredKeys) wanted[key] = raw
            }
        }
        synchronized(alarmMutationLock) {
            if (app.settings.profile != profile || app.settings.token.isBlank()) {
                cancelAllLocked()
                return@withLock
            }
            for (key in registry.all.keys.filter { it !in wanted }) {
                registry.getString(key, null)?.let { alarms.cancel(pending(key, JSONObject(it))) }
                notifications.cancel(key)
                registry.edit().remove(key).apply()
            }
            for ((key, raw) in wanted) {
                if (key in deliveredKeys) continue
                val value = raw.toString()
                if (registry.getString(key, null) == value) continue
                val time = maxOf(clock.millis() + 500, Instant.parse(raw.text("alarmTime", raw.getString("dueAtUtc"))).toEpochMilli())
                val intent = pending(key, raw)
                if (precise()) {
                    try { alarms.scheduleExact(time, intent) }
                    catch (_: SecurityException) { alarms.scheduleInexact(time, intent) }
                } else alarms.scheduleInexact(time, intent)
                registry.edit().putString(key, value).apply()
            }
        }
    }

    override fun cancelAll() = synchronized(alarmMutationLock) { cancelAllLocked() }

    private fun cancelAllLocked() {
        for ((key, value) in registry.all) if (value is String) alarms.cancel(pending(key, JSONObject(value)))
        registry.edit().clear().commit()
        summaryRegistry.all.keys.forEach(notifications::cancel)
        summaryRegistry.edit().clear().commit()
        notifications.cancelAll()
    }

    override suspend fun deliver(key: String, raw: JSONObject) = lock.withLock {
        // An alarm canceled by an edit can already be queued for dispatch.
        if (registry.getString(key, null) != raw.toString()) return@withLock
        val profile = app.settings.profile
        val reminder = store.record(profile, "reminder", raw.text("syncId"))?.let { JSONObject(it.payload) }
        val notes = store.list(profile, "note").map { Note(JSONObject(it.payload)) }
        val linkedNoteActive = reminder != null && (reminder.optLong("noteId") == 0L || notes.any { note ->
            (note.id == reminder.optLong("noteId") || note.syncId == reminder.text("noteSyncId")) && !note.archived && !note.trashed
        })
        val matchingDefinition = reminder != null && linkedNoteActive && reminder.text("status") != "dismissed" &&
            reminder.optLong("scheduleVersion", 1) == raw.optLong("scheduleVersion", 1) &&
            Recurrence.isOccurrence(reminder.text("scheduleAnchorAtUtc", reminder.text("dueAtUtc")), raw.text("dueAtUtc"),
                reminder.text("timezone", "UTC"), reminder.text("repeatRule"))
        val syncedOccurrence = store.record(profile, "occurrence", raw.text("occurrenceId"))?.let { row ->
            val occurrence = JSONObject(row.payload)
            linkedNoteActive && reminder?.text("status") != "dismissed" &&
                reminder?.optLong("scheduleVersion", 1) == raw.optLong("scheduleVersion", 1) &&
                occurrence.optLong("scheduleVersion", 1) == raw.optLong("scheduleVersion", 1)
        } == true
        val localOccurrence = store.record(profile, "occurrence", raw.text("occurrenceId"))?.let { JSONObject(it.payload) }
        val snoozeDelivery = localOccurrence?.text("state") == "snoozed" && key.endsWith("/snooze/${localOccurrence.text("snoozeUntil")}")
        val actionStillValid = localOccurrence?.text("state") != "dismissed" &&
            (localOccurrence?.text("state") != "snoozed" || snoozeDelivery)
        if ((!matchingDefinition && !syncedOccurrence) || !linkedNoteActive || !actionStillValid) {
            registry.edit().remove(key).commit()
            alarms.cancel(pending(key, raw))
            return@withLock
        }
        registry.edit().remove(key).commit()
        if (app.settings.profile != profile || app.settings.token.isBlank()) return@withLock
        if (!notificationsAllowed()) return@withLock
        if (store.wasDelivered(profile, key) > 0) return@withLock
        val note = store.list(profile, "note").map { Note(JSONObject(it.payload)) }
            .find { it.id == raw.optLong("noteId") || it.syncId == raw.text("noteSyncId") }
        val posted = try { notifications.show(raw, key, note) }
        catch (_: SecurityException) { cancelAll(); return@withLock }
        if (!posted) { cancelAll(); return@withLock }
        store.delivered(Delivery(profile, key, clock.millis()))
    }

    override suspend fun act(key: String, occurrence: JSONObject, state: String, snoozeUntil: String?): Boolean = lock.withLock {
        if (state !in setOf("dismissed", "snoozed")) return@withLock false
        val profile = app.settings.profile
        val reminder = store.record(profile, "reminder", occurrence.text("syncId"))?.let { JSONObject(it.payload) }
            ?: return@withLock false
        val dueAt = occurrence.text("dueAtUtc")
        val occurrenceKey = deliveryKey(occurrence, profile)
        val noteId = reminder.optLong("noteId")
        val notes = store.list(profile, "note").map { Note(JSONObject(it.payload)) }
        val linkedNoteActive = noteId == 0L || notes.any { note ->
            (note.id == noteId || note.syncId == reminder.text("noteSyncId")) && !note.archived && !note.trashed
        }
        val currentDefinition = reminder.text("status") != "dismissed" && linkedNoteActive &&
            reminder.optLong("scheduleVersion", 1) == occurrence.optLong("scheduleVersion", 1) &&
            occurrence.text("occurrenceId") == Recurrence.occurrenceId(reminder.text("syncId"), dueAt, reminder.optLong("scheduleVersion", 1)) &&
            Recurrence.isOccurrence(reminder.text("scheduleAnchorAtUtc", reminder.text("dueAtUtc")), dueAt,
                reminder.text("timezone", "UTC"), reminder.text("repeatRule")) && store.wasDelivered(profile, occurrenceKey) > 0
        if (!currentDefinition) return@withLock false
        if (app.settings.profile != profile || app.settings.token.isBlank()) return@withLock false
        if (state == "snoozed" && runCatching { Instant.parse(snoozeUntil) }.getOrNull() == null) return@withLock false
        app.repository.occurrenceAction(occurrence, state, snoozeUntil)
        true
    }

    override fun testNotification() = notifications.showTestNotification()
    override fun cancelNotification(key: String) = notifications.cancel(key)

    companion object {
        private val lock = Mutex()
    }
}

private fun deliveryKey(occurrence: JSONObject, profile: String): String {
    return ReminderPlanner.deliveryKey(occurrence, profile)
}

class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val app = context.applicationContext as KeptApplication
        val raw = runCatching { JSONObject(intent.getStringExtra("occurrence")!!) }.getOrNull() ?: return
        val key = intent.getStringExtra("alarmKey") ?: return
        val result = goAsync()
        app.scope.launch {
            try {
                app.settings.awaitReady()
                if (intent.getStringExtra("profile") != app.settings.profile || app.settings.token.isEmpty()) return@launch
                val scheduler = app.reminders
                if (intent.action == "dev.kept.android.REMIND") scheduler.deliver(key, raw)
                else if (intent.action in setOf("dismissed", "snoozed")) {
                    scheduler.act(key, raw, intent.action!!,
                        if (intent.action == "snoozed") scheduler.now().plusSeconds(600).toString() else null)
                    scheduler.cancelNotification(key)
                }
                scheduler.reconcile()
            } finally { result.finish() }
        }
    }
}

class ReminderLifecycleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_USER_UNLOCKED, Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIME_CHANGED,
                Intent.ACTION_TIMEZONE_CHANGED, AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED)) return
        val app = context.applicationContext as KeptApplication
        val result = goAsync()
        app.scope.launch {
            try {
                app.settings.awaitReady()
                // Reboot loses platform alarms; force regeneration from persisted data.
                app.reminders.resetAlarmRegistry()
                app.repository.reconcile()
                if (app.settings.token.isNotEmpty()) SyncWorker.schedule(context)
            } finally { result.finish() }
        }
    }
}
