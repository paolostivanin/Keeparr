package dev.keeparr.android.ui.editor

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChangeIgnoreConsumed
import androidx.compose.ui.unit.dp
import kotlin.math.abs

/**
 * What a touch that has moved ([dx], [dy]) since it went down means for a checklist row: 1 to indent (a swipe right), -1 to
 * outdent (a swipe left), 0 while it is still undecided, and null once it is clearly vertical (scrolling or reordering owns
 * it). A swipe has to be long enough and clearly more horizontal than vertical, so the wobble of a thumb does not count.
 */
internal fun swipeIndentStep(dx: Float, dy: Float, threshold: Float, slop: Float): Int? {
    val across = abs(dx)
    val down = abs(dy)
    if (down > slop && down >= across) return null
    if (across >= threshold && across >= 2 * down) return if (dx > 0f) 1 else -1
    return 0
}

/**
 * Swipe right or left on a row to indent or outdent it by one level. The gesture is watched in the initial pass, before the
 * text field underneath sees it, and only taken (the field is cancelled and the rest of the touch swallowed) once it is
 * decided to be a swipe: taps, cursor placement, text selection and vertical scrolling keep working untouched.
 */
@Composable
internal fun Modifier.indentSwipe(onSwipe: (step: Int) -> Unit): Modifier {
    val current by rememberUpdatedState(onSwipe)
    return pointerInput(Unit) {
        val threshold = 40.dp.toPx()
        val slop = viewConfiguration.touchSlop
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
            var moved = Offset.Zero
            while (true) {
                val change = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: return@awaitEachGesture
                if (!change.pressed) return@awaitEachGesture
                moved += change.positionChangeIgnoreConsumed()
                val step = swipeIndentStep(moved.x, moved.y, threshold, slop) ?: return@awaitEachGesture
                if (step == 0) continue
                change.consume()
                current(step)
                while (true) {
                    val rest = awaitPointerEvent(PointerEventPass.Initial).changes.firstOrNull { it.id == down.id } ?: return@awaitEachGesture
                    rest.consume()
                    if (!rest.pressed) return@awaitEachGesture
                }
            }
        }
    }
}
