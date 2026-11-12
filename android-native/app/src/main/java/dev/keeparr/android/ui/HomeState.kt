package dev.keeparr.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.referentialEqualityPolicy
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.setValue

/**
 * Owner of the home screen's query, filter, layout and selection state and the rules that tie them together: a new
 * query or filter clears the selection, and reordering is only offered where the visible order is the stored order.
 *
 * It outlives the home screen's composition (the screen leaves while a note is open), so coming back from a note finds the
 * same view, query, layout and last projection instead of an empty grid. [Saver] keeps the query, filter and layout across
 * activity re-creation; the selection and the projection are rebuilt.
 */
internal class HomeState(initialFilter: String = "home") {
    private var searchState by mutableStateOf("")
    private var filterState by mutableStateOf(initialFilter)
    var grid by mutableStateOf(true)
    var selectedIds by mutableStateOf<Set<String>>(emptySet())
        private set

    var search: String
        get() = searchState
        set(value) { if (value != searchState) { searchState = value; clearSelection() } }

    var filter: String
        get() = filterState
        set(value) { filterState = value; clearSelection() }

    val reorderEnabled get() = canReorderNotes(filterState, searchState)
    val selecting get() = selectedIds.isNotEmpty()

    /** Incremental projector and its latest result; [projected] turns true once the first projection has arrived. */
    internal val projector = HomeProjector()
    var projection by mutableStateOf(EmptyHomeProjection, referentialEqualityPolicy())
    var projected by mutableStateOf(false)

    fun select(id: String) { selectedIds = selectedIds + id }
    fun toggle(id: String) { selectedIds = if (id in selectedIds) selectedIds - id else selectedIds + id }
    fun clearSelection() { if (selectedIds.isNotEmpty()) selectedIds = emptySet() }

    companion object {
        val Saver: Saver<HomeState, Any> = listSaver(
            save = { listOf(it.filter, it.search, it.grid) },
            restore = { saved -> HomeState(saved[0] as String).apply { search = saved[1] as String; grid = saved[2] as Boolean } })
    }
}
