package dev.kept.android.data

import android.net.Uri
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.provider.OpenableColumns
import android.util.Base64
import android.util.LruCache
import com.caverock.androidsvg.SVG
import dev.kept.android.KeptApplication
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.RequestBody.Companion.asRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal object DecodedPreviewCache {
    private val bitmaps = object : LruCache<String, Bitmap>(32 * 1024) {
        override fun sizeOf(key: String, value: Bitmap) = (value.allocationByteCount / 1024).coerceAtLeast(1)
    }
    private data class Request(val deferred: Deferred<Bitmap?>, var consumers: Int)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val inFlight = mutableMapOf<String, Request>()

    suspend fun getOrLoad(key: String, load: suspend () -> Bitmap?): Bitmap? {
        val pending = synchronized(this) {
            bitmaps.get(key)?.let { return it }
            inFlight[key]?.also { it.consumers++ } ?: run {
                lateinit var request: Request
                val deferred = scope.async(start = kotlinx.coroutines.CoroutineStart.LAZY) {
                    load()?.also { bitmap -> synchronized(this@DecodedPreviewCache) { bitmaps.put(key, bitmap) } }
                }
                request = Request(deferred, 1)
                inFlight[key] = request
                deferred.invokeOnCompletion {
                    synchronized(this@DecodedPreviewCache) {
                        if (inFlight[key] === request) inFlight.remove(key)
                    }
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

    @Synchronized fun removeProfile(profileKey: String) {
        bitmaps.snapshot().keys.filter { it.startsWith("$profileKey:") }.forEach(bitmaps::remove)
    }
}

interface MediaUploadPort {
    suspend fun upload(entry: Outbox, repository: KeptRepository): JSONObject
}

class Media(private val app: KeptApplication) : MediaUploadPort {
    suspend fun stage(uri: Uri): JSONObject = withContext(Dispatchers.IO) {
        val mime = app.contentResolver.getType(uri) ?: "application/octet-stream"
        var name = "attachment"
        app.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) name = cursor.getString(0)
        }
        val folder = File(app.filesDir, "pending-media").apply { mkdirs() }
        val file = File(folder, UUID.randomUUID().toString())
        try {
            app.contentResolver.openInputStream(uri)?.use { input -> file.outputStream().use { output ->
                val buffer = ByteArray(8192); var total = 0
                while (true) { val length = input.read(buffer); if (length < 0) break; total += length
                    require(total <= 25 * 1024 * 1024) { "Attachments must be at most 25 MB." }; output.write(buffer, 0, length) }
            } } ?: error("Cannot read the shared file")
            JSONObject().put("file", file.name).put("name", name).put("mime", mime)
        } catch (error: Exception) { file.delete(); throw error }
    }

    override suspend fun upload(entry: Outbox, repository: KeptRepository): JSONObject = withContext(Dispatchers.IO) {
        val connection = repository.settings.snapshot()
        if (connection.profile != entry.profile) throw ApiException(401, "This upload belongs to a different Kept profile. Reconnect to that account to resume it.")
        val payload = JSONObject(entry.payload)
        val file = File(app.filesDir, "pending-media/${payload.getString("file")}")
        require(file.exists()) { "The pending attachment file is unavailable." }
        val note = repository.note(payload.getString("noteSyncId")) ?: error("Note is not accessible")
        require(note.id > 0) { "Waiting for the note to synchronize." }
        val image = payload.getString("mime") in setOf("image/png", "image/jpeg", "image/gif", "image/webp")
        val route = if (image) "/api/uploads/images" else "/api/notes/${note.id}/attachments"
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart(if (image) "image" else "file", payload.getString("name"), file.asRequestBody(payload.getString("mime").toMediaType()))
            .apply {
                if (image) addFormDataPart("operationId", "image-${entry.operationId}")
                else addFormDataPart("operationId", "attachment-${entry.operationId}").addFormDataPart("syncId", "attachment-${entry.operationId}")
            }
            .build()
        val response = repository.api.client(connection).newCall(repository.api.request(route, connection).post(body).build()).awaitResponse().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw ApiException(response.code, "Attachment upload failed (${response.code})")
            JSONObject(text)
        }
        if (image) {
            val raw = note.raw.copyJson()
            val images = raw.optJSONArray("images") ?: JSONArray()
            val imageRecord = JSONObject().put("id", "native-${entry.operationId}").put("dataUrl", response.getString("url"))
                .put("name", payload.getString("name")).put("placement", "top")
            images.put(imageRecord)
            raw.put("images", images)
            val mutation = JSONObject().put("type", "note.upsert").put("syncId", note.syncId).put("baseRevision", note.revision)
                .put("operationId", "image-${entry.operationId}").put("payload", raw)
            val result = JSONObject(repository.api.call("/api/sync/mutations", "POST", NativeProtocol.mutationBatch(listOf(mutation), includeSnapshot = false), connection))
            val outcome = result.getJSONArray("results").getJSONObject(0)
            if (!outcome.optBoolean("ok")) throw ApiException(outcome.optInt("status", 409), outcome.text("error", "The note changed during the image upload."))
            val serverNote = outcome.optJSONObject("payload")
                ?: result.optJSONObject("snapshot")?.optJSONArray("notes")?.objects()?.firstOrNull { it.text("syncId") == note.syncId }
            JSONObject().put("kind", "image").put("noteSyncId", note.syncId).put("noteId", note.id)
                .put("noteRevision", serverNote?.optLong("revision") ?: (note.revision + 1)).put("image", imageRecord)
        } else {
            response.put("kind", "attachment").put("noteSyncId", note.syncId)
        }
    }

    suspend fun download(path: String, connection: ConnectionSnapshot = app.settings.snapshot()): File = withContext(Dispatchers.IO) {
        val base = connection.origin.toHttpUrl()
        val url = base.resolve(path) ?: error("Invalid media address")
        require(url.scheme == base.scheme && url.host == base.host && url.port == base.port) { "External media is not downloaded with Kept credentials." }
        val folder = File(app.cacheDir, "media").apply { mkdirs() }
        val profileKey = profileKey(app.settings.profile)
        val hash = java.security.MessageDigest.getInstance("SHA-256").digest((app.settings.profile + url).toByteArray()).joinToString("") { "%02x".format(it) }
        val file = File(folder, "${profileKey}_$hash")
        if (file.exists()) return@withContext file
        val requestPath = url.encodedPath + (url.encodedQuery?.let { "?$it" } ?: "")
        val temporary = File(folder, "${profileKey}_$hash.pending-${UUID.randomUUID()}")
        try {
            app.repository.api.client(connection).newCall(app.repository.api.request(requestPath, connection).build()).awaitResponse().use { response ->
                if (!response.isSuccessful) throw ApiException(response.code, "Media download failed (${response.code})")
                response.body?.byteStream()?.use { input -> temporary.outputStream().use { output ->
                    val buffer = ByteArray(8192); var total = 0
                    while (true) { val length = input.read(buffer); if (length < 0) break; total += length
                        require(total <= 25 * 1024 * 1024) { "Media exceeds the download limit." }; output.write(buffer, 0, length) }
                } } ?: error("Empty media response")
            }
            require(temporary.renameTo(file)) { "Could not save downloaded media" }
            evictProfileCache(folder, profileKey, file)
            file
        } finally { temporary.delete() }
    }

    suspend fun preview(path: String, maxDimension: Int = 1000): Bitmap? = withContext(Dispatchers.IO) {
        val connection = app.settings.snapshot()
        val boundedDimension = maxDimension.coerceIn(64, 2048)
        val profileHash = profileKey(connection.profile)
        val pathHash = java.security.MessageDigest.getInstance("SHA-256")
            .digest((connection.profile + "\u0000" + path).toByteArray())
            .joinToString("") { "%02x".format(it) }
        val cacheKey = "$profileHash:$pathHash:$boundedDimension"
        DecodedPreviewCache.getOrLoad(cacheKey) {
            runCatching {
                val bytes = if (path.startsWith("data:image/")) {
                    val comma = path.indexOf(',')
                    require(comma >= 0) { "Invalid image data." }
                    val metadata = path.substring(0, comma)
                    val content = path.substring(comma + 1)
                    if (metadata.contains(";base64", true)) Base64.decode(content, Base64.DEFAULT)
                    else Uri.decode(content).toByteArray(Charsets.UTF_8)
                } else download(path, connection).readBytes()
                require(bytes.size <= 25 * 1024 * 1024) { "Image preview exceeds the size limit." }
                if (path.startsWith("data:image/svg+xml", true) || bytes.take(256).toByteArray().toString(Charsets.UTF_8).contains("<svg", true)) {
                    val svg = SVG.getFromString(bytes.toString(Charsets.UTF_8))
                    val intrinsicWidth = svg.documentWidth.takeIf { it.isFinite() && it > 0f } ?: 400f
                    val intrinsicHeight = svg.documentHeight.takeIf { it.isFinite() && it > 0f } ?: 400f
                    val scale = minOf(1f, boundedDimension / maxOf(intrinsicWidth, intrinsicHeight))
                    val width = (intrinsicWidth * scale).toInt().coerceAtLeast(1)
                    val height = (intrinsicHeight * scale).toInt().coerceAtLeast(1)
                    val picture = svg.renderToPicture(width, height)
                    Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { bitmap -> Canvas(bitmap).drawPicture(picture) }
                } else {
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                    val sample = imageSampleSize(bounds.outWidth, bounds.outHeight, boundedDimension)
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
                }
            }.getOrNull()
        }
    }

    suspend fun clearProfile(profile: String, pendingUploads: Boolean = false) = withContext(Dispatchers.IO) {
        val key = profileKey(profile)
        DecodedPreviewCache.removeProfile(key)
        File(app.cacheDir, "media").listFiles().orEmpty().filter {
            it.name.startsWith("${key}_") || it.name.matches(Regex("[a-f0-9]{64}"))
        }.forEach(File::delete)
        if (pendingUploads) {
            val folder = File(app.filesDir, "pending-media").canonicalFile
            val files = app.repository.store.pending(profile).mapNotNull { entry ->
                if (entry.type != "media.upload") return@mapNotNull null
                runCatching { File(folder, JSONObject(entry.payload).text("file")).canonicalFile }
                    .getOrNull()?.takeIf { it.parentFile == folder }
            }
            files.forEach(File::delete)
        }
    }

    private fun profileKey(profile: String) = java.security.MessageDigest.getInstance("SHA-256")
        .digest(profile.toByteArray()).take(10).joinToString("") { "%02x".format(it) }
}

internal fun imageSampleSize(width: Int, height: Int, maxDimension: Int): Int {
    if (width <= 0 || height <= 0) return 1
    val limit = maxDimension.coerceAtLeast(1)
    var sample = 1
    while (maxOf(width / sample, height / sample) > limit && sample <= (1 shl 29)) sample *= 2
    return sample
}

private suspend fun okhttp3.Call.awaitResponse(): okhttp3.Response = suspendCancellableCoroutine { continuation ->
    continuation.invokeOnCancellation { cancel() }
    enqueue(object : okhttp3.Callback {
        override fun onFailure(call: okhttp3.Call, error: IOException) {
            if (continuation.isActive) continuation.resumeWithException(error)
        }

        override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
            if (continuation.isActive) continuation.resume(response) else response.close()
        }
    })
}

internal fun evictProfileCache(folder: File, profileKey: String, current: File, maxBytes: Long = 100L * 1024 * 1024) {
    val ownedFiles = folder.listFiles().orEmpty().filter { it.name.startsWith("${profileKey}_") }
    var size = ownedFiles.sumOf { it.length() }
    for (old in ownedFiles.filter { it != current }.sortedBy { it.lastModified() }) {
        if (size <= maxBytes) break
        size -= old.length()
        old.delete()
    }
}
