package dev.keeparr.android.ui.editor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NoteHistoryTest {
    private var clock = 0L
    private fun entry(body: String, structure: String = "", images: String = "[]", bgColor: String = "", pinned: Boolean = false) =
        NoteHistory.Entry("", body, false, "[$structure]", structure, images = images, bgColor = bgColor, pinned = pinned)

    @Test fun typingWithinABurstIsOneStepAndABreakStartsAnother() {
        val history = NoteHistory { clock }
        history.reset(entry(""))
        for ((i, text) in listOf("a", "ab", "abc").withIndex()) { clock = 100L * i; history.record(entry(text)) }
        clock = 5_000; history.record(entry("abcd"))
        assertEquals(3, history.size)
        assertEquals("abc", history.undo()!!.body)
        assertEquals("", history.undo()!!.body)
        assertFalse(history.canUndo)
        assertEquals("abc", history.redo()!!.body)
    }

    @Test fun structuralChangesAreSeparateSteps() {
        val history = NoteHistory { clock }
        history.reset(entry(""))
        history.record(entry("a"))
        history.record(entry("a", "1:false:0"))
        history.record(entry("a", "1:true:0"), structural = true)
        assertEquals(4, history.size)
    }

    @Test fun imageAndNoteAppearanceChangesAreUndoableSteps() {
        val history = NoteHistory { clock }
        history.reset(entry("body"))
        history.record(entry("body", images = "[{\"id\":\"image-1\"}]"), structural = true)
        history.record(entry("body", images = "[{\"id\":\"image-1\"}]", bgColor = "#cbf0f8", pinned = true), structural = true)
        val beforeAppearance = history.undo()!!
        assertEquals("", beforeAppearance.bgColor)
        assertEquals("[{\"id\":\"image-1\"}]", beforeAppearance.images)
        val beforeImage = history.undo()!!
        assertEquals("[]", beforeImage.images)
        assertFalse(beforeImage.pinned)
        history.redo()
        val afterAppearance = history.redo()!!
        assertEquals("#cbf0f8", afterAppearance.bgColor)
        assertTrue(afterAppearance.pinned)
    }

    @Test fun identicalStatesAreIgnoredAndRedoIsDroppedByANewEdit() {
        val history = NoteHistory { clock }
        history.reset(entry("x"))
        assertFalse(history.record(entry("x")))
        clock = 10_000; history.record(entry("y"))
        history.undo()
        assertTrue(history.canRedo)
        clock = 20_000; history.record(entry("z"))
        assertFalse(history.canRedo)
        assertNull(NoteHistory { 0 }.undo())
    }

    @Test fun historyIsBounded() {
        val history = NoteHistory { clock }
        history.reset(entry("0"))
        repeat(200) { clock += 5_000; history.record(entry("$it x")) }
        assertEquals(NoteHistory.LIMIT, history.size)
    }

    @Test fun acknowledgingAnUndoneStateKeepsBothDirectionsAndTheCaret() {
        val history = NoteHistory { clock }
        history.reset(entry("initial"))
        history.record(entry("<b>first</b>").copy(focusKey = "body", selection = intArrayOf(2, 4)), structural = true)
        history.record(entry("second"), structural = true)
        history.undo()
        history.reconcileCurrent(entry("<strong>first</strong>"))
        assertEquals(3, history.size)
        assertTrue(history.canUndo)
        assertTrue(history.canRedo)
        assertEquals("second", history.redo()!!.body)
        val reconciled = history.undo()!!
        assertEquals("<strong>first</strong>", reconciled.body)
        assertEquals("body", reconciled.focusKey)
        org.junit.Assert.assertArrayEquals(intArrayOf(2, 4), reconciled.selection)
        assertEquals("initial", history.undo()!!.body)
    }
}
