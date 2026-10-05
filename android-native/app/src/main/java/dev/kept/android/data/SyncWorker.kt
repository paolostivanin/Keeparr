package dev.kept.android.data

import android.content.Context
import androidx.work.*
import dev.kept.android.KeptApplication
import java.util.concurrent.TimeUnit

class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext as KeptApplication
        val profile = inputData.getString(PROFILE_KEY)
        if (profile != null && profile != profileKey(app.settings.profile)) return Result.success()
        if (app.settings.token.isEmpty()) return Result.success()
        return try { app.repository.sync(); Result.success() } catch (error: Exception) {
            if (error is ApiException && error.code in setOf(401, 403)) Result.failure() else Result.retry()
        }
    }
    companion object {
        private const val PROFILE_KEY = "profileKey"
        private val constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
        private fun profileKey(profile: String) = java.security.MessageDigest.getInstance("SHA-256")
            .digest(profile.toByteArray()).take(12).joinToString("") { "%02x".format(it) }
        private fun profileKey(context: Context) = profileKey((context.applicationContext as KeptApplication).settings.profile)
        private fun oneTime(context: Context) = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(constraints)
            .setInputData(workDataOf(PROFILE_KEY to profileKey(context)))
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        fun enqueue(context: Context) {
            val key = profileKey(context)
            WorkManager.getInstance(context).enqueueUniqueWork("kept-sync-now-$key", ExistingWorkPolicy.APPEND_OR_REPLACE, oneTime(context))
        }
        fun schedule(context: Context) {
            val key = profileKey(context)
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("kept-sync-periodic-$key", ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(constraints)
                    .setInputData(workDataOf(PROFILE_KEY to key)).build())
            enqueue(context)
        }
        fun cancel(context: Context) {
            val key = profileKey(context)
            WorkManager.getInstance(context).cancelUniqueWork("kept-sync-now-$key")
            WorkManager.getInstance(context).cancelUniqueWork("kept-sync-periodic-$key")
            WorkManager.getInstance(context).cancelUniqueWork("kept-sync-now")
            WorkManager.getInstance(context).cancelUniqueWork("kept-sync-periodic")
        }
    }
}
