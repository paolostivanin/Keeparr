package dev.keeparr.android.ui.editor

import dev.keeparr.android.ui.edgeScrollDelta
import org.junit.Assert.*
import org.junit.Test

class ChecklistDragTest {
    private fun controller(vararg heights: Pair<Long, Float>) =
        ChecklistDragController().also { controller -> heights.forEach { controller.sized(it.first, it.second) } }

    private fun threeRows() = controller(1L to 100f, 2L to 100f, 3L to 100f)

    @Test fun aRowOnlyMakesRoomOncePastTheMiddleOfItsNeighbour() {
        val drag = threeRows()
        assertTrue(drag.start(1, listOf(1, 2, 3)))
        drag.drag(60f)
        assertEquals(listOf<Long>(1, 2, 3), drag.order)
        assertEquals(60f, drag.offset, 0f)
        drag.drag(40f)
        assertEquals("exactly at the midpoint is not past it", listOf<Long>(1, 2, 3), drag.order)
        drag.drag(1f)
        assertEquals(listOf<Long>(2, 1, 3), drag.order)
        assertEquals("the offset is now measured from the new slot", 1f, drag.offset, 0f)
    }

    @Test fun neighboursOfDifferentHeightsDecideWhenToSwap() {
        val drag = controller(1L to 100f, 2L to 40f, 3L to 60f)
        drag.start(1, listOf(1, 2, 3))
        drag.drag(70f)
        assertEquals(listOf<Long>(1, 2, 3), drag.order)
        drag.drag(1f)
        assertEquals(listOf<Long>(2, 1, 3), drag.order)
        assertEquals(31f, drag.offset, 0.001f)
        drag.drag(50f)
        assertEquals("the next neighbour is 60 tall: passing its middle takes (100 + 60) / 2", listOf<Long>(2, 3, 1), drag.order)
        assertEquals("the last slot is as far down as it goes", 0f, drag.offset, 0f)
    }

    @Test fun draggingUpMirrorsDraggingDown() {
        val drag = threeRows()
        drag.start(3, listOf(1, 2, 3))
        drag.drag(-100f)
        assertEquals(listOf<Long>(1, 2, 3), drag.order)
        drag.drag(-1f)
        assertEquals(listOf<Long>(1, 3, 2), drag.order)
        assertEquals(-1f, drag.offset, 0f)
        drag.drag(-150f)
        assertEquals(listOf<Long>(3, 1, 2), drag.order)
    }

    @Test fun aRowCannotBeDraggedOutOfTheList() {
        val drag = threeRows()
        drag.start(2, listOf(1, 2, 3))
        drag.drag(-10_000f)
        assertEquals(listOf<Long>(2, 1, 3), drag.order)
        assertEquals("the top of the first row is as far as it goes", 0f, drag.offset, 0f)
        drag.drag(10_000f)
        assertEquals(listOf<Long>(1, 3, 2), drag.order)
        assertEquals(0f, drag.offset, 0f)
    }

    @Test fun aRowThatWasNeverMeasuredIsNotPassed() {
        val drag = controller(1L to 100f)
        drag.start(1, listOf(1, 2, 3))
        drag.drag(500f)
        assertEquals(listOf<Long>(1, 2, 3), drag.order)
    }

    @Test fun scrollingUnderAStillFingerCarriesTheRowAlong() {
        val drag = threeRows()
        drag.start(1, listOf(1, 2, 3))
        drag.scrolled(101f)
        assertEquals(listOf<Long>(2, 1, 3), drag.order)
        assertTrue(drag.canFollow(1f))
        assertTrue(drag.canFollow(-1f))
        drag.scrolled(500f)
        assertEquals(listOf<Long>(2, 3, 1), drag.order)
        assertFalse("autoscroll stops once the row is at the end", drag.canFollow(1f))
        assertTrue(drag.canFollow(-1f))
    }

    @Test fun autoscrollCannotFollowPastTheFirstRow() {
        val drag = threeRows()
        drag.start(1, listOf(1, 2, 3))
        assertFalse(drag.canFollow(-1f))
        assertTrue(drag.canFollow(1f))
        assertFalse("nothing is dragged after the drag ended", ChecklistDragController().canFollow(1f))
    }

    @Test fun aDropNamesTheRowItNowSitsBefore() {
        val down = threeRows()
        down.start(1, listOf(1, 2, 3))
        down.drag(101f)
        assertEquals(ChecklistMove(1, 3), down.finish())
        assertNull("the drag is over", down.draggingId)
        assertEquals(0f, down.offset, 0f)

        val end = threeRows()
        end.start(1, listOf(1, 2, 3))
        end.drag(1_000f)
        assertEquals("the end is a null target", ChecklistMove(1, null), end.finish())

        val up = threeRows()
        up.start(3, listOf(1, 2, 3))
        up.drag(-250f)
        assertEquals(ChecklistMove(3, 1), up.finish())
    }

    @Test fun aDragThatEndsWhereItStartedCommitsNothing() {
        val drag = controller(1L to 100f, 2L to 100f, 3L to 100f, 4L to 100f)
        drag.start(2, listOf(1, 2, 3, 4))
        drag.drag(101f)
        assertEquals(listOf<Long>(1, 3, 2, 4), drag.order)
        drag.drag(-101f)
        assertEquals("back at the neighbour's middle is not past it", listOf<Long>(1, 3, 2, 4), drag.order)
        drag.drag(-1f)
        assertEquals(listOf<Long>(1, 2, 3, 4), drag.order)
        assertNull(drag.finish())
        assertNull("no preview is left behind", drag.order)
    }

    @Test fun aCancelledDragCommitsNothingAndLeavesNoPreview() {
        val drag = threeRows()
        drag.start(1, listOf(1, 2, 3))
        drag.drag(250f)
        drag.cancel()
        assertNull(drag.draggingId)
        assertNull(drag.order)
        assertEquals(0f, drag.offset, 0f)
        assertNull("finishing after a cancel reports nothing", drag.finish())
    }

    @Test fun thePreviewStaysUntilTheNoteShowsTheSameOrder() {
        val drag = threeRows()
        drag.start(1, listOf(1, 2, 3))
        drag.drag(101f)
        drag.finish()
        // The rows have not arrived yet: the old order must not flash back.
        drag.reconcile(listOf(1, 2, 3))
        assertEquals(listOf<Long>(2, 1, 3), drag.shown(listOf(1, 2, 3)))
        drag.reconcile(listOf(2, 1, 3))
        assertNull(drag.order)
        assertEquals(listOf<Long>(2, 1, 3), drag.shown(listOf(2, 1, 3)))
    }

    @Test fun aPreviewOfOtherRowsIsNeverShown() {
        val drag = threeRows()
        drag.start(1, listOf(1, 2, 3))
        drag.drag(101f)
        assertEquals("a row was added or removed meanwhile", listOf<Long>(2, 3), drag.shown(listOf(2, 3)))
        drag.reconcile(listOf(2, 3))
        assertNull("the drag over rows that changed ends", drag.draggingId)
        assertNull(drag.order)
    }

    @Test fun aRefusedMoveDropsItsPreview() {
        val drag = threeRows()
        drag.start(1, listOf(1, 2, 3))
        drag.drag(101f)
        drag.finish()
        drag.discardPreview()
        assertEquals(listOf<Long>(1, 2, 3), drag.shown(listOf(1, 2, 3)))
    }

    @Test fun onlyAVisibleRowCanBeDragged() {
        val drag = threeRows()
        assertFalse(drag.start(9, listOf(1, 2, 3)))
        assertNull(drag.draggingId)
    }

    @Test fun edgeScrollRampsFromZeroAtTheEdgeZoneToTheMaximum() {
        assertEquals(0f, edgeScrollDelta(500f, 100f, 900f, 80f, 20f), 0f)
        assertEquals(10f, edgeScrollDelta(860f, 100f, 900f, 80f, 20f), 0.001f)
        assertEquals(20f, edgeScrollDelta(950f, 100f, 900f, 80f, 20f), 0f)
        assertEquals(-10f, edgeScrollDelta(140f, 100f, 900f, 80f, 20f), 0.001f)
        assertEquals(0f, edgeScrollDelta(140f, 100f, 900f, 0f, 20f), 0f)
    }
}
