package dev.keeparr.android.ui.editor

import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.isToggleable
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.down
import androidx.compose.ui.test.moveBy
import androidx.compose.ui.test.up
import androidx.compose.ui.test.center
import androidx.compose.ui.geometry.Offset
import dev.keeparr.android.data.ChecklistModel
import dev.keeparr.android.data.html.HtmlMode
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The grip driven by real pointer input, inside the same click-to-focus + scrolling column the note editor uses. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class ChecklistDragGestureTest {
    @get:Rule val compose = createEmptyComposeRule()

    private class Recorder : ChecklistActions {
        val moves = ArrayList<Pair<Long, Long?>>()
        val indents = ArrayList<Pair<Long, Int>>()
        val removed = ArrayList<Long>()
        override fun setText(id: Long, html: String) {}
        override fun toggle(id: Long, done: Boolean) {}
        override fun split(id: Long, left: String, rest: List<String>, caret: Int) {}
        override fun backspaceAtStart(id: Long) = false
        override fun moveUp(id: Long) {}
        override fun moveDown(id: Long) {}
        override fun moveBefore(id: Long, beforeId: Long?): Boolean { moves += id to beforeId; return true }
        override fun setIndent(id: Long, level: Int) { indents += id to level }
        override fun remove(id: Long) { removed += id }
    }

    private fun row(id: Long) = JSONObject().put("id", id).put("data", "row $id").put("done", false).put("indentLevel", if (id == 3L) 1 else 0)

    private fun host(actions: Recorder, taps: IntArray) {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val rows = (1L..4L).map(::row)
        val states = HashMap<Long, RichEditorState>()
        activity.setContent {
            MaterialTheme {
                Column(Modifier.clickable { taps[0]++ }.verticalScroll(rememberScrollState())) {
                    ChecklistRows(rows, false, 0L, EditorColors(0xFF000000.toInt(), 0xFF0000FF.toInt()), Color.Black, Color.White, null,
                        states, actions, {}, { _, _ -> }, viewport = { null }, scrollBy = { 0f })
                }
            }
        }
    }

    private fun grips() = compose.onAllNodesWithContentDescription("Reorder item", useUnmergedTree = true)

    /** Rows are the same height, so the distance between two grips is one row. */
    private fun rowHeight(): Float =
        grips()[1].fetchSemanticsNode().boundsInRoot.top - grips()[0].fetchSemanticsNode().boundsInRoot.top

    /** Presses the grip of the row at [index], moves by [distance] in steps (the first crosses the touch slop), releases. */
    private fun drag(index: Int, distance: Float) {
        grips()[index].performTouchInput {
            down(center)
            val steps = 6
            repeat(steps) { moveBy(Offset(0f, distance / steps)) }
            up()
        }
        compose.waitForIdle()
    }

    @Test fun draggingTheFirstRowPastTheSecondDropsItBeforeTheThird() {
        val actions = Recorder()
        val taps = IntArray(1)
        host(actions, taps)
        compose.waitForIdle()
        drag(0, rowHeight() * 1.2f)
        assertEquals("the drop must reach the note", listOf(1L to 3L), actions.moves)
        assertEquals("a drag is not a tap on the editor", 0, taps[0])
    }

    @Test fun draggingARowUpDropsItBeforeThePreviousOne() {
        val actions = Recorder()
        host(actions, IntArray(1))
        compose.waitForIdle()
        drag(3, -rowHeight() * 1.2f)
        assertEquals(listOf(4L to 3L), actions.moves)
    }

    @Test fun draggingPastTheLastRowDropsItAtTheEnd() {
        val actions = Recorder()
        host(actions, IntArray(1))
        compose.waitForIdle()
        drag(0, rowHeight() * 6f)
        assertEquals("the end is a null target", listOf<Pair<Long, Long?>>(1L to null), actions.moves)
    }

    @Test fun aDragThatGoesNowhereDropsNothing() {
        val actions = Recorder()
        host(actions, IntArray(1))
        compose.waitForIdle()
        drag(1, rowHeight() * 0.3f)
        assertTrue(actions.moves.isEmpty())
    }

    @Test fun tappingTheGripOnlyDoesNotReachTheEditorsClickToFocus() {
        val actions = Recorder()
        val taps = IntArray(1)
        host(actions, taps)
        compose.waitForIdle()
        grips()[1].performTouchInput { down(center); up() }
        compose.waitForIdle()
        assertTrue(actions.moves.isEmpty())
        assertEquals(0, taps[0])
    }

    /** Swipes across the text of the row at [index]: the grip sits at its start, so the text is well to the right of it. */
    private fun swipe(index: Int, dx: Float, dy: Float = 0f) {
        val grip = grips()[index].fetchSemanticsNode().boundsInRoot
        val start = Offset(grip.right + compose.density.density * 90f, grip.center.y)
        compose.onRoot(useUnmergedTree = true).performTouchInput {
            down(start)
            repeat(8) { moveBy(Offset(dx / 8, dy / 8)) }
            up()
        }
        compose.waitForIdle()
    }

    private val swipeLength get() = compose.density.density * 90f

    @Test fun swipingARowRightIndentsItOneLevel() {
        val actions = Recorder()
        val taps = IntArray(1)
        host(actions, taps)
        compose.waitForIdle()
        swipe(1, swipeLength)
        assertEquals(listOf(2L to 1), actions.indents)
        assertEquals("a swipe is not a tap on the editor", 0, taps[0])
    }

    @Test fun swipingAnIndentedRowLeftOutdentsIt() {
        val actions = Recorder()
        host(actions, IntArray(1))
        compose.waitForIdle()
        swipe(2, -swipeLength)
        assertEquals(listOf(3L to 0), actions.indents)
    }

    @Test fun aRowThatCannotGoDeeperOrShallowerIgnoresTheSwipe() {
        val actions = Recorder()
        host(actions, IntArray(1))
        compose.waitForIdle()
        swipe(0, swipeLength)
        swipe(2, swipeLength)
        swipe(1, -swipeLength)
        assertTrue("the first row, a row already one deeper than the one above and a row at level 0 stay put: ${actions.indents}", actions.indents.isEmpty())
    }

    @Test fun aShortOrVerticalMovementOnTheTextIsNotASwipe() {
        val actions = Recorder()
        host(actions, IntArray(1))
        compose.waitForIdle()
        swipe(1, compose.density.density * 20f)
        swipe(1, compose.density.density * 30f, compose.density.density * 60f)
        assertTrue(actions.indents.isEmpty())
    }

    @Test fun theXRemovesItsRow() {
        val actions = Recorder()
        host(actions, IntArray(1))
        compose.waitForIdle()
        compose.onAllNodesWithContentDescription("Remove item", useUnmergedTree = true)[1].performClick()
        compose.waitForIdle()
        assertEquals(listOf(2L), actions.removed)
    }

    @Test fun thereIsNoOverflowMenuAnyMore() {
        host(Recorder(), IntArray(1))
        compose.waitForIdle()
        compose.onAllNodesWithContentDescription("Checklist item actions", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithContentDescription("Remove item", useUnmergedTree = true).assertCountEquals(4)
    }

    @Test fun theCheckboxIndentsWithItsTextWhileTheGripStaysPut() {
        host(Recorder(), IntArray(1))
        compose.waitForIdle()
        val boxes = compose.onAllNodes(isToggleable(), useUnmergedTree = true)
        fun checkbox(index: Int) = boxes[index].fetchSemanticsNode().boundsInRoot.left
        fun grip(index: Int) = grips()[index].fetchSemanticsNode().boundsInRoot.left
        assertEquals("rows at the same level line up", checkbox(0), checkbox(1), 0f)
        assertEquals("row 3 is one level deeper", checkbox(1) + 12f * compose.density.density, checkbox(2), 0.5f)
        assertEquals("the grip is the same column for every row", grip(1), grip(2), 0f)
    }
}

