package dev.keeparr.android.ui

import android.widget.EditText
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.toArgb
import dev.keeparr.android.data.NotePalette

/** The link color for the note being edited; the EditText is a View and cannot read the Compose theme. */
internal val LocalNoteLinkColor = staticCompositionLocalOf { NotePalette.LINK_LIGHT_THEME }

private val AccentOnDark = Color(0xFFFFCF45)
private val AccentOnLight = Color(0xFF765900)
private val DeepAccentOnLight = Color(0xFF4D3900)
private const val MIN_TEXT_CONTRAST = 4.5

/**
 * Accent (primary) for TextButtons, checkboxes and the pinned icon on a note background: `#FFCF45` on dark and `#765900`
 * on light backgrounds, which is the plan's choice. A few pastels (Lavender, Creamsicle) leave `#765900` below 4.5:1,
 * so a deeper amber and finally the text color itself take over there.
 */
internal fun noteAccent(background: Color, foreground: Color): Color {
    val bg = background.toArgb()
    val dark = NotePalette.textColor(bg) == NotePalette.TEXT_DARK_THEME
    return listOf(if (dark) AccentOnDark else AccentOnLight, DeepAccentOnLight, foreground)
        .first { NotePalette.contrast(it.toArgb(), bg) >= MIN_TEXT_CONTRAST || it == foreground }
}

/** The color scheme for controls drawn over a note: surface and onSurface are the note's, so they stay readable. */
internal fun noteColorScheme(base: ColorScheme, background: Color, foreground: Color): ColorScheme {
    val accent = noteAccent(background, foreground)
    // Menus and sheets need to stand out from the note itself, so the container roles lean slightly toward the text color.
    fun container(amount: Float) = lerp(background, foreground, amount)
    return base.copy(
        primary = accent, onPrimary = background,
        primaryContainer = container(.12f), onPrimaryContainer = foreground,
        secondary = foreground, onSecondary = background,
        secondaryContainer = container(.12f), onSecondaryContainer = foreground,
        background = background, onBackground = foreground,
        surface = background, onSurface = foreground,
        surfaceVariant = container(.08f), onSurfaceVariant = foreground,
        surfaceTint = background,
        outline = foreground.copy(alpha = .6f), outlineVariant = foreground.copy(alpha = .2f),
        surfaceDim = background, surfaceBright = background,
        surfaceContainerLowest = background, surfaceContainerLow = container(.04f), surfaceContainer = container(.08f),
        surfaceContainerHigh = container(.1f), surfaceContainerHighest = container(.12f),
    )
}

/** Overrides the color scheme for a note's editor: top bar, bottom bar, toolbar, checkboxes, menus and buttons follow [background]. */
@Composable
internal fun NoteSurfaceTheme(background: Color, foreground: Color, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalNoteLinkColor provides NotePalette.linkColor(background.toArgb())) {
        MaterialTheme(colorScheme = noteColorScheme(MaterialTheme.colorScheme, background, foreground),
            typography = MaterialTheme.typography, shapes = MaterialTheme.shapes, content = content)
    }
}

/** Hint, link, selection highlight and cursor colors for the body EditText, so none of them keep the platform's light-theme defaults. */
internal fun EditText.applyNoteColors(foreground: Int, link: Int) {
    setTextColor(foreground)
    setHintTextColor((foreground and 0xFFFFFF) or (0x99 shl 24))
    setLinkTextColor(link)
    highlightColor = (foreground and 0xFFFFFF) or (0x4D shl 24)
    textCursorDrawable?.mutate()?.let { it.setTint(foreground); textCursorDrawable = it }
}
