package dev.keeparr.android.data

import androidx.room.Room
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.ui.PreviewGeometry
import dev.keeparr.android.ui.previewDecodeSize
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.Source
import okio.Timeout
import okio.buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import java.io.File
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

@RunWith(RobolectricTestRunner::class)
class MediaReliabilityTest {
    private class Profile : ConnectionProfile {
        @Volatile override var origin = "https://one.example.test"
        override var alias = ""
        @Volatile override var userId = 11L
        override var token = "token"
        override var headers = ""
        override var message = ""
        override var darkMode = false
        override fun aliasFor(server: String) = ""
        override fun setAliasFor(server: String, value: String) {}
        override fun headersFor(server: String) = ""
        override fun setHeadersFor(server: String, value: String) {}
        override val profile get() = "$origin#$userId"
    }

    private class FakeApi(private val interceptor: Interceptor) : NativeApi {
        private val http = OkHttpClient.Builder().addInterceptor(interceptor).build()
        override fun client(connection: ConnectionSnapshot?) = http
        override fun request(path: String, connection: ConnectionSnapshot?): Request.Builder =
            Request.Builder().url((connection?.origin ?: "https://one.example.test").trimEnd('/') + path)
        override suspend fun call(path: String, method: String, body: JSONObject?, connection: ConnectionSnapshot?): String = error("unused")
        override suspend fun login(origin: String, username: String, password: String, totp: String, gatewayHeaders: String) = JSONObject()
        override suspend fun testConnection(origin: String, headers: String) = ""
    }

    private lateinit var app: KeeparrApplication
    private lateinit var profile: Profile

    @Before fun setUp() {
        app = RuntimeEnvironment.getApplication() as KeeparrApplication
        app.scope.coroutineContext.cancel()
        app.database.close()
        profile = Profile()
        app.settings = profile
        app.database = Room.inMemoryDatabaseBuilder(app, KeeparrDatabase::class.java).allowMainThreadQueries().build()
        File(app.cacheDir, "media").deleteRecursively()
    }

    @After fun tearDown() {
        app.database.close()
        app.scope.coroutineContext.cancel()
    }

    private fun install(interceptor: Interceptor) {
        app.repository = KeeparrRepository(app, app.database, profile, FakeApi(interceptor))
    }

    private fun ok(chain: Interceptor.Chain, bytes: ByteArray = "image-bytes".toByteArray()) = Response.Builder()
        .request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
        .body(bytes.toResponseBody("image/png".toMediaType())).build()

    private fun keyOf(value: String) = java.security.MessageDigest.getInstance("SHA-256").digest(value.toByteArray())
        .take(10).joinToString("") { "%02x".format(it) }

    @Test fun aProfileSwitchMidDownloadCannotFileMediaUnderTheNewProfile() = runBlocking {
        val started = profile.snapshot()
        install(Interceptor { chain -> profile.userId = 12; ok(chain) })

        val file = Media(app).download("/api/uploads/a.png", ConnectionSnapshot(started.origin, "", 0, "", 11, "token"))

        assertTrue("stored under the profile the request was made for", file.name.startsWith(keyOf("https://one.example.test#11") + "_"))
        assertTrue(File(app.cacheDir, "media").listFiles().orEmpty().none { it.name.startsWith(keyOf("https://one.example.test#12") + "_") })
    }

    @Test fun concurrentRequestsForOneFileShareASingleTransfer() = runBlocking {
        val requests = AtomicInteger()
        install(Interceptor { chain -> requests.incrementAndGet(); Thread.sleep(150); ok(chain) })
        val media = Media(app)
        val files = (1..6).map { async(Dispatchers.Default) { media.download("/api/uploads/shared.png") } }.awaitAll()
        assertEquals(1, requests.get())
        assertEquals(1, files.map { it.path }.toSet().size)
    }

    @Test fun aCacheHitDoesNotTouchTheNetworkAndRefreshesTheFilesAge() = runBlocking {
        val requests = AtomicInteger()
        install(Interceptor { chain -> requests.incrementAndGet(); ok(chain) })
        val media = Media(app)
        val file = media.download("/api/uploads/hit.png")
        file.setLastModified(1_000)
        assertEquals(file, media.download("/api/uploads/hit.png"))
        assertEquals(1, requests.get())
        assertTrue("used files are evicted last", file.lastModified() > 1_000)
    }

    @Test fun leavingWhileTheBodyIsStreamingCancelsTheCallAndLeavesNoPartialFile() = runBlocking {
        val callCancelled = CompletableDeferred<Unit>()
        val reading = CompletableDeferred<Unit>()
        install(Interceptor { chain ->
            val call = chain.call()
            val blocking = object : Source {
                override fun read(sink: Buffer, byteCount: Long): Long {
                    reading.complete(Unit)
                    val deadline = System.nanoTime() + 5_000_000_000
                    while (!call.isCanceled() && System.nanoTime() < deadline) Thread.sleep(10)
                    if (call.isCanceled()) { callCancelled.complete(Unit); throw IOException("Canceled") }
                    return -1
                }
                override fun timeout() = Timeout.NONE
                override fun close() {}
            }
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .body(object : ResponseBody() {
                    override fun contentType() = "image/png".toMediaType()
                    override fun contentLength() = -1L
                    override fun source() = blocking.buffer()
                }).build()
        })
        val download = async(Dispatchers.Default) { runCatching { Media(app).download("/api/uploads/slow.png") } }
        withTimeout(3_000) { reading.await() }

        download.cancel()

        withTimeout(2_000) { callCancelled.await() }
        withTimeout(2_000) { while (File(app.cacheDir, "media").listFiles().orEmpty().isNotEmpty()) delay(20) }
    }

    @Test fun mediaOutsideTheServerOriginIsNeverFetchedWithCredentials() = runBlocking {
        val requests = AtomicInteger()
        install(Interceptor { chain -> requests.incrementAndGet(); ok(chain) })
        val failure = runCatching { Media(app).download("https://evil.example.test/steal.png") }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException)
        assertEquals(0, requests.get())
    }

    @Test fun sharedLoaderRunsOnceAcrossConsumersRetriesAfterFailureAndCachesOnlySuccess() = runBlocking {
        val stored = mutableMapOf<String, String>()
        val loader = SharedLoader<String>(onResult = { key, value -> stored[key] = value })
        val runs = AtomicInteger()
        val gate = CompletableDeferred<Unit>()
        val results = (1..4).map { async(Dispatchers.Default) { loader.load("k") { runs.incrementAndGet(); gate.await(); "value" } } }
        delay(50); gate.complete(Unit)
        assertEquals(listOf("value", "value", "value", "value"), results.awaitAll())
        assertEquals(1, runs.get())
        assertEquals(mapOf("k" to "value"), stored)

        assertNull(loader.load("bad") { runs.incrementAndGet(); null })
        assertNull("failures are not cached; the next consumer tries again", loader.load("bad") { runs.incrementAndGet(); null })
        assertEquals(3, runs.get())
        assertFalse(stored.containsKey("bad"))
        assertEquals(0, loader.activeLoads)
    }

    @Test fun previewDecodeSizeFollowsTheSlotInBucketsAndIsClamped() {
        assertEquals(512, previewDecodeSize(170 * 3, 240))
        assertEquals(previewDecodeSize(500, 240), previewDecodeSize(505, 240))
        assertEquals("tiny slots still decode at the smallest bucket", 128, previewDecodeSize(10, 10))
        assertEquals(2048, previewDecodeSize(9000, 100))
        assertTrue(previewDecodeSize(1080, 700) < 2048)
    }

    @Test fun reservedPreviewHeightUsesTheLastKnownAspectRatioBoundedByTheSlot() {
        val path = "/api/uploads/shape-${System.nanoTime()}.png"
        assertEquals(300, PreviewGeometry.reservedHeightPx(path, 400, 1000))
        PreviewGeometry.remember(path, 200, 400)
        assertEquals(800, PreviewGeometry.reservedHeightPx(path, 400, 1000))
        assertEquals("never taller than the slot allows", 480, PreviewGeometry.reservedHeightPx(path, 400, 480))
    }
}
