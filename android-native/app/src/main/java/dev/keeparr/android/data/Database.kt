package dev.keeparr.android.data

import androidx.room.*
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import kotlinx.coroutines.flow.Flow

@Entity(tableName = "records", primaryKeys = ["profile", "kind", "syncId"])
data class Record(val profile: String, val kind: String, val syncId: String, val payload: String)

object OutboxState {
    const val QUEUED = "queued"
    const val IN_FLIGHT = "in_flight"
    const val CONFLICT = "conflict"
}

@Entity(tableName = "outbox", indices = [
    Index(value = ["profile", "createdAt"], name = "index_outbox_profile_createdAt"),
    Index(value = ["profile", "state", "createdAt"], name = "index_outbox_profile_state_createdAt"),
    Index(value = ["profile", "dependsOnOperationId"], name = "index_outbox_profile_dependsOnOperationId")
])
data class Outbox(@PrimaryKey val operationId: String, val profile: String, val type: String, val syncId: String,
    val payload: String, val baseRevision: Long? = null, val baseScheduleVersion: Long? = null, val conflict: String? = null,
    val state: String = OutboxState.QUEUED, val dependsOnOperationId: String? = null, val createdAt: Long = System.currentTimeMillis(),
    // Once sent, the server may hold a receipt for this operationId, so later edits must chain instead of rewriting it.
    @ColumnInfo(defaultValue = "0") val attempted: Boolean = false)

@Entity(tableName = "sync_state")
data class SyncState(@PrimaryKey val profile: String, val cursor: Long)

@Entity(tableName = "delivery", primaryKeys = ["profile", "occurrenceId"])
data class Delivery(val profile: String, val occurrenceId: String, val deliveredAt: Long)

@Dao
interface Store {
    @Query("SELECT * FROM records WHERE profile = :profile AND kind = :kind") fun observe(profile: String, kind: String): Flow<List<Record>>
    @Query("SELECT * FROM records WHERE profile = :profile AND kind = :kind") suspend fun list(profile: String, kind: String): List<Record>
    @Query("SELECT * FROM records WHERE profile = :profile AND kind = :kind AND syncId = :id") suspend fun record(profile: String, kind: String, id: String): Record?
    @Query("SELECT * FROM records WHERE profile = :profile AND kind = :kind AND syncId = :id") fun observeRecord(profile: String, kind: String, id: String): Flow<Record?>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun put(record: Record)
    @Query("DELETE FROM records WHERE profile = :profile AND kind = :kind AND syncId = :id") suspend fun remove(profile: String, kind: String, id: String)
    @Query("SELECT * FROM outbox WHERE profile = :profile ORDER BY createdAt, operationId") suspend fun pending(profile: String): List<Outbox>
    @Query("SELECT * FROM outbox WHERE profile = :profile AND state = 'queued' AND conflict IS NULL AND dependsOnOperationId IS NULL ORDER BY createdAt, operationId LIMIT 1") suspend fun nextSendable(profile: String): Outbox?
    @Query("SELECT * FROM outbox WHERE profile = :profile AND type = :type AND syncId = :syncId AND state = 'queued' ORDER BY createdAt DESC LIMIT 1") suspend fun queued(profile: String, type: String, syncId: String): Outbox?
    @Query("SELECT * FROM outbox WHERE profile = :profile AND type = :type AND syncId = :syncId AND state = 'in_flight' ORDER BY createdAt DESC LIMIT 1") suspend fun inFlight(profile: String, type: String, syncId: String): Outbox?
    @Query("SELECT * FROM outbox WHERE profile = :profile AND type = :type AND syncId = :syncId AND conflict IS NOT NULL ORDER BY createdAt DESC LIMIT 1") suspend fun conflicted(profile: String, type: String, syncId: String): Outbox?
    @Query("SELECT * FROM outbox WHERE profile = :profile AND dependsOnOperationId = :operationId") suspend fun dependents(profile: String, operationId: String): List<Outbox>
    @Query("SELECT * FROM outbox WHERE profile = :profile AND state = 'queued' AND conflict IS NULL AND dependsOnOperationId IS NOT NULL AND dependsOnOperationId NOT IN (SELECT operationId FROM outbox)") suspend fun orphaned(profile: String): List<Outbox>
    @Query("SELECT * FROM outbox WHERE profile = :profile AND conflict IS NOT NULL") fun conflicts(profile: String): Flow<List<Outbox>>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun enqueue(entry: Outbox)
    @Query("UPDATE outbox SET state = 'in_flight', attempted = 1 WHERE operationId = :id AND state = 'queued' AND conflict IS NULL") suspend fun markInFlight(id: String): Int
    @Query("UPDATE outbox SET state = 'queued' WHERE operationId = :id AND state = 'in_flight'") suspend fun requeue(id: String)
    @Query("UPDATE outbox SET state = 'queued' WHERE profile = :profile AND state = 'in_flight'") suspend fun requeueInFlight(profile: String)
    @Query("UPDATE outbox SET dependsOnOperationId = NULL, state = 'queued', baseRevision = CASE WHEN type = 'note.upsert' AND :revision IS NOT NULL THEN :revision ELSE baseRevision END, baseScheduleVersion = CASE WHEN type = 'reminder.upsert' AND :scheduleVersion IS NOT NULL THEN :scheduleVersion ELSE baseScheduleVersion END WHERE profile = :profile AND dependsOnOperationId = :operationId") suspend fun unblockDependents(profile: String, operationId: String, revision: Long?, scheduleVersion: Long?)
    @Query("UPDATE outbox SET state = 'conflict', conflict = :conflict WHERE profile = :profile AND dependsOnOperationId = :operationId") suspend fun conflictDependents(profile: String, operationId: String, conflict: String)
    @Query("DELETE FROM outbox WHERE operationId = :id") suspend fun acknowledge(id: String)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun cursor(state: SyncState)
    @Query("SELECT * FROM sync_state WHERE profile = :profile") suspend fun cursor(profile: String): SyncState?
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun delivered(delivery: Delivery): Long
    @Query("SELECT COUNT(*) FROM delivery WHERE profile = :profile AND occurrenceId = :id") suspend fun wasDelivered(profile: String, id: String): Int
    @Query("SELECT occurrenceId FROM delivery WHERE profile = :profile") suspend fun deliveredKeys(profile: String): List<String>
    @Query("DELETE FROM records WHERE profile = :profile") suspend fun clearRecords(profile: String)
    @Query("DELETE FROM outbox WHERE profile = :profile") suspend fun clearOutbox(profile: String)
    @Query("DELETE FROM delivery WHERE profile = :profile") suspend fun clearDelivery(profile: String)
    @Query("DELETE FROM sync_state WHERE profile = :profile") suspend fun clearCursor(profile: String)
}

val MIGRATION_1_2 = object : Migration(1, 2) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL("""CREATE TABLE outbox_native_migration (
            operationId TEXT NOT NULL,
            profile TEXT NOT NULL,
            type TEXT NOT NULL,
            syncId TEXT NOT NULL,
            payload TEXT NOT NULL,
            baseRevision INTEGER,
            baseScheduleVersion INTEGER,
            conflict TEXT,
            state TEXT NOT NULL,
            dependsOnOperationId TEXT,
            createdAt INTEGER NOT NULL,
            PRIMARY KEY(operationId))""")
        database.execSQL("""INSERT INTO outbox_native_migration
            (operationId, profile, type, syncId, payload, baseRevision, baseScheduleVersion, conflict, state, dependsOnOperationId, createdAt)
            SELECT operationId, profile, type, syncId, payload, baseRevision, baseScheduleVersion, conflict,
              CASE WHEN conflict IS NULL THEN 'queued' ELSE 'conflict' END, NULL, rowid
            FROM outbox""")
        database.execSQL("DROP TABLE outbox")
        database.execSQL("ALTER TABLE outbox_native_migration RENAME TO outbox")
        database.execSQL("CREATE INDEX index_outbox_profile_createdAt ON outbox(profile, createdAt)")
        database.execSQL("CREATE INDEX index_outbox_profile_state_createdAt ON outbox(profile, state, createdAt)")
        database.execSQL("CREATE INDEX index_outbox_profile_dependsOnOperationId ON outbox(profile, dependsOnOperationId)")
    }
}

val MIGRATION_2_3 = object : Migration(2, 3) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL("""CREATE TABLE outbox_native_migration (
            operationId TEXT NOT NULL,
            profile TEXT NOT NULL,
            type TEXT NOT NULL,
            syncId TEXT NOT NULL,
            payload TEXT NOT NULL,
            baseRevision INTEGER,
            baseScheduleVersion INTEGER,
            conflict TEXT,
            state TEXT NOT NULL,
            dependsOnOperationId TEXT,
            createdAt INTEGER NOT NULL,
            PRIMARY KEY(operationId))""")
        database.execSQL("""INSERT INTO outbox_native_migration
            (operationId, profile, type, syncId, payload, baseRevision, baseScheduleVersion, conflict, state, dependsOnOperationId, createdAt)
            SELECT operationId, profile, type, syncId, payload, baseRevision, baseScheduleVersion, conflict,
              state, dependsOnOperationId, createdAt FROM outbox""")
        database.execSQL("DROP TABLE outbox")
        database.execSQL("ALTER TABLE outbox_native_migration RENAME TO outbox")
        database.execSQL("CREATE INDEX index_outbox_profile_createdAt ON outbox(profile, createdAt)")
        database.execSQL("CREATE INDEX index_outbox_profile_state_createdAt ON outbox(profile, state, createdAt)")
        database.execSQL("CREATE INDEX index_outbox_profile_dependsOnOperationId ON outbox(profile, dependsOnOperationId)")
    }
}

val MIGRATION_3_4 = object : Migration(3, 4) {
    override fun migrate(database: SupportSQLiteDatabase) {
        database.execSQL("ALTER TABLE outbox ADD COLUMN attempted INTEGER NOT NULL DEFAULT 0")
    }
}

@Database(entities = [Record::class, Outbox::class, SyncState::class, Delivery::class], version = 4, exportSchema = true)
abstract class KeeparrDatabase : RoomDatabase() { abstract fun store(): Store }
