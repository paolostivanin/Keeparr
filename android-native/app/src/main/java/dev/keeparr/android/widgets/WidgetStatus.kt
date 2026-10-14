package dev.keeparr.android.widgets

import dev.keeparr.android.data.ConnectionState
import dev.keeparr.android.data.connectionStateForMessage

/** What a tap on the widget's status pill does. */
enum class PillAction { REFRESH, OPEN_APP }

/** The status pill: [text] is short enough for one line, [description] is the full sentence for accessibility. */
data class Pill(val text: String, val description: String, val action: PillAction)

/** A failed sync stays off the widget until the last good one is this old; the notes shown are still the saved ones. */
internal const val OFFLINE_GRACE_MS = 60L * 60 * 1000

/**
 * The pill reports what the user can act on. Signing in again, access and server-version problems show at once. Connection
 * trouble shows only once the notes have gone stale, with the time of the last sync, because overnight a phone is routinely
 * unreachable and the widget is fine. The saved message is only classified, never shown: its text is unbounded.
 */
internal fun widgetPill(signedIn: Boolean, message: String, lastSyncedAt: Long, now: Long, formatTime: (Long) -> String): Pill? {
    if (!signedIn) return Pill("Open Keeparr to sign in", "Open Keeparr to sign in", PillAction.OPEN_APP)
    if (message.isBlank()) return null
    return when (connectionStateForMessage(message)) {
        is ConnectionState.SessionExpired ->
            Pill("Sign in again", "Your Keeparr session expired. Open Keeparr to sign in again.", PillAction.OPEN_APP)
        is ConnectionState.GatewayDenied ->
            Pill("Access denied · open Keeparr", "The server or gateway denied access. Open Keeparr to check your account.", PillAction.OPEN_APP)
        is ConnectionState.Incompatible ->
            Pill("Server update needed", "This Keeparr server needs a protocol update. Open Keeparr for details.", PillAction.OPEN_APP)
        else -> when {
            lastSyncedAt <= 0L -> Pill("Offline", "Keeparr has not synced yet. Tap to try again.", PillAction.REFRESH)
            now - lastSyncedAt < OFFLINE_GRACE_MS -> null
            else -> formatTime(lastSyncedAt).let { Pill("Offline · $it", "Keeparr could not sync since $it. Tap to try again.", PillAction.REFRESH) }
        }
    }
}
