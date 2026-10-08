package dev.kept.android.data

import androidx.lifecycle.ViewModel
import androidx.room.Room
import dev.kept.android.KeptApplication
import dev.kept.android.reminders.ReminderController
import dev.kept.android.ui.EditorSessionStores
import kotlinx.coroutines.*
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class LifecycleOwnershipTest {
    private class Session : ViewModel() { var cleared = false; override fun onCleared() { cleared = true } }

    private class Profile : ConnectionProfile {
        override var origin = "https://one.example.test"
        override var alias = ""
        override var userId = 11L
        override var token = "token"
        override var headers = ""
        override var message = ""
        override var darkMode = false
        override fun aliasFor(server: String) = ""
        override fun setAliasFor(server: String, value: String) {}
        override fun headersFor(server: String) = ""
        override fun setHeadersFor(server: String, value: String) {}
        override val profile get() = "$origin#$userId"
    }

    private class CountingApi(val attempts: AtomicInteger) : NativeApi {
        // Nothing listens on port 1, so every socket attempt fails fast; the interceptor counts the attempts.
        private val http = OkHttpClient.Builder().addInterceptor { chain -> attempts.incrementAndGet(); chain.proceed(chain.request()) }.build()
        override fun client(connection: ConnectionSnapshot?) = http
        override fun request(path: String, connection: ConnectionSnapshot?): Request.Builder = Request.Builder().url("http://127.0.0.1:1$path")
        override suspend fun call(path: String, method: String, body: JSONObject?, connection: ConnectionSnapshot?) = error("unused")
        override suspend fun login(origin: String, username: String, password: String, totp: String, gatewayHeaders: String) = JSONObject()
        override suspend fun testConnection(origin: String, headers: String) = ""
    }

    private class CountingReminders : ReminderController {
        val resets = AtomicInteger()
        val reconciles = AtomicInteger()
        override fun precise() = true
        override fun notificationsAllowed() = true
        override fun now() = java.time.Instant.EPOCH
        override suspend fun reconcile() { reconciles.incrementAndGet() }
        override suspend fun resetAlarmRegistry() { resets.incrementAndGet() }
        override suspend fun deliver(key: String, occurrence: JSONObject) = Unit
        override suspend fun act(key: String, occurrence: JSONObject, state: String, snoozeUntil: String?) = false
        override fun cancelAll() = Unit
        override fun testNotification() = Unit
        override fun cancelNotification(key: String) = Unit
    }

    private lateinit var app: KeptApplication
    private lateinit var reminders: CountingReminders

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeptApplication
        app.scope.coroutineContext.cancel()
        app.database.close()
        app.scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        app.settings = Profile()
        app.database = Room.inMemoryDatabaseBuilder(app, KeptDatabase::class.java).allowMainThreadQueries().build()
        reminders = CountingReminders()
        app.reminders = reminders
        app.refreshWidgets = {}
        app.enqueueSync = {}
    }

    @After fun tearDown() {
        app.database.close()
        app.scope.coroutineContext.cancel()
    }

    @Test fun closedEditorSessionsAreReleasedIndividuallyAndReopenStartsFresh() {
        val stores = EditorSessionStores()
        val first = viewModelIn(stores, "p:a")
        val other = viewModelIn(stores, "p:b")
        assertSame("same key keeps one session across recomposition/rotation", first, viewModelIn(stores, "p:a"))
        assertEquals(2, stores.openSessions)

        stores.release("p:a")

        assertTrue(first.cleared)
        assertFalse(other.cleared)
        assertEquals(1, stores.openSessions)
        assertNotSame(first, viewModelIn(stores, "p:a"))
        stores.release("p:missing")

        stores.onCleared()
        assertTrue(other.cleared)
        assertEquals(0, stores.openSessions)
    }

    private fun viewModelIn(stores: EditorSessionStores, key: String): Session =
        androidx.lifecycle.ViewModelProvider(stores.ownerFor(key).viewModelStore, object : androidx.lifecycle.ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST") override fun <T : ViewModel> create(modelClass: Class<T>): T = Session() as T
        })[key, Session::class.java]

    @Test fun concurrentForegroundRequestsOpenExactlyOneSocket() = runBlocking {
        val attempts = AtomicInteger()
        val repository = KeptRepository(app, app.database, app.settings, CountingApi(attempts))
        (1..8).map { async(Dispatchers.Default) { repository.foreground(true) } }.awaitAll()
        delay(300)
        assertEquals(1, attempts.get())
        repository.foreground(false)
    }

    @Test fun aStopAfterStartLeavesNoSocketOrReconnectBehind() = runBlocking {
        val attempts = AtomicInteger()
        val repository = KeptRepository(app, app.database, app.settings, CountingApi(attempts))
        repository.setForeground(true)
        repository.setForeground(false)
        delay(400)
        val seen = attempts.get()
        delay(5600) // longer than the reconnect delay
        assertEquals("no reconnect after the app went to the background", seen, attempts.get())
        assertTrue(seen <= 1)
    }

    @Test fun startupRecoveryRunsOncePerProcessEvenWhenActivitiesAreRecreated() = runBlocking {
        app.repository = KeptRepository(app, app.database, app.settings, CountingApi(AtomicInteger()))
        repeat(5) { app.ensureStartupRecovery() }
        app.ensureStartupRecovery().join()
        assertEquals(1, reminders.resets.get())
        assertEquals(1, reminders.reconciles.get())
    }
}
