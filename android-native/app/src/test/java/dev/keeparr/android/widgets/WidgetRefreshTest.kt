package dev.keeparr.android.widgets

import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.data.*
import kotlinx.coroutines.*
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class WidgetRefreshTest {
    private class Profile : ConnectionProfile {
        var readyAfterMs = 0L
        var writesNeverFinish = false
        override var userId = 11L
        override var origin = "https://one.example.test"
        override var alias = ""
        override var token = "token"
        override var headers = ""
        override var message = ""
        override var themeMode = ThemeMode.System
        override suspend fun awaitReady() = delay(readyAfterMs)
        override suspend fun awaitWrites() { if (writesNeverFinish) awaitCancellation() }
        override fun aliasFor(server: String) = ""
        override fun setAliasFor(server: String, value: String) {}
        override fun headersFor(server: String) = ""
        override fun setHeadersFor(server: String, value: String) {}
        override val profile get() = "$origin#$userId"
    }

    private lateinit var app: KeeparrApplication
    private lateinit var profile: Profile
    private val toasts = CopyOnWriteArrayList<String>()
    private val reloads = CopyOnWriteArrayList<EffectScope>()
    private val statusRedraws = AtomicInteger()
    private val queued = AtomicInteger()

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeeparrApplication
        app.scope.coroutineContext.cancel()
        app.scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        profile = Profile()
        app.settings = profile
        app.refreshWidgetStatus = { statusRedraws.incrementAndGet() }
        app.refreshWidgetScope = { _, scope -> reloads += scope }
        app.enqueueSync = { queued.incrementAndGet() }
        app.showToast = { toasts += it }
    }

    @After fun tearDown() {
        app.scope.coroutineContext.cancel()
    }

    private fun tap(budgetMs: Long = 2_000) = runBlocking { app.widgetRefresh.run(app, budgetMs = budgetMs, minShownMs = 0) }

    @Test fun aGoodSyncReloadsEveryListAndSaysUpToDate() {
        val syncing = AtomicBoolean()
        app.syncNow = { syncing.set(app.widgetRefresh.active) }

        tap()

        assertTrue("the chip says syncing while the sync runs", syncing.get())
        assertFalse(app.widgetRefresh.active)
        assertEquals("the chip is redrawn as the refresh begins", 1, statusRedraws.get())
        assertEquals("every widget list reloads from the database", listOf(EffectScope.FULL), reloads)
        assertEquals(listOf("Up to date"), toasts)
        assertEquals("nothing is left for the background", 0, queued.get())
    }

    @Test fun aFailedSyncStillReloadsTheListsSaysWhyAndLeavesARetryToTheBackground() {
        app.syncNow = { throw ApiException(-1, UNREACHABLE_MESSAGE) }

        tap()

        assertEquals("cached notes are reloaded even when the network failed", listOf(EffectScope.FULL), reloads)
        assertEquals(listOf("Couldn't reach the server"), toasts)
        assertEquals(1, queued.get())
        assertFalse(app.widgetRefresh.active)
    }

    @Test fun anExpiredSessionIsReportedWithoutQueueingAnotherTry() {
        app.syncNow = { throw ApiException(401, "Your Keeparr session expired. Sign in again.") }

        tap()

        assertEquals(listOf("Session expired. Open Keeparr to sign in"), toasts)
        assertEquals("only the person can fix this", 0, queued.get())
        assertEquals(listOf(EffectScope.FULL), reloads)
    }

    @Test fun aCertificateProblemIsReportedWithoutQueueingTriesThatCanOnlyFailTheSameWay() {
        app.syncNow = { throw ApiException(-1, "Secure connection failed. Check the server certificate and the selected client certificate.") }

        tap()

        assertEquals(listOf("Secure connection failed. Open Keeparr to check it"), toasts)
        assertEquals(0, queued.get())
    }

    @Test fun aFailureIsNamedFromItselfNotFromAnEarlierSavedProblem() {
        profile.message = "Your Keeparr session expired. Sign in again." // left over from before, and not rewritten by this failure
        app.syncNow = { throw ApiException(-1, UNREACHABLE_MESSAGE) }

        tap()

        assertEquals(listOf("Couldn't reach the server"), toasts)
        assertEquals(1, queued.get())
    }

    @Test fun aSyncSlowerThanTheBroadcastCanWaitIsLeftRunningAndFinishesInTheBackground() {
        val release = CompletableDeferred<Unit>()
        val interrupted = AtomicBoolean()
        app.syncNow = { try { release.await() } catch (stopped: CancellationException) { interrupted.set(true); throw stopped } }

        tap(budgetMs = 50)

        assertEquals(listOf("Taking longer than usual. Still syncing in the background"), toasts)
        assertEquals("a worker is queued in case the process goes away first", 1, queued.get())
        assertFalse("the blocking HTTP call could not be interrupted, so the sync is not cancelled", interrupted.get())
        assertFalse("the chip stops saying syncing", app.widgetRefresh.active)
        assertEquals(listOf(EffectScope.FULL), reloads)
        release.complete(Unit)
    }

    @Test fun aTapAfterATimedOutOneJoinsTheSyncStillRunningInsteadOfStartingAnother() {
        val release = CompletableDeferred<Unit>()
        val runs = AtomicInteger()
        app.syncNow = { runs.incrementAndGet(); release.await() }
        tap(budgetMs = 50)
        assertEquals(1, runs.get())

        runBlocking {
            val second = launch(Dispatchers.IO) { app.widgetRefresh.run(app, budgetMs = 5_000, minShownMs = 0) }
            withTimeout(5_000) { while (!app.widgetRefresh.active) delay(5) }
            release.complete(Unit)
            second.join()
        }

        assertEquals("one sync served both taps", 1, runs.get())
        assertEquals(listOf("Taking longer than usual. Still syncing in the background", "Up to date"), toasts)
    }

    @Test fun aSecondTapWhileOneIsSyncingChangesNothing() = runBlocking {
        val release = CompletableDeferred<Unit>()
        val runs = AtomicInteger()
        app.syncNow = { runs.incrementAndGet(); release.await() }
        val first = launch(Dispatchers.IO) { app.widgetRefresh.run(app, budgetMs = 5_000, minShownMs = 0) }
        withTimeout(5_000) { while (!app.widgetRefresh.active) delay(5) }

        app.widgetRefresh.run(app, budgetMs = 5_000, minShownMs = 0)

        assertTrue("the first refresh is still waiting", first.isActive)
        release.complete(Unit)
        first.join()
        assertEquals(1, runs.get())
        assertEquals(listOf("Up to date"), toasts)
    }

    @Test fun aSlowStartStillGivesTheSyncAChance() {
        profile.readyAfterMs = 700 // waking the process used up more than the whole budget
        app.syncNow = {}

        tap(budgetMs = 500)

        assertEquals(listOf("Up to date"), toasts)
        assertEquals(0, queued.get())
    }

    @Test fun aWriteThatNeverFinishesDoesNotHoldTheBroadcastOpen() {
        profile.writesNeverFinish = true
        app.syncNow = {}
        val started = System.nanoTime()

        tap()

        assertTrue("took ${(System.nanoTime() - started) / 1_000_000} ms", System.nanoTime() - started < 4_000_000_000L)
        assertEquals(listOf("Up to date"), toasts)
        assertEquals(listOf(EffectScope.FULL), reloads)
    }

    @Test fun aSignedOutWidgetDoesNothing() {
        profile.token = ""
        val ran = AtomicBoolean()
        app.syncNow = { ran.set(true) }

        tap()

        assertFalse(ran.get())
        assertTrue(toasts.isEmpty())
        assertTrue(reloads.isEmpty())
        assertEquals(0, statusRedraws.get())
        assertFalse(app.widgetRefresh.active)
    }

    @Test fun aFatalErrorStillClearsTheChipAndReloadsTheLists() {
        app.syncNow = { throw AssertionError("boom") }

        val thrown = runCatching { tap() }.exceptionOrNull()

        assertTrue("not swallowed: $thrown", thrown is AssertionError)
        assertFalse(app.widgetRefresh.active)
        assertEquals(listOf(EffectScope.FULL), reloads)
    }

    @Test fun theToastNamesTheProblemWithoutEverEchoingServerText() {
        fun failed(message: String) = refreshToast(IOException(message))
        assertEquals("Up to date", refreshToast(null))
        assertEquals("Taking longer than usual. Still syncing in the background", refreshToast(CancellationException("timed out")))
        assertEquals("Session expired. Open Keeparr to sign in", failed("Your Keeparr session expired. Sign in again."))
        assertEquals("Access denied. Open Keeparr to check your account", failed("Access denied by the server or gateway. Check your certificate and account."))
        assertEquals("Server update needed. Open Keeparr", failed("This Keeparr server is too old for the native client. Update the server protocol first."))
        assertEquals("Secure connection failed. Open Keeparr to check it", failed("Secure connection failed. Check the server certificate and the selected client certificate."))
        for (message in listOf(UNREACHABLE_MESSAGE, "The Keeparr server is unavailable right now (HTTP 530).", "x".repeat(5000))) {
            assertEquals(message.take(40), "Couldn't reach the server", failed(message))
        }
        assertEquals("a failure without a message", "Couldn't reach the server", refreshToast(IllegalStateException()))
    }
}
