package dev.keeparr.android.ui.editor

import dev.keeparr.android.data.ChecklistModel
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ChecklistSectionsTest {
    private fun row(id: Long, done: Boolean) = JSONObject().put("id", id).put("data", "row $id").put("done", done).put("indentLevel", 0)

    /** 1 open, 2 checked, 3 open, 4 checked, 5 open. */
    private val rows = listOf(row(1, false), row(2, true), row(3, false), row(4, true), row(5, false))

    private fun ids(list: List<JSONObject>) = list.map { ChecklistModel.idOf(it) }

    @Test fun checkedRowsMoveBelowTheOthersKeepingTheirOrder() {
        val sections = ChecklistSections.of(rows, split = true, collapsed = false)
        assertEquals(listOf<Long>(1, 3, 5), ids(sections.open))
        assertEquals(listOf<Long>(2, 4), ids(sections.completed))
    }

    @Test fun aCollapsedSectionShowsNoCheckedRows() {
        val sections = ChecklistSections.of(rows, split = true, collapsed = true)
        assertEquals(listOf<Long>(1, 3, 5), ids(sections.open))
        assertTrue(sections.completed.isEmpty())
        assertTrue("a hidden row has no section", sections.sectionOf(2).isEmpty())
    }

    @Test fun withoutTheSplitEveryRowStaysInPlaceAndVisible() {
        for (collapsed in listOf(true, false)) {
            val sections = ChecklistSections.of(rows, split = false, collapsed = collapsed)
            assertEquals(listOf<Long>(1, 2, 3, 4, 5), ids(sections.open))
            assertTrue(sections.completed.isEmpty())
        }
    }

    @Test fun neighboursNeverCrossIntoTheOtherSection() {
        val sections = ChecklistSections.of(rows, split = true, collapsed = false)
        assertEquals(listOf<Long>(1, 3, 5), ids(sections.sectionOf(3)))
        assertEquals(listOf<Long>(2, 4), ids(sections.sectionOf(4)))
        val (beforeThree, afterThree) = neighbours(sections, 3)
        assertEquals(1L, beforeThree?.let(ChecklistModel::idOf))
        assertEquals(5L, afterThree?.let(ChecklistModel::idOf))
        val (beforeTwo, afterTwo) = neighbours(sections, 2)
        assertNull("the first checked row has nothing above it in its section", beforeTwo)
        assertEquals(4L, afterTwo?.let(ChecklistModel::idOf))
        assertEquals(null to null, neighbours(ChecklistSections.of(rows, split = true, collapsed = true), 2))
    }

    @Test fun neighboursWithoutTheSplitFollowTheListOrder() {
        val (before, after) = neighbours(ChecklistSections.of(rows, split = false, collapsed = true), 3)
        assertEquals(2L, before?.let(ChecklistModel::idOf))
        assertEquals(4L, after?.let(ChecklistModel::idOf))
    }
}
