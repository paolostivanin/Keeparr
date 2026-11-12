package dev.keeparr.android.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LargeTopAppBar
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.keeparr.android.ui.Dimens
import dev.keeparr.android.ui.Motion
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** Content that fills the width up to [maxWidth] and stays centered beyond it (tablets, landscape). */
internal fun Modifier.centeredMaxWidth(maxWidth: Dp = Dimens.contentMaxWidth): Modifier =
    fillMaxWidth().wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = maxWidth).fillMaxWidth()

/** The app's one snackbar queue. Only the topmost screen shows a host for it, so a message is never shown (or read) twice. */
internal val LocalSnackbarHostState = staticCompositionLocalOf<SnackbarHostState?> { null }

@Composable
internal fun KeeparrSnackbarHost(enabled: Boolean = true) {
    val state = LocalSnackbarHostState.current ?: return
    if (enabled) SnackbarHost(state)
}

/** How a screen arrives: a page slides in from the side, an opened note rises slightly. */
internal enum class ScreenEnter { Slide, Rise }

/**
 * A short entrance (fade plus a small slide) the first time this screen instance is shown. It runs on enter only: a leaving
 * screen is removed at once, never kept composed for an exit animation. Played state is saved, so re-creating the activity
 * (a theme change does) doesn't replay it.
 */
@Composable
internal fun Modifier.screenEnter(style: ScreenEnter = ScreenEnter.Slide): Modifier {
    var played by rememberSaveable { mutableStateOf(false) }
    val progress = remember { Animatable(if (played) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (!played) {
            progress.animateTo(1f, tween(Motion.SCREEN_ENTER, easing = Motion.EmphasizedDecelerate))
            played = true
        }
    }
    return graphicsLayer {
        val remaining = 1f - progress.value
        alpha = progress.value
        when (style) {
            ScreenEnter.Slide -> translationX = remaining * 32.dp.toPx()
            ScreenEnter.Rise -> translationY = remaining * 24.dp.toPx()
        }
    }
}

/** A secondary page (Settings, About): large collapsing title, back arrow, and the snackbar host. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SubpageScaffold(title: String, onBack: () -> Unit, modifier: Modifier = Modifier, content: @Composable (PaddingValues) -> Unit) {
    val scroll = TopAppBarDefaults.exitUntilCollapsedScrollBehavior()
    // On a wide screen the content is centered at a readable width; the title lines up with it rather than the window edge.
    val inset = ((LocalConfiguration.current.screenWidthDp.dp - Dimens.contentMaxWidth) / 2).coerceAtLeast(0.dp)
    Scaffold(modifier.nestedScroll(scroll.nestedScrollConnection), topBar = {
        LargeTopAppBar(title = { Text(title, Modifier.padding(start = inset), maxLines = 1, overflow = TextOverflow.Ellipsis) }, navigationIcon = {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") }
        }, scrollBehavior = scroll)
    }, snackbarHost = { KeeparrSnackbarHost() }, content = content)
}

/**
 * Runs suspend actions from UI callbacks and reports failures (other than cancellation) to [onError], with the exception's
 * message or a fallback. One per place that reports errors: a screen passes its error sink, a dialog its own inline error.
 */
@Stable
internal class ActionRunner(private val scope: CoroutineScope, private val onError: State<(String) -> Unit>) {
    operator fun invoke(fallback: String = "Action failed", block: suspend () -> Unit) {
        scope.launch {
            try { block() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (problem: Exception) { onError.value(problem.message ?: fallback) }
        }
    }
}

@Composable
internal fun rememberActionRunner(onError: (String) -> Unit): ActionRunner {
    val scope = rememberCoroutineScope()
    val current = rememberUpdatedState(onError)
    return remember(scope) { ActionRunner(scope, current) }
}
