package dev.keeparr.android.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.keeparr.android.ui.Dimens
import dev.keeparr.android.ui.Motion
import dev.keeparr.android.ui.Spacing
import dev.keeparr.android.ui.card
import dev.keeparr.android.ui.extendedColors
import kotlinx.coroutines.delay

/** A centered illustration-style message for a view with nothing in it. */
@Composable
internal fun EmptyState(icon: ImageVector, title: String, message: String, modifier: Modifier = Modifier) {
    Column(modifier.padding(horizontal = 40.dp, vertical = Spacing.xl).semantics(mergeDescendants = true) {},
        horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(96.dp).background(MaterialTheme.colorScheme.primary.copy(alpha = .12f), CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(44.dp), tint = MaterialTheme.colorScheme.primary)
        }
        Text(title, Modifier.padding(top = Spacing.lg + Spacing.xs), style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Text(message, Modifier.padding(top = Spacing.sm), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

/**
 * A centered spinner that only appears once loading has taken longer than [delayMillis], so fast loads (the usual case: the
 * notes come from the local database) never flash a spinner.
 */
@Composable
internal fun LoadingState(modifier: Modifier = Modifier, delayMillis: Long = 300) {
    var visible by remember { mutableStateOf(delayMillis <= 0) }
    LaunchedEffect(Unit) { delay(delayMillis); visible = true }
    Box(modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        AnimatedVisibility(visible, enter = fadeIn(tween(Motion.SLOW))) { CircularProgressIndicator() }
    }
}

internal enum class BannerTone { Info, Success, Warning, Error }

/**
 * An inline status message: a tinted container with an icon, the text, and an optional action. Errors and warnings are a
 * polite live region, so TalkBack reads them when they appear.
 */
@Composable
internal fun StatusBanner(text: String, modifier: Modifier = Modifier, tone: BannerTone = BannerTone.Info, title: String? = null,
    icon: ImageVector = tone.icon, actionLabel: String? = null, onAction: (() -> Unit)? = null, progress: Boolean = false) {
    val (container, content) = tone.colors()
    Surface(modifier.fillMaxWidth().semantics(mergeDescendants = true) {
        if (tone == BannerTone.Error || tone == BannerTone.Warning) liveRegion = LiveRegionMode.Polite
    }, shape = MaterialTheme.shapes.card, color = container, contentColor = content) {
        Column {
            Row(Modifier.heightIn(min = Dimens.minTouchTarget).padding(start = Spacing.lg, end = if (actionLabel != null) Spacing.xs else Spacing.lg,
                top = Spacing.sm, bottom = Spacing.sm), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                Icon(icon, null, Modifier.size(20.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xxs)) {
                    title?.let { Text(it, style = MaterialTheme.typography.labelLarge) }
                    Text(text, style = MaterialTheme.typography.bodyMedium)
                }
                if (actionLabel != null && onAction != null) {
                    TextButton(onClick = onAction, colors = ButtonDefaults.textButtonColors(contentColor = content)) { Text(actionLabel) }
                }
            }
            if (progress) LinearProgressIndicator(Modifier.fillMaxWidth(), color = content, trackColor = Color.Transparent)
        }
    }
}

private val BannerTone.icon: ImageVector get() = when (this) {
    BannerTone.Info -> Icons.Outlined.Info
    BannerTone.Success -> Icons.Outlined.CheckCircle
    BannerTone.Warning -> Icons.Outlined.WarningAmber
    BannerTone.Error -> Icons.Outlined.ErrorOutline
}

@Composable
private fun BannerTone.colors(): Pair<Color, Color> = when (this) {
    // Blue, so information never blends into a dialog or sheet (which use the surface containers) or reads as a warning.
    BannerTone.Info -> MaterialTheme.colorScheme.tertiaryContainer to MaterialTheme.colorScheme.onTertiaryContainer
    BannerTone.Success -> MaterialTheme.extendedColors.successContainer to MaterialTheme.extendedColors.onSuccessContainer
    BannerTone.Warning -> MaterialTheme.extendedColors.warningContainer to MaterialTheme.extendedColors.onWarningContainer
    BannerTone.Error -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
}
