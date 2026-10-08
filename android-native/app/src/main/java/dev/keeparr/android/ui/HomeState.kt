package dev.keeparr.android.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Owner of the home screen's query, filter, layout and selection state and the rules that tie them together: a new
 * query or filter clears the selection, and reordering is only offered where the visible order is the stored order.
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

    fun select(id: String) { selectedIds = selectedIds + id }
    fun toggle(id: String) { selectedIds = if (id in selectedIds) selectedIds - id else selectedIds + id }
    fun clearSelection() { if (selectedIds.isNotEmpty()) selectedIds = emptySet() }
}
