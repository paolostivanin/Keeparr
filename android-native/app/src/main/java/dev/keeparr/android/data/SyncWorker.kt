package dev.keeparr.android.data

import android.content.Context
import androidx.work.*
import dev.keeparr.android.KeeparrApplication
import kotlinx.coroutines.CancellationException
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as KeeparrApplication
        app.settings.awaitReady()
        val profile = inputData.getString(PROFILE_KEY)
        if (profile != null && profile != profileKey(app.settings.profile)) return Result.success()
        if (app.settings.token.isEmpty()) return Result.success()
        return try { app.repository.sync(); Result.success() } catch (cancelled: CancellationException) { throw cancelled } catch (error: Exception) {
            syncResult(error, runAttemptCount, inputData.getBoolean(ONE_SHOT_KEY, false))
        }
    }
    companion object {
        private const val PROFILE_KEY = "profileKey"
        private const val ONE_SHOT_KEY = "oneShot"
        private const val MAX_RETRIES = 4

        /**
         * A failed run retries on WorkManager's short early backoff and then hands over to the 15-minute periodic run, instead
         * of sitting in a backoff that grows to hours. A run the user asked for is not retried: the widget already reports it.
         */
        internal fun syncResult(error: Exception, runAttemptCount: Int, oneShot: Boolean): ListenableWorker.Result = when {
            error is ApiException && error.code in setOf(401, 403) -> ListenableWorker.Result.failure()
            oneShot || runAttemptCount >= MAX_RETRIES -> ListenableWorker.Result.success()
            else -> ListenableWorker.Result.retry()
        }
        private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        private fun profileKey(profile: String) = java.security.MessageDigest.getInstance("SHA-256")
            .digest(profile.toByteArray()).take(12).joinToString("") { "%02x".format(it) }
        private fun profileKey(context: Context) = profileKey((context.applicationContext as KeeparrApplication).settings.profile)
        private fun oneTime(context: Context) = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(constraints)
            .setInputData(workDataOf(PROFILE_KEY to profileKey(context)))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        fun enqueue(context: Context) {
            val key = profileKey(context)
            WorkManager.getInstance(context).enqueueUniqueWork("keeparr-sync-now-$key", ExistingWorkPolicy.APPEND_OR_REPLACE, oneTime(context))
        }
        /** A sync the user asked for: it jumps the queue, runs once, and is not retried; the widget reports a failure. */
        fun refreshNow(context: Context) {
            val key = profileKey(context)
            WorkManager.getInstance(context).enqueueUniqueWork("keeparr-sync-tap-$key", ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(constraints)
                    .setInputData(workDataOf(PROFILE_KEY to key, ONE_SHOT_KEY to true))
                    .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST).build())
        }
        fun schedule(context: Context) {
            val key = profileKey(context)
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("keeparr-sync-periodic-$key", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(constraints)
                    .setInputData(workDataOf(PROFILE_KEY to key)).build())
            enqueue(context)
        }
        fun cancel(context: Context) {
            val key = profileKey(context)
            WorkManager.getInstance(context).cancelUniqueWork("keeparr-sync-now-$key")
            WorkManager.getInstance(context).cancelUniqueWork("keeparr-sync-tap-$key")
            WorkManager.getInstance(context).cancelUniqueWork("keeparr-sync-periodic-$key")
            WorkManager.getInstance(context).cancelUniqueWork("keeparr-sync-now")
            WorkManager.getInstance(context).cancelUniqueWork("keeparr-sync-periodic")
        }
    }
}
