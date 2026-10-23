package dev.keeparr.android.ui.editor

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitVerticalTouchSlopOrCancellation
import androidx.compose.foundation.gestures.verticalDrag
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.unit.dp
import dev.keeparr.android.ui.edgeScrollDelta
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/** A finished drag: [id] goes before [beforeId], or to the end for null (the arguments of `ChecklistModel.moveBefore`). */
internal data class ChecklistMove(val id: Long, val beforeId: Long?)

/**
 * State and rules of one checklist-row drag, independent of Compose input handling so they can be tested.
 *
 * The rows stay where they are while one is dragged: [order] is only the preview of where the others would make room, and
 * [offset] is how far the dragged row has been pulled from its slot in that preview, so a swap re-bases it by the height of
 * the row it passed. Heights live in a plain map fed from the rows' size callbacks; they are read at drag time, never during
 * composition. Rows touch each other (no spacing), which is what the swap arithmetic assumes.
 */
internal class ChecklistDragController {
    private val heights = HashMap<Long, Float>()
    private var started: List<Long> = emptyList()

    var draggingId by mutableStateOf<Long?>(null)
        private set
    /** The dragged row's translation from its slot; read inside a graphics layer so a drag never recomposes. */
    var offset by mutableFloatStateOf(0f)
        private set
    /** Visible row ids as previewed during a drag, and after it until the draft shows the same order. */
    var order by mutableStateOf<List<Long>?>(null)
        private set
    /** Window height of the pointer, for autoscroll. */
    var pointerY = 0f

    fun sized(id: Long, height: Float) { heights[id] = height }
    fun disposed(id: Long) { heights.remove(id) }
    private fun height(id: Long) = heights[id] ?: 0f
    private fun extent(ids: List<Long>) = ids.fold(0f) { total, id -> total + height(id) }

    /** Begins dragging [id] among the visible rows [visibleIds]; false when it is not one of them. */
    fun start(id: Long, visibleIds: List<Long>): Boolean {
        if (id !in visibleIds) return false
        draggingId = id
        started = visibleIds
        order = visibleIds
        offset = 0f
        return true
    }

    /** Pulls the dragged row by [dy], making room as it passes its neighbours' midpoints; it never leaves the list. */
    fun drag(dy: Float) {
        val id = draggingId ?: return
        var list = order ?: return
        var index = list.indexOf(id)
        var pulled = offset + dy
        val own = height(id)
        // A row that has not been measured yet counts as zero tall; it would otherwise be passed by any movement.
        while (own > 0f && index < list.lastIndex) {
            val next = list[index + 1]
            val room = height(next)
            if (room <= 0f || pulled <= (own + room) / 2) break
            list = swapped(list, index, index + 1); pulled -= room; index++
        }
        while (own > 0f && index > 0) {
            val previous = list[index - 1]
            val room = height(previous)
            if (room <= 0f || pulled >= -(own + room) / 2) break
            list = swapped(list, index, index - 1); pulled += room; index--
        }
        offset = pulled.coerceIn(-extent(list.subList(0, index)), extent(list.subList(index + 1, list.size)))
        if (list !== order) order = list
    }

    /** The list scrolled by [consumed] pixels under a still pointer: the row goes with it, like the finger. */
    fun scrolled(consumed: Float) = drag(consumed)

    /** Whether the dragged row can still travel [direction] (positive is down); autoscroll stops once it cannot. */
    fun canFollow(direction: Float): Boolean {
        val id = draggingId ?: return false
        val list = order ?: return false
        val index = list.indexOf(id)
        return if (direction > 0f) offset < extent(list.subList(index + 1, list.size)) else offset > -extent(list.subList(0, index))
    }

    /**
     * Ends the drag. The move to commit, or null when the row went back where it was. The preview stays until the note's
     * rows show the same order, so the old order does not flash back while the change is on its way.
     */
    fun finish(): ChecklistMove? {
        val id = draggingId ?: return null
        val list = order
        draggingId = null
        offset = 0f
        if (list == null || list == started) { order = null; return null }
        return ChecklistMove(id, list.getOrNull(list.indexOf(id) + 1))
    }

    fun cancel() {
        draggingId = null
        offset = 0f
        order = null
    }

    /** Forgets a preview that was never going to be confirmed (the move was refused). */
    fun discardPreview() { if (draggingId == null) order = null }

    /** The ids to show: the preview while it still describes these rows, else [visibleIds]. */
    fun shown(visibleIds: List<Long>): List<Long> =
        order?.takeIf { it.size == visibleIds.size && it.toSet() == visibleIds.toSet() } ?: visibleIds

    /** Called with the rows as the note has them: a drag over rows that changed ends, and a confirmed preview is dropped. */
    fun reconcile(visibleIds: List<Long>) {
        val preview = order ?: return
        val sameRows = preview.size == visibleIds.size && preview.toSet() == visibleIds.toSet()
        when {
            !sameRows -> cancel()
            draggingId == null && preview == visibleIds -> order = null
        }
    }

    private fun swapped(list: List<Long>, a: Int, b: Int): List<Long> = list.toMutableList().also { it[a] = list[b]; it[b] = list[a] }
}

/**
 * Drags one checklist row by its grip, with autoscroll near the top and bottom edges of [viewport]. The grip takes the
 * gesture from the first touch: the down is consumed so the editor's click-to-focus never sees a tap on it, every move is
 * consumed so the editor's own scroll stays out, and the whole distance since the touch is applied at once so the row does
 * not trail the finger by the touch slop. A drag whose row disappears (sync, hiding completed rows, closing the note) is
 * cancelled rather than left running.
 */
@Composable
internal fun Modifier.checklistDragHandle(id: Long, controller: ChecklistDragController, visibleIds: () -> List<Long>,
    viewport: () -> Rect?, scrollBy: suspend (Float) -> Float, onStart: () -> Unit, onDrop: (ChecklistMove) -> Boolean): Modifier {
    val currentIds by rememberUpdatedState(visibleIds)
    val currentViewport by rememberUpdatedState(viewport)
    val currentScroll by rememberUpdatedState(scrollBy)
    val currentStart by rememberUpdatedState(onStart)
    val currentDrop by rememberUpdatedState(onDrop)
    val grip = remember { arrayOfNulls<LayoutCoordinates>(1) }
    return onGloballyPositioned { grip[0] = it }.pointerInput(id, controller) {
        val edge = 72.dp.toPx()
        val maxStep = 24.dp.toPx()
        coroutineScope {
            val scope = this
            awaitEachGesture {
                var autoscroll: Job? = null
                try {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    down.consume()
                    val crossed = awaitVerticalTouchSlopOrCancellation(down.id) { change, _ -> change.consume() }
                        ?: return@awaitEachGesture
                    fun windowY(local: Offset) = grip[0]?.takeIf { it.isAttached }?.localToWindow(local)?.y ?: controller.pointerY
                    if (!controller.start(id, currentIds())) return@awaitEachGesture
                    currentStart()
                    controller.pointerY = windowY(crossed.position)
                    controller.drag(crossed.position.y - down.position.y)
                    autoscroll = scope.launch {
                        while (isActive) {
                            withFrameNanos { }
                            val bounds = currentViewport() ?: continue
                            val delta = edgeScrollDelta(controller.pointerY, bounds.top, bounds.bottom, edge, maxStep)
                            if (delta != 0f && controller.canFollow(delta)) controller.scrolled(currentScroll(delta))
                        }
                    }
                    val released = verticalDrag(crossed.id) { change ->
                        // A consumed change reports no movement, so the distance is read before taking the event.
                        val moved = change.positionChange().y
                        change.consume()
                        controller.pointerY = windowY(change.position)
                        controller.drag(moved)
                    }
                    if (released) controller.finish()?.let { if (!currentDrop(it)) controller.discardPreview() } else controller.cancel()
                } finally {
                    autoscroll?.cancel()
                    if (controller.draggingId == id) controller.cancel()
                }
            }
        }
    }
}
