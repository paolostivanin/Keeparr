package dev.keeparr.android.data

import java.io.EOFException
import java.io.IOException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLException

internal const val UNREACHABLE_MESSAGE = "Could not reach the server. Check your network connection."

// What the platform says when an established connection is cut, as opposed to a certificate or handshake being refused.
private val droppedConnection = listOf("connection reset", "connection closed", "connection abort", "broken pipe",
    "i/o error during system call", "unexpected end of stream")

/**
 * An HTML body where JSON was expected. 401/403 mean the gateway wants a sign-in or refused the request, a 5xx is a gateway error
 * page (Cloudflare 502/52x) for a server that is down or restarting, and anything else means the path is not reaching the backend.
 */
internal fun htmlGatewayFailure(code: Int, path: String): ApiException = when {
    code == 401 -> ApiException(401, "Your Keeparr session expired or the gateway requires sign-in. Check API routing, then authenticate again.")
    code == 403 -> ApiException(403, "The server or gateway denied this API request. Check its /api routing and access policy.")
    code >= 500 -> ApiException(code, "The Keeparr server is unavailable right now (HTTP $code).")
    else -> ApiException(if (code in 400..499) code else 502,
        "Keeparr's API returned HTML for $path (HTTP $code); this path is not reaching the Keeparr backend. Deploy the native protocol update and route /api requests through the gateway.")
}

/** A failed request that never produced an HTTP response. Code -1 marks it as a connection failure to every retry decision. */
internal fun transportFailure(error: IOException): ApiException {
    val chain = generateSequence<Throwable>(error) { it.cause }.take(8).toList()
    return when {
        chain.any { it is UnknownHostException } ->
            ApiException(-1, "Server address could not be found. Check the URL and your network connection.")
        chain.any { it is SocketTimeoutException } ->
            ApiException(-1, "The server did not respond in time. Check your network and try again.")
        // A reset or cut connection can surface as an SSLException; only a refused handshake or certificate is a certificate problem.
        error is SSLException && chain.none { cause -> cause is SocketException || cause is EOFException ||
            droppedConnection.any { cause.message?.contains(it, true) == true } } ->
            ApiException(-1, "Secure connection failed. Check the server certificate and the selected client certificate.")
        else -> ApiException(-1, UNREACHABLE_MESSAGE)
    }
}

/** What a failed sync means for the connection. */
internal fun connectionStateFor(error: Exception): ConnectionState {
    val message = error.message ?: "Connection unavailable"
    return when {
        error is ApiException && error.code == 401 -> ConnectionState.SessionExpired(message)
        error is ApiException && error.code == 403 -> ConnectionState.GatewayDenied(message)
        error is ApiException && error.code == 404 || message.contains("protocol", true) -> ConnectionState.Incompatible(message)
        message.contains("certificate", true) || message.contains("TLS", true) || message.contains("secure connection", true) ->
            ConnectionState.CertificateAttention(message)
        else -> ConnectionState.Offline(message)
    }
}

/** What a saved connection message says about the connection; null when it names no specific problem. */
internal fun connectionStateForMessage(message: String): ConnectionState? = when {
    message.contains("session expired", true) -> ConnectionState.SessionExpired(message)
    message.contains("denied", true) -> ConnectionState.GatewayDenied(message)
    message.contains("certificate", true) -> ConnectionState.CertificateAttention(message)
    message.contains("protocol", true) -> ConnectionState.Incompatible(message)
    else -> null
}
