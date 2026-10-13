package dev.keeparr.android.ui

import android.app.Activity
import android.app.UiModeManager
import android.content.Context
import android.content.ContextWrapper
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import android.view.View
import dev.keeparr.android.data.ThemeMode
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import dev.keeparr.android.R

// Colors mirror the web tokens in src/styles.scss: #202124 surface, #e8eaed text, #5f6368 border, #fbbc04 accent, #feefc3 accent container.
private val DarkColors = darkColorScheme(
    primary = Color(0xFFFFCF45), onPrimary = Color(0xFF202124),
    primaryContainer = Color(0xFF594400), onPrimaryContainer = Color(0xFFFEEFC3),
    secondary = Color(0xFFBDC1C6), onSecondary = Color(0xFF202124),
    secondaryContainer = Color(0xFFFEEFC3), onSecondaryContainer = Color(0xFF202124),
    tertiary = Color(0xFF8AB4F8), onTertiary = Color(0xFF202124),
    tertiaryContainer = Color(0xFF174EA6), onTertiaryContainer = Color(0xFFD2E3FC),
    background = Color(0xFF202124), onBackground = Color(0xFFE8EAED),
    surface = Color(0xFF202124), onSurface = Color(0xFFE8EAED),
    surfaceVariant = Color(0xFF3C4043), onSurfaceVariant = Color(0xFF9AA0A6),
    surfaceTint = Color(0xFF202124),
    inverseSurface = Color(0xFFE8EAED), inverseOnSurface = Color(0xFF202124), inversePrimary = Color(0xFF765900),
    outline = Color(0xFF80868B), outlineVariant = Color(0xFF5F6368),
    surfaceDim = Color(0xFF202124), surfaceBright = Color(0xFF3C4043),
    surfaceContainerLowest = Color(0xFF1B1C1E), surfaceContainerLow = Color(0xFF28292C), surfaceContainer = Color(0xFF303134),
    surfaceContainerHigh = Color(0xFF35363A), surfaceContainerHighest = Color(0xFF3C4043),
)

private val LightColors = lightColorScheme(
    primary = Color(0xFF765900), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFFEEFC3), onPrimaryContainer = Color(0xFF3F2E00),
    secondary = Color(0xFF5F6368), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFFEEFC3), onSecondaryContainer = Color(0xFF202124),
    tertiary = Color(0xFF1A73E8), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFE8F0FE), onTertiaryContainer = Color(0xFF174EA6),
    background = Color(0xFFFFFFFF), onBackground = Color(0xFF202124),
    surface = Color(0xFFFFFFFF), onSurface = Color(0xFF202124),
    surfaceVariant = Color(0xFFF1F3F4), onSurfaceVariant = Color(0xFF5F6368),
    surfaceTint = Color(0xFFFFFFFF),
    inverseSurface = Color(0xFF303134), inverseOnSurface = Color(0xFFF1F3F4), inversePrimary = Color(0xFFFFCF45),
    outline = Color(0xFF80868B), outlineVariant = Color(0xFFDADCE0),
    surfaceDim = Color(0xFFE8EAED), surfaceBright = Color(0xFFFFFFFF),
    surfaceContainerLowest = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFF8F9FA), surfaceContainer = Color(0xFFF1F3F4),
    surfaceContainerHigh = Color(0xFFEBEDF0), surfaceContainerHighest = Color(0xFFE3E5E8),
)

// Both families are bundled variable fonts (Latin and Latin-extended subsets, wght 400-700): no Play Services, no network.
@OptIn(ExperimentalTextApi::class)
private fun variable(resId: Int, weight: FontWeight) = Font(resId, weight, variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)))
private val GoogleSans = FontFamily(
    variable(R.font.google_sans, FontWeight.Normal), variable(R.font.google_sans, FontWeight.Medium),
    variable(R.font.google_sans, FontWeight.SemiBold), variable(R.font.google_sans, FontWeight.Bold))
private val Roboto = FontFamily(
    variable(R.font.roboto, FontWeight.Normal), variable(R.font.roboto, FontWeight.Medium), variable(R.font.roboto, FontWeight.Bold))

private fun style(family: FontFamily, weight: FontWeight, size: Int, line: Int, tracking: Float = 0f) =
    TextStyle(fontFamily = family, fontWeight = weight, fontSize = size.sp, lineHeight = line.sp, letterSpacing = tracking.sp)

// Material 3 sizes and line heights. Google Sans carries display, headline and title; Roboto carries body and label.
private val KeeparrTypography = Typography(
    displayLarge = style(GoogleSans, FontWeight.Normal, 57, 64, -.25f), displayMedium = style(GoogleSans, FontWeight.Normal, 45, 52),
    displaySmall = style(GoogleSans, FontWeight.Normal, 36, 44),
    headlineLarge = style(GoogleSans, FontWeight.Normal, 32, 40), headlineMedium = style(GoogleSans, FontWeight.Normal, 28, 36),
    headlineSmall = style(GoogleSans, FontWeight.Normal, 24, 32),
    titleLarge = style(GoogleSans, FontWeight.Medium, 22, 28), titleMedium = style(GoogleSans, FontWeight.Medium, 16, 24, .1f),
    titleSmall = style(GoogleSans, FontWeight.Medium, 14, 20, .1f),
    bodyLarge = style(Roboto, FontWeight.Normal, 16, 24, .3f), bodyMedium = style(Roboto, FontWeight.Normal, 14, 20, .2f),
    bodySmall = style(Roboto, FontWeight.Normal, 12, 16, .3f),
    labelLarge = style(Roboto, FontWeight.Medium, 14, 20, .1f), labelMedium = style(Roboto, FontWeight.Medium, 12, 16, .5f),
    labelSmall = style(Roboto, FontWeight.Medium, 11, 16, .5f),
)

// The web radii: 8 / 12 / 16, with 28 for pills and dialogs.
private val KeeparrShapes = Shapes(
    extraSmall = RoundedCornerShape(8.dp), small = RoundedCornerShape(12.dp), medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(28.dp), extraLarge = RoundedCornerShape(28.dp),
)

/** True while the app is drawn in its dark theme (which can differ from the system's: see ThemeMode). */
val LocalDarkTheme = staticCompositionLocalOf { false }

/**
 * Owns the status and navigation bar icon colors. They follow the app theme unless a screen (the note editor) overrides
 * them to match its own background; the override is removed when that screen leaves the composition.
 */
@Stable
class SystemBarsController internal constructor(private val view: View?) {
    private var themeDark = false
    private var overrideLightBackground: Boolean? = null

    internal fun theme(dark: Boolean) { themeDark = dark; apply() }

    /** [lightBackground] true draws dark icons, false light icons, null goes back to the theme. */
    fun override(lightBackground: Boolean?) { overrideLightBackground = lightBackground; apply() }

    private fun apply() {
        val view = view ?: return
        val window = view.context.findActivity()?.window ?: return
        val controller = WindowCompat.getInsetsController(window, view)
        val darkIcons = overrideLightBackground ?: !themeDark
        controller.isAppearanceLightStatusBars = darkIcons
        controller.isAppearanceLightNavigationBars = darkIcons
    }
}

val LocalSystemBars = staticCompositionLocalOf { SystemBarsController(null) }

/** Makes the system bar icons readable on a screen whose background is [lightBackground]; restored on dispose. */
@Composable
fun SystemBarsOverride(lightBackground: Boolean) {
    val bars = LocalSystemBars.current
    DisposableEffect(bars, lightBackground) {
        bars.override(lightBackground)
        onDispose { bars.override(null) }
    }
}

@Composable
fun KeeparrTheme(dark: Boolean, content: @Composable () -> Unit) {
    // enableEdgeToEdge() picks system bar icon colors from the system night mode, but the in-app theme can differ from it.
    val view = LocalView.current
    val bars = remember(view) { SystemBarsController(view.takeUnless { it.isInEditMode }) }
    SideEffect { bars.theme(dark) }
    CompositionLocalProvider(LocalDarkTheme provides dark, LocalSystemBars provides bars) {
        MaterialTheme(colorScheme = if (dark) DarkColors else LightColors, typography = KeeparrTypography, shapes = KeeparrShapes, content = content)
    }
}

/** The platform night mode for a ThemeMode, so platform dialogs and View resources match the app theme. */
internal fun nightModeFor(mode: ThemeMode): Int = when (mode) {
    ThemeMode.System -> UiModeManager.MODE_NIGHT_AUTO
    ThemeMode.Light -> UiModeManager.MODE_NIGHT_NO
    ThemeMode.Dark -> UiModeManager.MODE_NIGHT_YES
}

/** Follows [mode] with the application night mode (a no-op when it is already set). */
internal fun applyNightMode(context: Context, mode: ThemeMode) {
    context.getSystemService(UiModeManager::class.java)?.setApplicationNightMode(nightModeFor(mode))
}

private fun Context.findActivity(): Activity? = this as? Activity ?: (this as? ContextWrapper)?.baseContext?.findActivity()
