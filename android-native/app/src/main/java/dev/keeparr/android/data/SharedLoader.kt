package dev.keeparr.android.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async

/**
 * Shares one in-flight load per key between concurrent consumers. The work keeps running while at least one consumer
 * waits and is cancelled when the last one leaves, so a cancelled screen neither abandons another screen's request nor
 * keeps downloading for nobody. Only successful (non-null) results are handed to [onResult], which owns any caching.
 */
internal class SharedLoader<T : Any>(
    private val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
    private val onResult: (String, T) -> Unit = { _, _ -> }
) {
    private class Request<T>(val deferred: Deferred<T?>, var consumers: Int)
    private val inFlight = mutableMapOf<String, Request<T>>()

    // A deferred is completed before its completion handlers run, so the entry can briefly outlive the work; such an
    // entry is neither active nor joinable.
    val activeLoads: Int get() = synchronized(this) { inFlight.values.count { !it.deferred.isCompleted } }

    suspend fun load(key: String, cached: () -> T? = { null }, work: suspend () -> T?): T? {
        val pending = synchronized(this) {
            cached()?.let { return it }
            inFlight[key]?.takeIf { !it.deferred.isCompleted }?.also { it.consumers++ } ?: run {
                lateinit var request: Request<T>
                val deferred = scope.async(start = CoroutineStart.LAZY) {
                    work()?.also { result -> synchronized(this@SharedLoader) { onResult(key, result) } }
                }
                request = Request(deferred, 1)
                inFlight[key] = request
                deferred.invokeOnCompletion {
                    synchronized(this@SharedLoader) { if (inFlight[key] === request) inFlight.remove(key) }
                }
                deferred.start()
                request
            }
        }
        try {
            return pending.deferred.await()
        } finally {
            synchronized(this) {
                pending.consumers--
                if (pending.consumers == 0 && !pending.deferred.isCompleted) {
                    if (inFlight[key] === pending) inFlight.remove(key)
                    pending.deferred.cancel()
                }
            }
        }
    }
}
