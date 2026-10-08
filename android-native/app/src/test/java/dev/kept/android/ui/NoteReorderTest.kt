package dev.kept.android.ui

import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import dev.kept.android.data.Note
import org.junit.Assert.*
import org.junit.Test

class NoteReorderTest {
    private fun card(left: Float, top: Float) = Rect(left, top, left + 100f, top + 100f)

    private fun controller(canDrop: (String, String) -> Boolean = { _, _ -> true }) = NoteReorderController(canDrop).also {
        it.positioned("a", card(0f, 0f)); it.positioned("b", card(110f, 0f)); it.positioned("c", card(0f, 110f))
    }

    @Test fun hitTestingOnlyFindsCardsThatAreStillComposed() {
        val reorder = controller()
        assertEquals("b", reorder.idAt(Offset(150f, 50f)))
        assertNull("gaps and areas without a card have no target", reorder.idAt(Offset(105f, 50f)))
        reorder.disposed("b")
        assertNull("a card that scrolled out of composition can no longer be a target", reorder.idAt(Offset(150f, 50f)))
        reorder.positioned("b", card(110f, -500f))
        assertNull(reorder.idAt(Offset(150f, 50f)))
    }

    @Test fun reportingGeometryNeverWritesObservableState() {
        val reorder = controller()
        reorder.start(Offset(50f, 50f))
        var writes = 0
        Snapshot.takeMutableSnapshot(writeObserver = { writes++ }).run {
            try { enter { repeat(100) { reorder.positioned("a", card(0f, it.toFloat())) }; reorder.disposed("c") } } finally { dispose() }
        }
        assertEquals("layout reports must not invalidate composition", 0, writes)
        assertEquals("a", reorder.draggingId)
    }

    @Test fun aDragStartsOnlyOnACardAndTracksOnlyAllowedTargets() {
        val reorder = controller { source, target -> !(source == "a" && target == "c") }
        assertFalse(reorder.start(Offset(105f, 50f)))
        assertNull(reorder.draggingId)

        assertTrue(reorder.start(Offset(50f, 50f)))
        assertEquals("a", reorder.draggingId)
        reorder.move(Offset(150f, 50f))
        assertEquals("b", reorder.targetId)
        reorder.move(Offset(105f, 50f))
        assertEquals("a gap keeps the previous target", "b", reorder.targetId)
        reorder.move(Offset(50f, 150f))
        assertNull("another pinned group is not a target", reorder.targetId)
        reorder.move(Offset(150f, 50f))
        reorder.move(Offset(50f, 50f))
        assertNull("returning over the source clears the target", reorder.targetId)
    }

    @Test fun anAcceptedDropIsReportedOnceAndAbandonedDragsCommitNothing() {
        val reorder = controller()
        reorder.start(Offset(50f, 50f)); reorder.move(Offset(150f, 50f))
        assertEquals(NoteDrop("a", "b"), reorder.finish())
        assertNull("the same drop cannot be committed twice", reorder.finish())
        assertNull(reorder.draggingId); assertNull(reorder.targetId)

        reorder.start(Offset(50f, 50f)); reorder.move(Offset(150f, 50f)); reorder.cancel()
        assertNull(reorder.finish())

        reorder.start(Offset(50f, 50f))
        assertNull("releasing without a target is not a drop", reorder.finish())
    }

    @Test fun scrollingContentUnderAStationaryPointerRetargetsWithoutNewPointerEvents() {
        val reorder = controller()
        reorder.start(Offset(50f, 50f)); reorder.move(Offset(150f, 50f))
        assertEquals("b", reorder.targetId)
        reorder.positioned("b", card(110f, -300f))
        reorder.positioned("c", card(110f, 0f)) // content scrolled: another card is now under the pointer
        reorder.refresh()
        assertEquals("c", reorder.targetId)
    }

    @Test fun autoscrollRampsTowardTheNearestEdgeAndStopsWhenNotDragging() {
        val viewport = Rect(0f, 100f, 400f, 900f)
        val reorder = controller()
        assertEquals(0f, reorder.autoScrollDelta(viewport, 80f, 20f), 0f)
        reorder.start(Offset(50f, 50f))
        reorder.move(Offset(50f, 500f))
        assertEquals("middle of the viewport", 0f, reorder.autoScrollDelta(viewport, 80f, 20f), 0f)
        reorder.move(Offset(50f, 860f))
        assertEquals("halfway into the bottom edge zone", 10f, reorder.autoScrollDelta(viewport, 80f, 20f), 0.001f)
        reorder.move(Offset(50f, 950f))
        assertEquals("beyond the edge is capped", 20f, reorder.autoScrollDelta(viewport, 80f, 20f), 0f)
        reorder.move(Offset(50f, 140f))
        assertEquals("near the top scrolls back", -10f, reorder.autoScrollDelta(viewport, 80f, 20f), 0.001f)
        reorder.cancel()
        assertEquals(0f, reorder.autoScrollDelta(viewport, 80f, 20f), 0f)
    }

    private fun note(id: String, pinned: Boolean) = Note.create(1).also { it.raw.put("syncId", id).put("pinned", pinned) }

    @Test fun movingEarlierOrLaterNeverCrossesTheGroupAndMatchesTheStoredOrder() {
        val visible = listOf(note("p1", true), note("p2", true), note("o1", false), note("o2", false))
        assertEquals(listOf("p2", "p1", "o1", "o2"), moveNoteBy(visible, 0, 1))
        assertEquals(listOf("p2", "p1", "o1", "o2"), moveNoteBy(visible, 1, -1))
        assertNull("the first note cannot move earlier", moveNoteBy(visible, 0, -1))
        assertNull("the last pinned note cannot move into the other group", moveNoteBy(visible, 1, 1))
        assertNull(moveNoteBy(visible, 2, -1))
        assertEquals(listOf("p1", "p2", "o2", "o1"), moveNoteBy(visible, 2, 1))
        assertNull("the last note cannot move later", moveNoteBy(visible, 3, 1))
        assertNull(moveNoteBy(visible, 9, 1))
        assertNull("only single steps exist", moveNoteBy(visible, 0, 2))
        assertTrue(canMoveNoteBy(visible, 0, 1) && !canMoveNoteBy(visible, 1, 1))
        // The keyboard/accessibility move and a drag onto the neighbour agree.
        assertEquals(moveDraggedNote(visible, visible[0], "p2"), moveNoteBy(visible, 0, 1))
    }
}
