package dev.keeparr.android.data

import androidx.work.ListenableWorker.Result
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class SyncWorkerPolicyTest {
    private val offline = ApiException(-1, UNREACHABLE_MESSAGE)

    @Test fun anExpiredOrDeniedSessionIsNotRetried() {
        for (code in listOf(401, 403)) {
            for (attempts in 0..6) assertEquals(Result.failure(), SyncWorker.syncResult(ApiException(code, "no"), attempts))
        }
    }

    @Test fun aFailureRetriesAFewTimesOnTheEarlyBackoffThenLeavesItToThePeriodicRun() {
        for (attempts in 0..3) assertEquals("attempt $attempts", Result.retry(), SyncWorker.syncResult(offline, attempts))
        for (attempts in 4..8) assertEquals("attempt $attempts", Result.success(), SyncWorker.syncResult(offline, attempts))
    }

    @Test fun anyOtherErrorIsTreatedAsATransientFailure() {
        assertEquals(Result.retry(), SyncWorker.syncResult(ApiException(503, "down"), 0))
        assertEquals(Result.retry(), SyncWorker.syncResult(IllegalStateException("boom"), 1))
    }
}
