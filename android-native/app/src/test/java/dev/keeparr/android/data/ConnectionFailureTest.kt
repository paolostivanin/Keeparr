package dev.keeparr.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.EOFException
import java.net.ConnectException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.security.cert.CertPathValidatorException
import javax.net.ssl.SSLException
import javax.net.ssl.SSLHandshakeException

class ConnectionFailureTest {
    // Words that move a message into a state the widget treats as something to act on.
    private val stateWords = listOf("protocol", "certificate", "tls", "secure connection", "session expired", "denied")

    @Test fun aGatewayErrorPageIsAServerOutageNotAnIncompatibleServer() {
        for (code in listOf(500, 502, 503, 521, 522, 530)) {
            val failure = htmlGatewayFailure(code, "/api/sync/changes")
            assertEquals(code, failure.code)
            assertTrue(failure.message, stateWords.none { failure.message.contains(it, true) })
            assertTrue("HTTP $code", connectionStateFor(failure) is ConnectionState.Offline)
            assertNull("HTTP $code", connectionStateForMessage(failure.message))
        }
    }

    @Test fun htmlThatIsNotAGatewayErrorKeepsItsMeaning() {
        assertTrue(connectionStateFor(htmlGatewayFailure(401, "/api/x")) is ConnectionState.SessionExpired)
        assertTrue(connectionStateFor(htmlGatewayFailure(403, "/api/x")) is ConnectionState.GatewayDenied)
        assertTrue(connectionStateFor(htmlGatewayFailure(404, "/api/x")) is ConnectionState.Incompatible)
        val redirectedPage = htmlGatewayFailure(200, "/api/x")
        assertEquals(502, redirectedPage.code)
        assertTrue(connectionStateFor(redirectedPage) is ConnectionState.Incompatible)
    }

    @Test fun savedGatewayMessagesKeepTheirStateAfterARestart() {
        assertTrue(connectionStateForMessage(htmlGatewayFailure(401, "/api/x").message) is ConnectionState.SessionExpired)
        assertTrue(connectionStateForMessage(htmlGatewayFailure(403, "/api/x").message) is ConnectionState.GatewayDenied)
        assertTrue(connectionStateForMessage(htmlGatewayFailure(404, "/api/x").message) is ConnectionState.Incompatible)
        assertTrue(connectionStateForMessage("Access denied by the server or gateway. Check your certificate and account.") is ConnectionState.GatewayDenied)
        assertNull(connectionStateForMessage(""))
        assertNull(connectionStateForMessage(UNREACHABLE_MESSAGE))
    }

    @Test fun aRequestWithoutAResponseIsAConnectionFailureThatSaysWhatHappened() {
        val unknownHost = transportFailure(UnknownHostException("one.example.test"))
        val timeout = transportFailure(SocketTimeoutException("timeout"))
        val refused = transportFailure(ConnectException("Failed to connect to one.example.test/10.0.0.1:443"))

        assertTrue(unknownHost.message, unknownHost.message.contains("could not be found"))
        assertTrue(timeout.message, timeout.message.contains("did not respond"))
        assertEquals(UNREACHABLE_MESSAGE, refused.message)
        for (failure in listOf(unknownHost, timeout, refused)) {
            assertEquals(-1, failure.code)
            assertTrue(failure.message, connectionStateFor(failure) is ConnectionState.Offline)
        }
    }

    @Test fun aConnectionCutDuringTheHandshakeIsNotACertificateProblem() {
        val cut = listOf(
            SSLException("Connection closed by peer"),
            SSLHandshakeException("Connection reset"),
            SSLException("Read error: ssl=0x1: I/O error during system call, Connection reset by peer"),
            SSLException("Write error", SocketException("Broken pipe")),
            SSLException("Unexpected end", EOFException()),
            SSLException("Timed out", SocketTimeoutException("timeout")))
        for (error in cut) {
            val failure = transportFailure(error)
            assertEquals(-1, failure.code)
            assertTrue("${error.message} -> ${failure.message}", connectionStateFor(failure) is ConnectionState.Offline)
        }
    }

    @Test fun aRefusedHandshakeOrCertificateStaysACertificateProblem() {
        val untrusted = SSLHandshakeException("PKIX path building failed")
            .apply { initCause(CertPathValidatorException("Trust anchor for certification path not found.")) }
        val clientCertificateRequired = SSLHandshakeException("SSL handshake aborted: ssl=0x1: Failure in SSL library, usually a protocol error")
        for (error in listOf(untrusted, clientCertificateRequired)) {
            val failure = transportFailure(error)
            assertEquals(-1, failure.code)
            assertTrue(failure.message, connectionStateFor(failure) is ConnectionState.CertificateAttention)
        }
    }

    @Test fun otherSyncFailuresKeepTheirState() {
        assertTrue(connectionStateFor(ApiException(401, "Your Keeparr session expired. Sign in again.")) is ConnectionState.SessionExpired)
        assertTrue(connectionStateFor(ApiException(403, "Access denied by the server or gateway.")) is ConnectionState.GatewayDenied)
        assertTrue(connectionStateFor(ApiException(404, "This Keeparr server is too old.")) is ConnectionState.Incompatible)
        assertTrue(connectionStateFor(ApiException(503, "offline")) is ConnectionState.Offline)
        assertEquals(ConnectionState.Offline("Connection unavailable"), connectionStateFor(IllegalStateException()))
    }
}
