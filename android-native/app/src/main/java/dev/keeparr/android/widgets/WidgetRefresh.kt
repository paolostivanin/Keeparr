package dev.keeparr.android.widgets

import android.os.SystemClock
import android.util.Log
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.data.ConnectionState
import dev.keeparr.android.data.EffectScope
import dev.keeparr.android.data.connectionStateForMessage
import kotlinx.coroutines.*
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

private const val TAG = "KeeparrWidget"

/**
 * What a tap on the widget's status does: sync now, inside the tap's own broadcast, and say what happened. A background job is
 * only the fallback: someone waiting needs an attempt that does not depend on job quotas, Doze or a network constraint, and an
 * outcome they can see even when nothing changed.
 */
internal class WidgetRefresh {
    private val running = AtomicBoolean(false)
    // The sync a tap started and may have stopped waiting for. The next tap joins it instead of queueing another behind it.
    private val inFlight = AtomicReference<Deferred<Unit>?>(null)

    /** A tap's sync is in progress; [widgetPill] says so. */
    val active: Boolean get() = running.get()

    /**
     * Returns within about [budgetMs] of being called, plus a short tail, because a broadcast may be held open for 10 seconds.
     * The wait is on a Deferred because the HTTP call is blocking and would not notice a cancellation; when the wait runs out
     * the sync is left to finish in the background, where its own redraw reports the result.
     */
    suspend fun run(app: KeeparrApplication, budgetMs: Long = BUDGET_MS, minShownMs: Long = MIN_SHOWN_MS) {
        val started = SystemClock.elapsedRealtime()
        app.settings.awaitReady()
        // A second tap while one is running changes nothing: the chip already says "Syncing…".
        if (app.settings.token.isEmpty() || !running.compareAndSet(false, true)) return
        Log.i(TAG, "Refresh requested from the widget.")
        var failure: Exception? = null
        try {
            app.refreshWidgetStatus(app)
            val shown = SystemClock.elapsedRealtime()
            val sync = inFlight.get()?.takeIf { it.isActive } ?: app.scope.async { app.syncNow() }.also { inFlight.set(it) }
            // Waking the process may have used up the budget; the sync still gets a moment of its own.
            val wait = (budgetMs - (shown - started)).coerceAtLeast(minOf(budgetMs, MIN_WAIT_MS))
            failure = try {
                withTimeout(wait) { sync.await() }
                null
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive() // being cancelled ourselves is not a failed sync
                error
            }
            // An instant failure (no network) would otherwise flash "Syncing…" and look as if the tap did nothing.
            delay(minShownMs - (SystemClock.elapsedRealtime() - shown))
        } finally {
            running.set(false)
            withContext(NonCancellable) {
                // The saved problem and sync time are written asynchronously, and the process may be cached once the broadcast
                // ends. A write that never finishes must not hold the broadcast open.
                withTimeoutOrNull(WRITES_MS) { app.settings.awaitWrites() }
                // Every list reloads from the database and the chip is redrawn, also when the network failed.
                app.refreshWidgetScope(app, EffectScope.FULL)
                delay(SETTLE_MS) // lets that asynchronous redraw reach the launcher before the broadcast is released
            }
        }
        if (retryable(failure)) app.enqueueSync(app)
        app.showToast(refreshToast(failure))
        Log.i(TAG, "Refresh from the widget ended: ${failure?.javaClass?.simpleName ?: "synced"}.")
    }

    private companion object {
        const val BUDGET_MS = 8_000L
        const val MIN_WAIT_MS = 1_000L
        const val MIN_SHOWN_MS = 900L
        const val WRITES_MS = 1_000L
        const val SETTLE_MS = 250L
    }
}

/**
 * What a failure means for the connection, classified from its message as the chip will classify what sync() saves from it
 * (the saved copy may not be written yet, and may belong to an earlier failure).
 */
private fun problem(failure: Exception) = connectionStateForMessage(failure.message.orEmpty())

/**
 * A failure worth another try later: the wait ran out, or the connection is the problem. Not the account, the server's version
 * or a certificate, which another try cannot fix.
 */
private fun retryable(failure: Exception?) = failure != null && (failure is CancellationException || when (problem(failure)) {
    is ConnectionState.SessionExpired, is ConnectionState.GatewayDenied, is ConnectionState.Incompatible,
    is ConnectionState.CertificateAttention -> false
    else -> true
})

/** The toast after a tap. Fixed text only: a failure's message can carry whatever the server sent, so it is classified, never shown. */
internal fun refreshToast(failure: Exception?): String = when {
    failure == null -> "Up to date"
    failure is CancellationException -> "Taking longer than usual. Still syncing in the background"
    else -> when (problem(failure)) {
        is ConnectionState.SessionExpired -> "Session expired. Open Keeparr to sign in"
        is ConnectionState.GatewayDenied -> "Access denied. Open Keeparr to check your account"
        is ConnectionState.Incompatible -> "Server update needed. Open Keeparr"
        is ConnectionState.CertificateAttention -> "Secure connection failed. Open Keeparr to check it"
        else -> "Couldn't reach the server"
    }
}
