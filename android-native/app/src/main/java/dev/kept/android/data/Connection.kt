package dev.kept.android.data

import android.content.Context
import android.security.KeyChain
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.SharedPreferencesMigration
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.MutablePreferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.kept.android.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.flow.first
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.net.Socket
import java.net.UnknownHostException
import java.net.SocketTimeoutException
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.net.ssl.*

sealed interface ConnectionState {
    data object Configured : ConnectionState
    data object Authenticated : ConnectionState
    data class SessionExpired(val message: String) : ConnectionState
    data class GatewayDenied(val message: String) : ConnectionState
    data class CertificateAttention(val message: String) : ConnectionState
    data class Incompatible(val message: String) : ConnectionState
    data class Offline(val message: String) : ConnectionState
}

interface ConnectionProfile {
    var origin: String
    var alias: String
    fun aliasFor(server: String): String
    fun setAliasFor(server: String, value: String)
    fun aliasRevisionFor(server: String): Long = 0
    fun headersFor(server: String): String
    fun setHeadersFor(server: String, value: String)
    var userId: Long
    val profile: String
    var token: String
    var headers: String
    var message: String
    var darkMode: Boolean
    fun snapshot() = ConnectionSnapshot(origin, aliasFor(origin), aliasRevisionFor(origin), headersFor(origin), userId, token)
}

data class ConnectionSnapshot(
    val origin: String,
    val alias: String,
    val aliasRevision: Long,
    val headers: String,
    val userId: Long,
    val token: String
) {
    val profile get() = "$origin#$userId"
    override fun toString() = "ConnectionSnapshot(origin=$origin, userId=$userId, certificateSelected=${alias.isNotBlank()}, authenticated=${token.isNotBlank()}, gatewayHeadersConfigured=${headers.isNotBlank()})"
}

object ConnectionProfilePolicy {
    fun requiresConfirmation(active: ConnectionSnapshot, targetOrigin: String, targetUserId: Long): Boolean =
        active.userId > 0 && "$targetOrigin#$targetUserId" != active.profile
}

interface NativeApi {
    fun client(connection: ConnectionSnapshot? = null): OkHttpClient
    fun request(path: String, connection: ConnectionSnapshot? = null): Request.Builder
    suspend fun call(path: String, method: String = "GET", body: JSONObject? = null, connection: ConnectionSnapshot? = null): String
    suspend fun login(origin: String, username: String, password: String, totp: String, gatewayHeaders: String): JSONObject
    suspend fun testConnection(origin: String, headers: String): String
}

private val Context.connectionDataStore by preferencesDataStore(
    name = "connection",
    produceMigrations = { context -> listOf(SharedPreferencesMigration(context, "connection")) }
)

class ConnectionSettings(context: Context, dataStoreOverride: DataStore<Preferences>? = null) : ConnectionProfile {
    private val dataStore = dataStoreOverride ?: context.connectionDataStore
    @Volatile private var cache: Preferences = runBlocking(Dispatchers.IO) { dataStore.data.first() }
    private val originPreference = stringPreferencesKey("origin")
    private val userIdPreference = longPreferencesKey("userId")
    private val tokenPreference = stringPreferencesKey("token")
    private val messagePreference = stringPreferencesKey("message")
    private val darkModePreference = booleanPreferencesKey("darkMode")

    private fun update(block: MutablePreferences.() -> Unit) {
        cache = runBlocking(Dispatchers.IO) {
            dataStore.edit { values -> values.block() }
        }
    }

    override var origin: String
        get() = cache[originPreference] ?: ""
        set(value) = update { this[originPreference] = value }
    private fun originKey(value: String): String {
        val normalized = runCatching { value.trim().toHttpUrl().newBuilder().encodedPath("/").query(null).build().toString().trimEnd('/') }
            .getOrDefault(value.trim().trimEnd('/'))
        return Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(normalized.toByteArray()), Base64.NO_WRAP)
    }
    private fun aliasPreference(server: String) = stringPreferencesKey("alias_${originKey(server)}")
    private fun aliasRevisionPreference(server: String) = longPreferencesKey("alias_revision_${originKey(server)}")
    private fun headersPreference(server: String) = stringPreferencesKey("headers_${originKey(server)}")

    override fun aliasFor(server: String) = cache[aliasPreference(server)] ?: ""
    override fun setAliasFor(server: String, value: String) {
        val aliasKey = aliasPreference(server)
        val revisionKey = aliasRevisionPreference(server)
        update {
            this[aliasKey] = value
            this[revisionKey] = (this[revisionKey] ?: 0) + 1
        }
    }
    override fun aliasRevisionFor(server: String) = cache[aliasRevisionPreference(server)] ?: 0
    override var alias: String get() = aliasFor(origin); set(value) = setAliasFor(origin, value)
    override fun headersFor(server: String) = decrypt(cache[headersPreference(server)] ?: "")
    override fun setHeadersFor(server: String, value: String) { update { this[headersPreference(server)] = encrypt(value) } }
    override var userId: Long get() = cache[userIdPreference] ?: 0; set(value) = update { this[userIdPreference] = value }
    override val profile: String get() = "$origin#$userId"
    override var token: String get() = decrypt(cache[tokenPreference] ?: ""); set(value) = update { this[tokenPreference] = encrypt(value) }
    override var headers: String get() = headersFor(origin); set(value) = setHeadersFor(origin, value)
    override var message: String get() = cache[messagePreference] ?: ""; set(value) = update { this[messagePreference] = value }
    override var darkMode: Boolean get() = cache[darkModePreference] ?: false; set(value) = update { this[darkModePreference] = value }
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey("kept_session", null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("kept_session", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Synchronized private fun encrypt(value: String): String {
        if (value.isEmpty()) return ""
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(cipher.iv + cipher.doFinal(value.toByteArray()), Base64.NO_WRAP)
    }
    @Synchronized private fun decrypt(value: String): String {
        if (value.isEmpty()) return ""
        return try {
            val bytes = Base64.decode(value, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
            String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)))
        } catch (_: Exception) {
            update { this[messagePreference] = "Saved connection credentials could not be decrypted. Sign in again and re-enter gateway headers if needed; cached notes were retained." }
            ""
        }
    }
}

class ApiException(val code: Int, override val message: String) : Exception(message)

class KeptApi(private val context: Context, private val settings: ConnectionProfile) : NativeApi {
    private var signature = ""
    private var configuredClient: OkHttpClient? = null
    @Synchronized override fun client(connection: ConnectionSnapshot?): OkHttpClient {
        val snapshot = connection ?: settings.snapshot()
        val current = "${snapshot.origin}|${snapshot.alias}|${snapshot.aliasRevision}"
        if (current == signature && configuredClient != null) return configuredClient!!
        val builder = OkHttpClient.Builder().connectTimeout(15, TimeUnit.SECONDS).readTimeout(25, TimeUnit.SECONDS)
            .followRedirects(false).followSslRedirects(false)
        if (snapshot.alias.isNotEmpty()) {
            val selectedAlias = snapshot.alias
            val privateKey = try { KeyChain.getPrivateKey(context, selectedAlias) }
                catch (_: Exception) { null }
                ?: error("Client certificate access is unavailable. Select the certificate again while Kept is open.")
            val chain = try { KeyChain.getCertificateChain(context, selectedAlias) }
                catch (_: Exception) { null }
                ?: error("Client certificate chain is unavailable. Select the certificate again.")
            if (chain.isEmpty()) error("The selected client certificate has no certificate chain. Choose another certificate.")
            try { chain.first().checkValidity() }
            catch (_: Exception) { error("The selected client certificate is expired or not yet valid. Choose a current certificate.") }
            val manager = object : X509ExtendedKeyManager() {
                override fun chooseClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? =
                    if (types?.any { it.equals(privateKey.algorithm, true) } == true) selectedAlias else null
                override fun chooseEngineClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = chooseClientAlias(types, issuers, null)
                override fun getClientAliases(type: String?, issuers: Array<out Principal>?) = arrayOf(selectedAlias)
                override fun getCertificateChain(alias: String?): Array<X509Certificate> = chain
                override fun getPrivateKey(alias: String?): PrivateKey = privateKey
                override fun getServerAliases(type: String?, issuers: Array<out Principal>?): Array<String>? = null
                override fun chooseServerAlias(type: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
            }
            val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(null as KeyStore?) }
                .trustManagers.filterIsInstance<X509TrustManager>().first()
            val tls = SSLContext.getInstance("TLS").apply { init(arrayOf(manager), arrayOf(trust), null) }
            builder.sslSocketFactory(tls.socketFactory, trust)
        }
        signature = current
        return builder.build().also { configuredClient = it }
    }
    override fun request(path: String, connection: ConnectionSnapshot?): Request.Builder {
        val snapshot = connection ?: settings.snapshot()
        val url = snapshot.origin.trimEnd('/') + path
        return Request.Builder().url(url).apply {
            if (snapshot.token.isNotEmpty()) header("Authorization", "Bearer ${snapshot.token}")
            val custom = if (snapshot.headers.isBlank()) JSONObject() else JSONObject(snapshot.headers)
            custom.keys().forEach { name ->
                require(!name.equals("Authorization", true) && !name.equals("Host", true)) { "Reserved connection header: $name" }
                header(name, custom.getString(name))
            }
        }
    }
    override suspend fun call(path: String, method: String, body: JSONObject?, connection: ConnectionSnapshot?): String = withContext(Dispatchers.IO) {
        val snapshot = connection ?: settings.snapshot()
        val request = request(path, snapshot).method(method, if (method in setOf("POST", "PUT", "PATCH"))
            (body ?: JSONObject()).toString().toRequestBody("application/json".toMediaType()) else null).build()
        try {
            client(snapshot).newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                val contentType = response.header("Content-Type").orEmpty()
                val startsWithHtml = text.trimStart().startsWith("<!doctype html", ignoreCase = true) ||
                    text.trimStart().startsWith("<html", ignoreCase = true)
                if (contentType.contains("text/html", ignoreCase = true) || startsWithHtml) {
                    Log.e("KeptApi", "Expected JSON for $path, received HTML (HTTP ${response.code}, content-type=$contentType).")
                    val message = when (response.code) {
                        401 -> "Your Kept session expired or the gateway requires sign-in. Check API routing, then authenticate again."
                        403 -> "The server or gateway denied this API request. Check its /api routing and access policy."
                        else -> "Kept's API returned HTML for $path (HTTP ${response.code}); this path is not reaching the Kept backend. Deploy the native protocol update and route /api requests through the gateway."
                    }
                    throw ApiException(if (response.code in 400..499) response.code else 502, message)
                }
                if (!response.isSuccessful) throw ApiException(response.code, when {
                    response.code == 401 -> "Your Kept session expired. Sign in again."
                    response.code == 403 -> "Access denied by the server or gateway. Check your certificate and account."
                    response.code in 300..399 -> "The server redirected this request. Use its final HTTPS address."
                    else -> runCatching { JSONObject(text).text("error") }.getOrDefault("Request failed (${response.code})").take(250)
                })
                text
            }
        } catch (error: ApiException) { throw error }
        catch (_: SSLException) { throw ApiException(-1, "Secure connection failed. Check the server certificate and the selected client certificate.") }
        catch (_: UnknownHostException) { throw ApiException(-1, "Server address could not be found. Check the URL and your network connection.") }
        catch (_: SocketTimeoutException) { throw ApiException(-1, "The server did not respond in time. Check your network and try again.") }
    }
    override suspend fun login(origin: String, username: String, password: String, totp: String, gatewayHeaders: String): JSONObject {
        val address = parseOrigin(origin)
        val targetOrigin = address.toString().trimEnd('/')
        val attempt = ConnectionSnapshot(targetOrigin, settings.aliasFor(targetOrigin), settings.aliasRevisionFor(targetOrigin), gatewayHeaders, settings.userId, "")
        val result = JSONObject(call("/api/auth/login", "POST", JSONObject().put("username", username).put("password", password)
            .put("totpToken", totp), attempt))
        val token = result.getString("token")
        val userId = result.getJSONObject("user").getLong("id")
        val authenticated = attempt.copy(userId = userId, token = token)
        val capabilities = try { JSONObject(call("/api/client/capabilities", connection = authenticated)) }
            catch (error: ApiException) {
                if (error.code == 404) throw ApiException(404, "This Kept server is too old for the native client. Update the server protocol first.")
                throw error
            }
        require(capabilities.optInt("nativeProtocolVersion") >= 3 && capabilities.optBoolean("noteRevisions") &&
            capabilities.optBoolean("personalReminders") && capabilities.optBoolean("reminderOccurrences") &&
            capabilities.optBoolean("reminderScheduleDefinitions")) {
            "This server needs the native-client protocol update."
        }
        return result
    }

    override suspend fun testConnection(origin: String, headers: String): String {
        val address = parseOrigin(origin)
        if (headers.isNotBlank()) JSONObject(headers)
        val targetOrigin = address.toString().trimEnd('/')
        val attempt = ConnectionSnapshot(targetOrigin, settings.aliasFor(targetOrigin), settings.aliasRevisionFor(targetOrigin), headers, settings.userId, "")
        val status = JSONObject(call("/api/setup/status", connection = attempt))
        return if (status.optBoolean("hasUsers")) "Connected securely. Kept is ready for sign-in."
        else "Connected securely. This Kept server needs initial setup."
    }

    private fun parseOrigin(origin: String) = origin.trim().toHttpUrl().also { address ->
        require(address.scheme == "https" || (BuildConfig.DEBUG && address.scheme == "http")) { "Use an HTTPS server address." }
        require(address.encodedPath == "/" && address.query == null && address.username.isEmpty() && address.password.isEmpty()) {
            "Use the server origin, without a path or credentials."
        }
    }
}
