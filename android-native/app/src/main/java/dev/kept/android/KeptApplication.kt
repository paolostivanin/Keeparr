package dev.kept.android

import android.app.Application
import android.content.Context
import androidx.room.Room
import dev.kept.android.data.*
import dev.kept.android.reminders.ReminderController
import dev.kept.android.reminders.ReminderScheduler
import dev.kept.android.widgets.NotesWidget
import kotlinx.coroutines.*

class KeptApplication : Application() {
    var scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    lateinit var settings: ConnectionProfile
    lateinit var database: KeptDatabase
    lateinit var repository: KeptRepository
    lateinit var reminders: ReminderController
    var refreshWidgets: (Context) -> Unit = { NotesWidget.refresh(it) }
    var refreshWidgetScope: (Context, EffectScope) -> Unit = { context, scope -> NotesWidget.refresh(context, scope) }
    var enqueueSync: (Context) -> Unit = SyncWorker::enqueue
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
        if (settings.token.isNotEmpty()) SyncWorker.schedule(this@KeptApplication)
    }.also { recovery = it }

    override fun onCreate() {
        super.onCreate()
        settings = ConnectionSettings(this, applicationScope = scope)
        database = Room.databaseBuilder(this, KeptDatabase::class.java, "kept.sqlite").addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4).build()
        reminders = ReminderScheduler(this)
        repository = KeptRepository(this, database, settings, KeptApi(this, settings))
        scope.launch {
            settings.initialize()
            repository.restoreConnectionState()
        }
    }
}
