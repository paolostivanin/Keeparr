package dev.kept.android

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import dev.kept.android.data.ConnectionSettings
import dev.kept.android.ui.StartupGate
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

private class RecordingDataStore(private val failure: Exception? = null) : DataStore<Preferences> {
    @Volatile var readThread: Thread? = null
    override val data: Flow<Preferences> = flow {
        readThread = Thread.currentThread()
        failure?.let { throw it }
        emit(emptyPreferences())
    }
    override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences) = transform(emptyPreferences())
}

@RunWith(RobolectricTestRunner::class)
class StartupLifecycleTest {
    @Test fun storedSessionAndThemeApplyInTheFirstReadyComposition() {
        assertTrue(StartupGate.signedIn(null, "session-token"))
        assertFalse(StartupGate.signedIn(null, ""))
        assertFalse("an explicit sign-out wins over a stored token", StartupGate.signedIn(false, "session-token"))
        assertTrue("a fresh login wins before the token is read back", StartupGate.signedIn(true, ""))
        assertTrue(StartupGate.dark(null, true))
        assertFalse(StartupGate.dark(false, true))
    }

    @Test fun settingsAreReadAndDecryptedOffTheCallingThread() = runBlocking {
        val store = RecordingDataStore()
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication(), store)
        assertFalse(settings.ready.value)
        settings.initialize()
        assertTrue(settings.ready.value)
        assertNotNull(store.readThread)
        assertNotSame(Thread.currentThread(), store.readThread)
    }

    @Test fun anUnreadableSettingsStoreBecomesReadyWithAnActionableMessage() = runBlocking {
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication(), RecordingDataStore(java.io.IOException("corrupt")))
        settings.initialize()
        assertTrue("startup must not stay on the spinner", settings.ready.value)
        assertEquals("", settings.token)
        assertTrue(settings.message.contains("Sign in again"))
        assertTrue(settings.message.contains("cached notes were retained"))
    }

    @Test fun awaitReadyReturnsAfterInitialization() = runBlocking {
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication(), RecordingDataStore())
        val waiter = async { settings.awaitReady(); true }
        settings.initialize()
        assertTrue(waiter.await())
    }
}
