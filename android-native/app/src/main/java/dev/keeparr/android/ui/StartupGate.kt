package dev.keeparr.android.ui

/**
 * First-composition decisions that depend on persisted connection settings. They are pure functions of the
 * settings and an explicit user override so the stored session and theme apply in the very frame the settings
 * become ready, instead of one frame later through an effect.
 */
internal object StartupGate {
    fun signedIn(override: Boolean?, token: String) = override ?: token.isNotBlank()
    fun dark(override: Boolean?, stored: Boolean) = override ?: stored
}
