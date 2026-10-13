package dev.keeparr.android.data

import dev.keeparr.android.data.html.Fixtures
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ChecklistModelTest {
    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") { "${JSONObject.quote(it)}:${canonical(value.opt(it))}" }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.opt(it)) }
        is List<*> -> value.joinToString(",", "[", "]") { canonical(it) }
        JSONObject.NULL, null -> "null"
        is Number -> if (value.toDouble() == Math.floor(value.toDouble())) value.toLong().toString() else value.toString()
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }

    private fun run(op: JSONObject): Any? {
        val rows = ChecklistModel.rows(op.getJSONArray("items"))
        val args = op.getJSONObject("args")
        return when (op.getString("op")) {
            "setIndent" -> ChecklistModel.setIndent(rows, args.getLong("id"), args.getInt("indentLevel"))
            "toggleDone" -> ChecklistModel.toggleDone(rows, args.getLong("id"))
            "moveBefore" -> ChecklistModel.moveBefore(rows, args.getLong("id"), if (args.isNull("beforeId")) null else args.getLong("beforeId"))
            "split" -> ChecklistModel.split(rows, args.getLong("id"), args.getString("left"), args.getString("right"))
            "merge" -> ChecklistModel.mergeIntoPrevious(rows, args.getLong("id"), args.optJSONArray("visibleIds")?.let { ids -> (0 until ids.length()).map { ids.getLong(it) } })
            "remove" -> ChecklistModel.remove(rows, args.getLong("id"))
            "show" -> ChecklistModel.show(rows, args.getString("body")).let { (items, body) -> JSONObject().put("items", JSONArray(items)).put("body", body) }
            "hide" -> ChecklistModel.hide(rows, args.getString("body"))?.let { (items, body) -> JSONObject().put("items", JSONArray(items)).put("body", body) }
            else -> error("unknown op ${op.getString("op")}")
        }
    }

    @Test fun everyChecklistOpFixturePasses() {
        val ops = Fixtures.objects(Fixtures.root.getJSONArray("checklistOps"))
        assertTrue(ops.size >= 50)
        val failures = ArrayList<String>()
        for (op in ops) {
            val id = op.getString("id")
            val actual = try { run(op) } catch (problem: Throwable) { failures += "$id threw $problem"; continue }
            val expected = if (op.isNull("expected")) null else op.get("expected")
            val actualText = actual?.let { canonical(it) }
            val expectedText = expected?.let { canonical(it) }
            if (actualText != expectedText) failures += "$id: expected $expectedText but was $actualText"
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test fun operationsNeverChangeTheirInput() {
        val rows = listOf(JSONObject("""{"id":1,"done":false,"data":"a","indentLevel":0}"""), JSONObject("""{"id":2,"done":false,"data":"b","indentLevel":0}"""))
        val before = canonical(rows)
        ChecklistModel.setIndent(rows, 2, 1); ChecklistModel.toggleDone(rows, 1); ChecklistModel.moveBefore(rows, 2, 1)
        ChecklistModel.split(rows, 1, "x", "y"); ChecklistModel.mergeIntoPrevious(rows, 2); ChecklistModel.insertAfter(rows, 1)
        assertEquals(before, canonical(rows))
    }

    @Test fun insertedRowsGetTheNextIdAndTheLevelOfTheRowAbove() {
        val rows = listOf(JSONObject("""{"id":7,"done":false,"data":"a","indentLevel":2}"""), JSONObject("""{"id":3,"done":false,"data":"b","indentLevel":0}"""))
        val result = ChecklistModel.insertAfter(rows, 7)
        assertEquals(listOf(7L, 8L, 3L), result.map { it.getLong("id") })
        assertEquals(2, result[1].getInt("indentLevel"))
        assertEquals(listOf(7L, 3L, 8L), ChecklistModel.insertAfter(rows, null).map { it.getLong("id") })
        assertNull(ChecklistModel.setIndent(rows, 99, 1))
    }

    @Test fun hiddenRowsAreNotTheMergeTarget() {
        val rows = ChecklistModel.rows(JSONArray("""[{"id":1,"done":false,"data":"a"},{"id":2,"done":true,"data":"x"},{"id":3,"done":false,"data":"c"}]"""))
        assertEquals("ac", ChecklistModel.mergeIntoPrevious(rows, 3, listOf(1, 3))!!.first().getString("data"))
        assertEquals("x" + "c", ChecklistModel.mergeIntoPrevious(rows, 3)!![1].getString("data"))
    }
}
