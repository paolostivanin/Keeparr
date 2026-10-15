package dev.keeparr.android.widgets

import dev.keeparr.android.data.ConnectionState
import dev.keeparr.android.data.connectionStateForMessage

/** What a tap on the widget's status chip does. */
enum class PillAction { REFRESH, OPEN_APP }

/** The glyph on the chip: sync arrows, the same with a mark when the last try failed, and a warning for what needs the app. */
enum class PillIcon { SYNC, OFFLINE, WARNING }

/** The status chip: [text] is short enough for one line, [description] is the full sentence for accessibility. */
data class Pill(val text: String, val description: String, val action: PillAction, val icon: PillIcon)

/** The saved notes count as stale once the last good sync is this old; the notes shown are still the saved ones. */
internal const val STALE_AFTER_MS = 60L * 60 * 1000

/**
 * The chip reports what the user can act on. Signing in again, access and server-version problems show at once. Connection
 * trouble shows only once the notes have gone stale, with the time of the last sync, because overnight a phone is routinely
 * unreachable and the widget is fine. Stale notes are flagged even when nothing failed, because a phone without data never
 * fails a sync. The saved message is only classified, never shown: its text is unbounded. While a tap's sync is [refreshing]
 * the chip says so, whatever else is saved.
 */
internal fun widgetPill(signedIn: Boolean, message: String, lastSyncedAt: Long, now: Long, refreshing: Boolean = false,
    formatTime: (Long) -> String): Pill? {
    if (!signedIn) return Pill("Open Keeparr to sign in", "Open Keeparr to sign in", PillAction.OPEN_APP, PillIcon.WARNING)
    if (refreshing) return Pill("Syncing…", "Keeparr is syncing now.", PillAction.REFRESH, PillIcon.SYNC)
    val stale = lastSyncedAt > 0L && now - lastSyncedAt >= STALE_AFTER_MS
    if (message.isBlank()) return if (!stale) null else formatTime(lastSyncedAt).let {
        Pill("Updated $it", "Keeparr last synced at $it. Tap to sync now.", PillAction.REFRESH, PillIcon.SYNC)
    }
    return when (connectionStateForMessage(message)) {
        is ConnectionState.SessionExpired ->
            Pill("Sign in again", "Your Keeparr session expired. Open Keeparr to sign in again.", PillAction.OPEN_APP, PillIcon.WARNING)
        is ConnectionState.GatewayDenied ->
            Pill("Access denied · open Keeparr", "The server or gateway denied access. Open Keeparr to check your account.", PillAction.OPEN_APP, PillIcon.WARNING)
        is ConnectionState.Incompatible ->
            Pill("Server update needed", "This Keeparr server needs a protocol update. Open Keeparr for details.", PillAction.OPEN_APP, PillIcon.WARNING)
        else -> when {
            lastSyncedAt <= 0L -> Pill("Offline", "Keeparr has not synced yet. Tap to try again.", PillAction.REFRESH, PillIcon.OFFLINE)
            !stale -> null
            else -> formatTime(lastSyncedAt).let {
                Pill("Offline · $it", "Keeparr could not sync since $it. Tap to try again.", PillAction.REFRESH, PillIcon.OFFLINE)
            }
        }
    }
}
