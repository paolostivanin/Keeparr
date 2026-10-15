package dev.keeparr.android.widgets

import dev.keeparr.android.data.UNREACHABLE_MESSAGE
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetStatusTest {
    private val hour = 60L * 60 * 1000
    private val now = 100 * hour

    private fun pill(message: String, lastSyncedAt: Long = now, signedIn: Boolean = true, at: Long = now, refreshing: Boolean = false) =
        widgetPill(signedIn, message, lastSyncedAt, at, refreshing) { "time@$it" }

    private val hard = mapOf(
        "Your Keeparr session expired. Sign in again." to "Sign in again",
        "Your Keeparr session expired or the gateway requires sign-in. Check API routing, then authenticate again." to "Sign in again",
        "Access denied by the server or gateway. Check your certificate and account." to "Access denied · open Keeparr",
        "The server or gateway denied this API request. Check its /api routing and access policy." to "Access denied · open Keeparr",
        "This Keeparr server is too old for the native client. Update the server protocol first." to "Server update needed")

    private val soft = listOf(
        UNREACHABLE_MESSAGE,
        "The Keeparr server is unavailable right now (HTTP 530).",
        "Server address could not be found. Check the URL and your network connection.",
        "The server did not respond in time. Check your network and try again.",
        "Secure connection failed. Check the server certificate and the selected client certificate.")

    @Test fun signedOutWinsOverAnyMessageAndOpensTheApp() {
        for (message in listOf("", UNREACHABLE_MESSAGE, "Your Keeparr session expired. Sign in again.")) {
            val shown = pill(message, signedIn = false)
            assertEquals("Open Keeparr to sign in", shown?.text)
            assertEquals(PillAction.OPEN_APP, shown?.action)
        }
    }

    @Test fun nothingSavedAndFreshOrNeverSyncedNotesMeanNoPill() {
        assertNull(pill(""))
        assertNull("signed in a moment ago: the first sync is on its way", pill("   ", lastSyncedAt = 0))
    }

    @Test fun notesThatHaveGoneStaleAreFlaggedEvenWhenNothingFailed() {
        assertNull(pill("", lastSyncedAt = now - 59 * 60 * 1000))
        val shown = pill("", lastSyncedAt = now - hour)
        assertEquals("Updated time@${now - hour}", shown?.text)
        assertEquals("Keeparr last synced at time@${now - hour}. Tap to sync now.", shown?.description)
        assertEquals(PillAction.REFRESH, shown?.action)
        assertEquals("a long time later it still says when", "Updated time@${now - 20 * hour}", pill("", lastSyncedAt = now - 20 * hour)?.text)
        assertNull("a time in the future counts as fresh", pill("", lastSyncedAt = now + 5 * hour))
    }

    @Test fun eachStateHasTheIconThatSaysWhatItIs() {
        assertEquals(PillIcon.WARNING, pill("", signedIn = false)?.icon)
        assertEquals(PillIcon.SYNC, pill("", refreshing = true)?.icon)
        for (message in hard.keys) assertEquals(message, PillIcon.WARNING, pill(message)?.icon)
        for (message in soft) assertEquals(message, PillIcon.OFFLINE, pill(message, lastSyncedAt = now - 2 * hour)?.icon)
        assertEquals(PillIcon.OFFLINE, pill(UNREACHABLE_MESSAGE, lastSyncedAt = 0)?.icon)
        assertEquals(PillIcon.SYNC, pill("", lastSyncedAt = now - 2 * hour)?.icon)
    }

    @Test fun problemsTheUserMustActOnShowAtOnceEvenRightAfterAGoodSync() {
        for ((message, text) in hard) {
            val shown = pill(message, lastSyncedAt = now)
            assertEquals(message, text, shown?.text)
            assertEquals(message, PillAction.OPEN_APP, shown?.action)
        }
    }

    @Test fun connectionTroubleStaysQuietUntilTheNotesHaveGoneStale() {
        for (message in soft) {
            assertNull(message, pill(message, lastSyncedAt = now - 59 * 60 * 1000))
            val shown = pill(message, lastSyncedAt = now - hour)
            assertEquals(message, "Offline · time@${now - hour}", shown?.text)
            assertEquals(message, PillAction.REFRESH, shown?.action)
        }
    }

    @Test fun aWidgetThatHasNeverSyncedSaysSoAtOnce() {
        val shown = pill(UNREACHABLE_MESSAGE, lastSyncedAt = 0)
        assertEquals("Offline", shown?.text)
        assertEquals(PillAction.REFRESH, shown?.action)
    }

    @Test fun aSyncTimeInTheFutureCountsAsFresh() {
        assertNull(pill(UNREACHABLE_MESSAGE, lastSyncedAt = now + 5 * hour))
    }

    @Test fun theSavedMessageIsOnlyClassifiedNeverShown() {
        val long = "x".repeat(5000)
        val shown = listOf(pill(long, lastSyncedAt = now - 2 * hour), pill("session expired $long"), pill("denied $long"),
            pill("protocol $long"), pill("certificate $long", lastSyncedAt = now - 2 * hour), pill(long, lastSyncedAt = 0))
        for (candidate in shown) {
            assertNotNull(candidate)
            assertTrue(candidate!!.text, candidate.text.length <= 32)
            assertTrue(candidate.description, candidate.description.length <= 100)
        }
    }

    @Test fun aTapsSyncInProgressSaysSoWhateverElseIsSavedExceptBeingSignedOut() {
        for (message in listOf("", UNREACHABLE_MESSAGE, hard.keys.first())) {
            for (synced in listOf(0L, now, now - 5 * hour)) {
                val shown = pill(message, lastSyncedAt = synced, refreshing = true)
                assertEquals("Syncing…", shown?.text)
                assertEquals(PillAction.REFRESH, shown?.action)
            }
        }
        assertEquals("Open Keeparr to sign in", pill("", signedIn = false, refreshing = true)?.text)
        assertNull("without a refresh the same state shows nothing", pill("", refreshing = false))
    }

    @Test fun everyPillTextFitsOneLineOfTheWidget() {
        val formatted = widgetPill(true, UNREACHABLE_MESSAGE, now - 3 * hour, now) { "Wed 12:34 PM" }
        val updated = widgetPill(true, "", now - 3 * hour, now) { "Wed 12:34 PM" }
        val all = hard.keys.map { pill(it) } + soft.map { pill(it, lastSyncedAt = now - 3 * hour) } + formatted + updated +
            pill("", signedIn = false) + pill("", refreshing = true) + pill("", lastSyncedAt = now - 3 * hour)
        all.filterNotNull().forEach { assertTrue(it.text, it.text.length <= 32) }
        all.filterNotNull().forEach { assertTrue(it.description, it.description.length <= 100) }
    }
}
