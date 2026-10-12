package dev.keeparr.android.ui

import dev.keeparr.android.data.ThemeMode

/**
 * First-composition decisions that depend on persisted connection settings. They are pure functions of the
 * settings and an explicit user override so the stored session and theme apply in the very frame the settings
 * become ready, instead of one frame later through an effect.
 */
internal object StartupGate {
    fun signedIn(override: Boolean?, token: String) = override ?: token.isNotBlank()
    /** Until the settings are read the system theme applies, so a default install never paints a light frame on a dark system. */
    fun mode(override: ThemeMode?, stored: ThemeMode) = override ?: stored
    fun dark(override: ThemeMode?, stored: ThemeMode?, systemDark: Boolean) = (override ?: stored ?: ThemeMode.System).isDark(systemDark)
}
