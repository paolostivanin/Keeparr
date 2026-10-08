package dev.keeparr.android.data

import dev.keeparr.android.ui.HomeProjector
import dev.keeparr.android.ui.HomeState
import dev.keeparr.android.ui.buildHomeProjection
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class HomeProjectionTest {
    private fun note(n: Int, title: String = "Note $n", body: String = "<p>Body $n</p>", configure: JSONObject.() -> Unit = {}) =
        Note(JSONObject().put("syncId", "n$n").put("id", n.toLong()).put("revision", 1).put("sortOrder", n.toDouble())
            .put("noteTitle", title).put("noteBody", body).put("isCbox", false).put("pinned", false).put("archived", false)
            .put("trashed", false).put("locked", false).put("bgColor", "").put("binder", "").put("checkBoxes", JSONArray())
            .put("images", JSONArray()).put("labels", JSONArray()).apply(configure))

    private fun collection(count: Int) = (1..count).map { note(it) }

    @Test fun anUnchangedNoteKeepsItsCardWhenAnotherNoteChanges() {
        val projector = HomeProjector()
        val notes = collection(40)
        val first = projector.project(notes, "home", "", emptyList())
        val builds = projector.cardBuilds
        assertEquals(40, builds)

        val edited = notes.map { if (it.syncId == "n7") note(7, title = "Edited") else it }
        val second = projector.project(edited, "home", "", emptyList())

        assertEquals("only the edited note's card was rebuilt", builds + 1, projector.cardBuilds)
        val before = first.cards.associateBy { it.syncId }
        second.cards.forEach { card ->
            if (card.syncId == "n7") assertEquals("Edited", card.title) else assertSame(before.getValue(card.syncId), card)
        }
    }

    @Test fun anEditOutsideTheVisibleFilterProducesTheIdenticalProjection() {
        val projector = HomeProjector()
        val notes = collection(10) + note(11, configure = { put("archived", true) })
        val first = projector.project(notes, "home", "", emptyList())
        val changed = notes.map { if (it.syncId == "n11") note(11, title = "Archived edit") { put("archived", true) } else it }
        assertSame("nothing visible changed, so nothing recomposes", first, projector.project(changed, "home", "", emptyList()))
    }

    @Test fun identicalInputsReturnTheSameProjectionWithoutRebuilding() {
        val projector = HomeProjector()
        val notes = collection(5)
        val reminders = emptyList<JSONObject>()
        val first = projector.project(notes, "home", "note", reminders)
        val builds = projector.cardBuilds
        assertSame(first, projector.project(notes, "home", "note", reminders))
        assertEquals(builds, projector.cardBuilds)
    }

    @Test fun typingASearchBuildsEachNotesSearchTextOnce() {
        val projector = HomeProjector()
        val notes = collection(30) + note(31, title = "Needle in a haystack")
        projector.project(notes, "home", "n", emptyList())
        val built = projector.searchTextBuilds
        assertEquals(31, built)
        val narrowed = projector.project(notes, "home", "needle", emptyList())
        assertEquals("narrowing the query reuses cached note text", built, projector.searchTextBuilds)
        assertEquals(listOf("n31"), narrowed.visibleNotes.map { it.syncId })
        assertEquals(listOf("n31"), projector.project(notes, "home", "NEEDLE IN", emptyList()).cards.map { it.syncId })
    }

    @Test fun searchNeverMatchesLockedNotesAndFilterChoicesTrackLabelsAndBinders() {
        val notes = listOf(
            note(1, title = "secret plan") { put("locked", true) },
            note(2, title = "plan b") { put("labels", JSONArray().put(JSONObject().put("name", "work").put("added", true))) },
            note(3, title = "other") { put("binder", "Trips") }
        )
        val projection = HomeProjector().project(notes, "home", "plan", emptyList())
        assertEquals(listOf("n2"), projection.cards.map { it.syncId })
        assertTrue("label:work" to "work" in projection.filterChoices)
        assertTrue("binder:Trips" to "Trips" in projection.filterChoices)
    }

    @Test fun reminderChangesRebuildOnlyTheAffectedCard() {
        val projector = HomeProjector()
        val notes = collection(6)
        projector.project(notes, "home", "", emptyList())
        val builds = projector.cardBuilds
        val reminder = JSONObject().put("syncId", "r1").put("noteSyncId", "n3").put("noteId", 3).put("status", "pending")
            .put("dueAtUtc", "2030-01-01T09:00:00Z").put("timezone", "UTC")
        val withReminder = projector.project(notes, "home", "", listOf(reminder))
        assertEquals(builds + 1, projector.cardBuilds)
        assertNotNull(withReminder.cards.single { it.syncId == "n3" }.reminderText)
        assertNull(withReminder.cards.single { it.syncId == "n4" }.reminderText)
    }

    @Test fun incrementalResultsEqualAFreshProjectionAcrossFiltersAndEdits() {
        val projector = HomeProjector()
        var notes = collection(12).mapIndexed { index, item ->
            when {
                index % 4 == 0 -> note(index + 1) { put("pinned", true) }
                index % 5 == 0 -> note(index + 1) { put("isCbox", true).put("checkBoxes", JSONArray().put(JSONObject().put("id", 1).put("done", true).put("data", "milk"))) }
                else -> item
            }
        }
        for (step in 0 until 6) {
            for ((filter, search) in listOf("home" to "", "home" to "body", "pinned" to "", "trash" to "", "home" to "milk")) {
                val fresh = buildHomeProjection(notes, filter, search, emptyList())
                val incremental = projector.project(notes, filter, search, emptyList())
                assertEquals(fresh.cards, incremental.cards)
                assertEquals(fresh.pinnedCards, incremental.pinnedCards)
                assertEquals(fresh.visibleNotes.map { it.syncId }, incremental.visibleNotes.map { it.syncId })
                assertEquals(fresh.filterChoices, incremental.filterChoices)
            }
            notes = notes.map { if (it.id % 3L == step.toLong() % 3) note(it.id.toInt(), title = "step $step") else it }
        }
    }

    @Test fun cardContentTypesSeparateDistinctShapes() {
        val projection = HomeProjector().project(listOf(
            note(1), note(2) { put("isCbox", true) }, note(3) { put("locked", true) },
            note(4) { put("images", JSONArray().put(JSONObject().put("dataUrl", "/api/x.png"))) }
        ), "home", "", emptyList())
        assertEquals(setOf("text-card", "checklist-card", "locked-card", "image-card"), projection.cards.map { it.contentType }.toSet())
    }

    @Test fun homeStateClearsSelectionWhenTheQueryOrFilterChangesAndGatesReordering() {
        val state = HomeState()
        assertTrue(state.reorderEnabled)
        state.select("a"); state.select("b"); state.toggle("a")
        assertEquals(setOf("b"), state.selectedIds)
        state.search = "milk"
        assertTrue(state.selectedIds.isEmpty())
        assertFalse("reordering a filtered list would reorder hidden notes", state.reorderEnabled)
        state.search = ""
        state.select("c")
        state.search = ""
        assertEquals("setting the same query keeps the selection", setOf("c"), state.selectedIds)
        state.filter = "trash"
        assertTrue(state.selectedIds.isEmpty())
        assertFalse(state.reorderEnabled)
        state.filter = "pinned"
        assertTrue(state.reorderEnabled)
    }
}
