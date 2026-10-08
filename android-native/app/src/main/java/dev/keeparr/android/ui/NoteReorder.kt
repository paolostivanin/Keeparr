package dev.keeparr.android.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.withFrameNanos
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

internal data class NoteDrop(val sourceId: String, val targetId: String)

/**
 * State and rules of one note-reorder drag, independent of Compose input handling so they can be tested.
 *
 * Card geometry lives in a plain map: reporting a card's bounds must not invalidate composition (it used to be a snapshot
 * map that every card read as a pointer-input key, so any layout change restarted every card's gesture). Only the composed
 * (visible) cards report bounds, so hit testing can only ever pick a visible target. [canDrop] carries the rule that a note
 * stays in its pinned/other group. Only [draggingId] and [targetId] are observable, for highlighting.
 */
internal class NoteReorderController(private val canDrop: (sourceId: String, targetId: String) -> Boolean) {
    private val bounds = HashMap<String, Rect>()
    private var lastPoint: Offset? = null
    var draggingId by mutableStateOf<String?>(null)
        private set
    var targetId by mutableStateOf<String?>(null)
        private set

    fun positioned(id: String, rect: Rect) { bounds[id] = rect }
    fun disposed(id: String) { bounds.remove(id) }

    fun idAt(point: Offset): String? = bounds.entries.firstOrNull { it.value.contains(point) }?.key

    /** Begins dragging the visible card under [point]; false when no card is there. */
    fun start(point: Offset): Boolean {
        val source = idAt(point) ?: return false
        draggingId = source
        targetId = null
        lastPoint = point
        return true
    }

    fun move(point: Offset) {
        val source = draggingId ?: return
        lastPoint = point
        // Over a gap between cards the previous target stays; over the source or a forbidden target it is cleared.
        val hit = idAt(point) ?: return
        targetId = hit.takeIf { it != source && canDrop(source, it) }
    }

    /** Re-evaluates the target after the content moved under a stationary pointer (autoscroll). */
    fun refresh() { lastPoint?.let(::move) }

    /**
     * Pixels to scroll this frame (negative scrolls toward the start): nothing unless dragging, ramping up linearly from
     * zero at [edge] pixels inside the viewport's top/bottom to [maxStep] at and beyond the edge itself.
     */
    fun autoScrollDelta(viewport: Rect, edge: Float, maxStep: Float): Float {
        val point = lastPoint ?: return 0f
        if (draggingId == null || edge <= 0f) return 0f
        val fromTop = point.y - viewport.top
        val fromBottom = viewport.bottom - point.y
        return when {
            fromTop < edge -> -maxStep * ((edge - fromTop) / edge).coerceIn(0f, 1f)
            fromBottom < edge -> maxStep * ((edge - fromBottom) / edge).coerceIn(0f, 1f)
            else -> 0f
        }
    }

    /** Ends the drag; a drop is reported once, and only when it landed on an allowed target. */
    fun finish(): NoteDrop? {
        val source = draggingId
        val target = targetId
        reset()
        return if (source != null && target != null) NoteDrop(source, target) else null
    }

    fun cancel() = reset()

    private fun reset() {
        draggingId = null
        targetId = null
        lastPoint = null
    }
}

/**
 * Long-press-then-drag reordering for the whole grid, with autoscroll near its top and bottom edges. The gesture is owned by
 * the grid rather than by each card: a card that scrolls out of composition mid-drag would otherwise cancel the gesture,
 * and no card's input node restarts when others come and go. The drag is tracked in the initial pass so the grid's own
 * scrolling does not also react to the same moves; a competing scroll cancels the long press before it starts.
 */
@Composable
internal fun Modifier.noteReorderGestures(controller: NoteReorderController, enabled: Boolean, grid: () -> LayoutCoordinates?,
    scrollBy: suspend (Float) -> Unit, onDrop: (NoteDrop) -> Unit): Modifier {
    val currentGrid by rememberUpdatedState(grid)
    val currentScroll by rememberUpdatedState(scrollBy)
    val currentDrop by rememberUpdatedState(onDrop)
    return if (!enabled) this else pointerInput(controller) {
        val edge = 72.dp.toPx()
        val maxStep = 24.dp.toPx()
        coroutineScope {
        val scope = this
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            fun window(local: Offset): Offset? = currentGrid()?.takeIf { it.isAttached }?.localToWindow(local)
            val origin = window(down.position) ?: return@awaitEachGesture
            if (controller.idAt(origin) == null) return@awaitEachGesture
            if (awaitLongPressOrCancellation(down.id) == null) return@awaitEachGesture
            if (!controller.start(origin)) return@awaitEachGesture
            val autoscroll = scope.launch {
                while (isActive) {
                    withFrameNanos { }
                    controller.refresh()
                    val viewport = currentGrid()?.takeIf { it.isAttached }?.let { grid ->
                        Rect(grid.localToWindow(Offset.Zero), grid.localToWindow(Offset(grid.size.width.toFloat(), grid.size.height.toFloat())))
                    }
                    val delta = viewport?.let { controller.autoScrollDelta(it, edge, maxStep) } ?: 0f
                    if (delta != 0f) currentScroll(delta)
                }
            }
            var drop: NoteDrop? = null
            try {
                while (true) {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                    val change = event.changes.firstOrNull { it.id == down.id } ?: break
                    if (!change.pressed) { drop = controller.finish(); break }
                    window(change.position)?.let(controller::move)
                    change.consume()
                }
            } finally {
                autoscroll.cancel()
                controller.cancel()
            }
            drop?.let(currentDrop)
        }
        }
    }
}
