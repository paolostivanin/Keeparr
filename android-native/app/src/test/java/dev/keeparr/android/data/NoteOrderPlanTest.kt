package dev.keeparr.android.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class NoteOrderPlanTest {
    private val fixture = JSONObject(File(File(System.getProperty("keeparr.native.fixture")!!).parentFile, "note-order-plan.json").readText())

    @Test fun sharedFixtureCasesMatchTheWebPlannerExactly() {
        val cases = fixture.getJSONArray("cases")
        assertTrue(cases.length() >= 10)
        for (index in 0 until cases.length()) {
            val case = cases.getJSONObject(index)
            val desired = case.getJSONArray("desired").let { a -> List(a.length()) { a.getInt(it).toString() } }
            val current = case.getJSONArray("current").let { a -> (0 until a.length()).associate { a.getJSONArray(it).getInt(0).toString() to a.getJSONArray(it).getDouble(1) } }
            val pinned = case.getJSONArray("pinned").let { a -> List(a.length()) { a.getInt(it).toString() } }.toSet()
            val expected = case.getJSONArray("expected").let { a -> List(a.length()) { a.getJSONArray(it).getInt(0).toString() to a.getJSONArray(it).getDouble(1) } }
            assertEquals(case.getString("name"), expected, NoteOrderPlan.plan(desired, current, pinned))
        }
    }

    private fun applied(ids: List<String>, values: Map<String, Double>, plan: List<Pair<String, Double>>): Pair<List<String>, Map<String, Double>> {
        val next = values + plan
        return ids.sortedWith(compareByDescending<String> { next.getValue(it) }.thenByDescending { it }) to next
    }

    @Test fun everySingleMoveInALongListWritesOneNoteAndYieldsTheRequestedOrder() {
        val ids = (1000..1399).map { it.toString() } // same width so string and numeric tie order agree
        var values = ids.mapIndexed { index, id -> id to 1_700_000_000_000.0 - index * 1000 }.toMap()
        var order = ids
        var seed = 11L
        repeat(300) { round ->
            seed = (seed * 1103515245 + 12345) % 2147483648
            val from = (seed % order.size).toInt()
            val to = ((seed shr 7) % order.size).toInt()
            val desired = order.toMutableList().also { it.add(to, it.removeAt(from)) }
            val plan = NoteOrderPlan.plan(desired, values)
            assertTrue("round $round wrote ${plan.size}", plan.size <= 1)
            val (nextOrder, nextValues) = applied(ids, values, plan)
            assertEquals("round $round", desired, nextOrder)
            values = nextValues
            order = nextOrder
        }
    }

    @Test fun pinnedAndOtherNotesAreOrderedIndependently() {
        val values = mapOf("1" to 5.0, "2" to 4.0, "3" to 100.0, "4" to 90.0)
        val plan = NoteOrderPlan.plan(listOf("1", "2", "4", "3"), values, setOf("1", "2"))
        assertEquals(listOf("4"), plan.map { it.first })
    }
}
