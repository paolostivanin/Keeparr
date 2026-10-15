package dev.keeparr.android

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.widget.Toast
import androidx.room.Room
import dev.keeparr.android.data.*
import dev.keeparr.android.reminders.ReminderController
import dev.keeparr.android.reminders.ReminderScheduler
import dev.keeparr.android.widgets.NotesWidget
import dev.keeparr.android.widgets.WidgetRefresh
import kotlinx.coroutines.*

class KeeparrApplication : Application() {
    var scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    lateinit var settings: ConnectionProfile
    lateinit var database: KeeparrDatabase
    lateinit var repository: KeeparrRepository
    lateinit var reminders: ReminderController
    var refreshWidgets: (Context) -> Unit = { NotesWidget.refresh(it) }
    var refreshWidgetScope: (Context, EffectScope) -> Unit = { context, scope -> NotesWidget.refresh(context, scope) }
    var refreshWidgetStatus: (Context) -> Unit = { NotesWidget.refreshStatus(it) }
    var enqueueSync: (Context) -> Unit = SyncWorker::enqueue
    var scheduleSync: (Context) -> Unit = SyncWorker::schedule
    /** The sync a tap on the widget status runs, here and now (see [WidgetRefresh]). */
    var syncNow: suspend () -> Unit = { repository.sync() }
    /** A Toast needs a Looper, which the threads that report results do not have, so it is posted to the main one. */
    var showToast: (String) -> Unit = { text -> Handler(Looper.getMainLooper()).post { Toast.makeText(this, text, Toast.LENGTH_SHORT).show() } }
    internal val widgetRefresh = WidgetRefresh()
    private var recovery: Job? = null
    /** Set when the visible activity is being recreated, so the next start does not repeat foreground work. */
    @Volatile var recreatingForConfiguration = false

    /**
     * Process-wide startup recovery (alarm registry rebuild, reminder/widget reconciliation, sync scheduling). It runs
     * once per process: activity re-creation (rotation, theme, locale) must not re-run it or re-register alarms.
     */
    @Synchronized fun ensureStartupRecovery(): Job = recovery ?: scope.launch {
        settings.awaitReady()
        reminders.resetAlarmRegistry()
        repository.reconcile()
        if (settings.token.isNotEmpty()) SyncWorker.schedule(this@KeeparrApplication)
    }.also { recovery = it }

    override fun onCreate() {
        super.onCreate()
        settings = ConnectionSettings(this, applicationScope = scope)
        database = Room.databaseBuilder(this, KeeparrDatabase::class.java, "keeparr.sqlite").addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4, MIGRATION_4_5).build()
        reminders = ReminderScheduler(this)
        repository = KeeparrRepository(this, database, settings, KeeparrApi(this, settings))
        scope.launch {
            settings.initialize()
            repository.restoreConnectionState()
        }
    }
}
