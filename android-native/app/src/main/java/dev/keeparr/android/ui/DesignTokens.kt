package dev.keeparr.android.ui

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.ui.unit.dp

/**
 * Keeparr's spacing scale. Every padding and gap in the app is one of these steps (or a [Dimens] role built from them), so
 * screens line up with each other instead of each picking its own numbers.
 */
internal object Spacing {
    val xxs = 2.dp
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
}

/** Layout roles: what a size is for, rather than how big it is. */
internal object Dimens {
    /** Horizontal margin of full-screen content (settings groups, forms, banners). */
    val screenGutter = Spacing.lg
    /** Inner padding of a note card and of tonal groups. */
    val cardPadding = Spacing.md
    /** Gap between note cards, both ways. */
    val gridGutter = Spacing.sm
    /** The narrowest a note card column gets before the grid drops a column. */
    val noteMinColumn = 170.dp
    /** Forms (sign in) stop growing here on tablets and in landscape. */
    val formMaxWidth = 560.dp
    /** Reading and editing content (settings, list mode, the editor) stops growing here. */
    val contentMaxWidth = 720.dp
    val minTouchTarget = 48.dp
    val iconSmall = 18.dp
    val iconMedium = 24.dp
    /** Height of the search pill and the contextual selection bar that replaces it. */
    val searchBarHeight = 56.dp
    /** The left column of a checklist row (its drag grip); the "List item" button and completed header align to it. */
    val checklistGripWidth = 32.dp
}

/** Durations and easing, mirroring the web's motion tokens in src/styles.scss. */
internal object Motion {
    const val FAST = 80
    const val BASE = 120
    const val SLOW = 200
    const val ENTER = 150
    const val EXIT = 100
    /** Screen entrances run a little longer than component feedback. */
    const val SCREEN_ENTER = 220
    val Standard: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val EmphasizedDecelerate: Easing = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val EmphasizedAccelerate: Easing = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
}
