package dev.keeparr.android.ui.editor

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NoteHistoryTest {
    private var clock = 0L
    private fun entry(body: String, structure: String = "") = NoteHistory.Entry("", body, false, "[$structure]", structure)

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
}
