package dev.keeparr.android

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.preferencesOf
import androidx.datastore.preferences.core.stringPreferencesKey
import dev.keeparr.android.data.ConnectionSettings
import dev.keeparr.android.data.CredentialCipher
import dev.keeparr.android.data.CredentialRead
import dev.keeparr.android.data.ThemeMode
import dev.keeparr.android.ui.StartupGate
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
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

private class MemoryDataStore(initial: Preferences) : DataStore<Preferences> {
    val state = MutableStateFlow(initial)
    override val data: Flow<Preferences> = state
    override suspend fun updateData(transform: suspend (t: Preferences) -> Preferences) = transform(state.value).also { state.value = it }
}

/** Answers each decryption with the next scripted result (the last one repeats) and counts the attempts. */
private class ScriptedCipher(private vararg val reads: CredentialRead) : CredentialCipher {
    var attempts = 0
    override fun encrypt(value: String) = "sealed:$value"
    override fun decrypt(value: String): CredentialRead = reads[minOf(attempts++, reads.size - 1)]
}

private val tokenKey = stringPreferencesKey("token")
private val messageKey = stringPreferencesKey("message")
private val headersKey = stringPreferencesKey("headers_gateway")

@RunWith(RobolectricTestRunner::class)
class StartupLifecycleTest {
    @Test fun storedSessionAndThemeApplyInTheFirstReadyComposition() {
        assertTrue(StartupGate.signedIn(null, "session-token"))
        assertFalse(StartupGate.signedIn(null, ""))
        assertFalse("an explicit sign-out wins over a stored token", StartupGate.signedIn(false, "session-token"))
        assertTrue("a fresh login wins before the token is read back", StartupGate.signedIn(true, ""))
        assertTrue(StartupGate.dark(null, ThemeMode.Dark, false))
        assertFalse("an explicit choice wins over the stored one", StartupGate.dark(ThemeMode.Light, ThemeMode.Dark, true))
        assertTrue("System follows a dark system", StartupGate.dark(null, ThemeMode.System, true))
        assertFalse("System follows a light system", StartupGate.dark(null, ThemeMode.System, false))
        assertTrue("before the settings are read the system theme applies", StartupGate.dark(null, null, true))
        assertFalse(StartupGate.dark(null, null, false))
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

    @Test fun aSavedSignInWhoseKeyIsGoneIsDroppedOnceWithAClearMessage() = runBlocking {
        val store = MemoryDataStore(preferencesOf(tokenKey to "sealed-token", messageKey to "an older sync error"))
        val cipher = ScriptedCipher(CredentialRead.Lost)
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication(), store, cipher = cipher)
        settings.initialize()
        settings.awaitWrites()
        assertEquals("", settings.token)
        assertEquals("a lost key is not retried", 1, cipher.attempts)
        assertTrue(settings.message, settings.message.contains("can no longer be read"))
        assertNull("the unreadable token is removed so it does not fail on every start", store.state.value[tokenKey])
        assertEquals(settings.message, store.state.value[messageKey])
    }

    @Test fun aBusyKeystoreIsRetriedBeforeTheSessionIsGivenUp() = runBlocking {
        val store = MemoryDataStore(preferencesOf(tokenKey to "sealed-token"))
        val cipher = ScriptedCipher(CredentialRead.Unavailable, CredentialRead.Value("session-token"))
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication(), store, cipher = cipher)
        settings.initialize()
        assertEquals("session-token", settings.token)
        assertEquals(2, cipher.attempts)
        assertEquals("", settings.message)
    }

    @Test fun aKeystoreThatStaysDownKeepsTheSavedSessionForTheNextStart() = runBlocking {
        val store = MemoryDataStore(preferencesOf(tokenKey to "sealed-token", headersKey to "sealed-headers"))
        val cipher = ScriptedCipher(CredentialRead.Unavailable)
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication(), store, cipher = cipher)
        settings.initialize()
        settings.awaitWrites()
        assertTrue(settings.ready.value)
        assertEquals("", settings.token)
        assertEquals("the token is retried, then the headers get one attempt", 5, cipher.attempts)
        assertTrue(settings.message, settings.message.contains("reopen Keeparr"))
        assertEquals("sealed-token", store.state.value[tokenKey])
        assertEquals("sealed-headers", store.state.value[headersKey])
        assertNull("the message is not saved, so a later start that can read the token shows none", store.state.value[messageKey])
    }

    @Test fun lostGatewayHeadersAreDroppedWhileTheSessionStays() = runBlocking {
        val store = MemoryDataStore(preferencesOf(tokenKey to "sealed-token", headersKey to "sealed-headers"))
        val cipher = ScriptedCipher(CredentialRead.Value("session-token"), CredentialRead.Lost)
        val settings = ConnectionSettings(RuntimeEnvironment.getApplication(), store, cipher = cipher)
        settings.initialize()
        settings.awaitWrites()
        assertEquals("session-token", settings.token)
        assertTrue(settings.message, settings.message.contains("gateway headers"))
        assertNull(store.state.value[headersKey])
        assertEquals("sealed-token", store.state.value[tokenKey])
    }
}
