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
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    lateinit var settings: ConnectionProfile
    lateinit var database: KeptDatabase
    lateinit var repository: KeptRepository
    lateinit var reminders: ReminderController
    var refreshWidgets: (Context) -> Unit = NotesWidget::refresh
    var enqueueSync: (Context) -> Unit = SyncWorker::enqueue
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
