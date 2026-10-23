package dev.keeparr.android.ui.editor

import org.junit.Assert.*
import org.junit.Test

class ChecklistSwipeTest {
    private val threshold = 40f
    private val slop = 8f

    private fun step(dx: Float, dy: Float) = swipeIndentStep(dx, dy, threshold, slop)

    @Test fun aLongHorizontalMovementIsASwipeInThatDirection() {
        assertEquals(1, step(60f, 0f))
        assertEquals(-1, step(-60f, 0f))
        assertEquals("a little wobble is still a swipe", 1, step(60f, 20f))
    }

    @Test fun aShortMovementIsStillUndecided() {
        assertEquals(0, step(39f, 0f))
        assertEquals(0, step(-20f, 3f))
        assertEquals("a touch that has not moved", 0, step(0f, 0f))
    }

    @Test fun aDiagonalIsNotASwipeUntilItIsMostlyHorizontal() {
        assertEquals(0, step(50f, 30f))
        assertEquals(1, step(60f, 30f))
    }

    @Test fun aVerticalMovementHandsTheTouchToScrolling() {
        assertNull(step(0f, 20f))
        assertNull(step(5f, -30f))
        assertNull("once vertical it stays vertical, however far across it goes", step(50f, 50f))
    }

    @Test fun movementWithinTheTouchSlopDoesNotDecideAnything() {
        assertEquals(0, step(3f, 7f))
        assertEquals(0, step(0f, -8f))
    }
}
