package dev.kept.android.data

import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.sqlite.db.SupportSQLiteOpenHelper
import androidx.sqlite.db.framework.FrameworkSQLiteOpenHelperFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class DatabaseMigrationTest {
    @Test fun v1OutboxRowsSurviveMigrationAndCanRepresentSuccessorOperations() {
        val context = RuntimeEnvironment.getApplication()
        val configuration = SupportSQLiteOpenHelper.Configuration.builder(context)
            .name(null)
            .callback(object : SupportSQLiteOpenHelper.Callback(1) {
                override fun onCreate(database: SupportSQLiteDatabase) {
                    database.execSQL("""CREATE TABLE outbox (
                        operationId TEXT NOT NULL, profile TEXT NOT NULL, type TEXT NOT NULL, syncId TEXT NOT NULL,
                        payload TEXT NOT NULL, baseRevision INTEGER, baseScheduleVersion INTEGER, conflict TEXT,
                        PRIMARY KEY(operationId))""")
                    database.execSQL("CREATE UNIQUE INDEX index_outbox_profile_type_syncId ON outbox(profile, type, syncId)")
                }
                override fun onUpgrade(database: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
            }).build()
        val helper = FrameworkSQLiteOpenHelperFactory().create(configuration)
        val database = helper.writableDatabase
        try {
            database.execSQL("INSERT INTO outbox VALUES ('op-one', 'profile', 'note.upsert', 'note', 'first', 4, NULL, NULL)")
            database.execSQL("INSERT INTO outbox VALUES ('op-two', 'profile', 'note.upsert', 'note-two', 'successor', 4, NULL, NULL)")
            database.execSQL("INSERT INTO outbox VALUES ('op-conflict', 'profile', 'note.upsert', 'other-note', 'draft', 2, NULL, '{\"status\":409}')")

            MIGRATION_1_2.migrate(database)
            MIGRATION_2_3.migrate(database)

            database.query("SELECT operationId, payload, state, createdAt FROM outbox ORDER BY operationId").use { cursor ->
                assertEquals(3, cursor.count)
                cursor.moveToFirst()
                assertEquals("op-conflict", cursor.getString(0))
                assertEquals("conflict", cursor.getString(2))
                assertTrue(cursor.getLong(3) > 0)
            }
            database.execSQL("INSERT INTO outbox(operationId, profile, type, syncId, payload, state, createdAt) VALUES ('op-three', 'profile', 'note.upsert', 'note', 'third', 'queued', 99)")
            database.execSQL("INSERT INTO outbox(operationId, profile, type, syncId, payload, state, createdAt) VALUES ('op-four', 'profile', 'note.upsert', 'note', 'fourth', 'queued', 100)")
            database.query("SELECT COUNT(*) FROM outbox WHERE profile = 'profile' AND type = 'note.upsert' AND syncId = 'note'").use { cursor ->
                cursor.moveToFirst()
                assertEquals(3, cursor.getInt(0))
            }
        } finally { helper.close() }
    }
}
