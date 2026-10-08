package dev.keeparr.android.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
class MediaRequestTest {
    @Test fun sharedPreviewLoadContinuesUntilItsLastConsumerLeaves() = runBlocking {
        val key = "media-test:${UUID.randomUUID()}"
        val started = CompletableDeferred<Unit>()
        val cancelled = CompletableDeferred<Unit>()
        val first = async(Dispatchers.Default) {
            DecodedPreviewCache.getOrLoad(key) {
                started.complete(Unit)
                try {
                    awaitCancellation()
                } finally {
                    cancelled.complete(Unit)
                }
            }
        }
        started.await()

        val second = async(Dispatchers.Default) {
            DecodedPreviewCache.getOrLoad(key) { error("Concurrent consumers should share the first loader.") }
        }
        delay(30)
        first.cancelAndJoin()
        assertFalse("One cancelled consumer must not cancel another consumer's request.", cancelled.isCompleted)

        second.cancelAndJoin()
        withTimeout(2_000) { cancelled.await() }
    }
}
