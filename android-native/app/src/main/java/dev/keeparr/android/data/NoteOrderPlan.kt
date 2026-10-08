package dev.keeparr.android.data

/**
 * Plans the stored positions to write when the user moves notes. Storing, sending and syncing a new position for every listed
 * note made one drag cost O(account); the plan keeps the longest run of notes already in the requested order on their stored
 * positions and only gives the others new ones, between their kept neighbours.
 *
 * Pinned and other notes are ordered independently, so only positions within a group matter. The web client has the same
 * algorithm; `test-fixtures/note-order-plan.json` holds the cases both must reproduce exactly.
 */
object NoteOrderPlan {
    /** Closest two planned positions may be before they could no longer be told apart. */
    const val MIN_POSITION_GAP = 1e-3

    /** The (id, position) pairs to store for [desired] (ids in the wanted order, no duplicates); empty when it already holds. */
    fun plan(desired: List<String>, current: Map<String, Double>, pinned: Set<String> = emptySet()): List<Pair<String, Double>> {
        val (pinnedIds, otherIds) = desired.partition { it in pinned }
        return planGroup(pinnedIds, current) + planGroup(otherIds, current)
    }

    // Longest strictly decreasing run of stored positions along the requested order.
    private fun keptIndexes(values: List<Double>): Set<Int> {
        val tails = ArrayList<Int>()
        val previous = IntArray(values.size) { -1 }
        values.forEachIndexed { index, value ->
            val key = -value
            var low = 0
            var high = tails.size
            while (low < high) {
                val middle = (low + high) ushr 1
                if (-values[tails[middle]] < key) low = middle + 1 else high = middle
            }
            if (low > 0) previous[index] = tails[low - 1]
            if (low == tails.size) tails.add(index) else tails[low] = index
        }
        val kept = HashSet<Int>()
        var index = tails.lastOrNull() ?: -1
        while (index >= 0) { kept += index; index = previous[index] }
        return kept
    }

    private fun planGroup(desired: List<String>, current: Map<String, Double>): List<Pair<String, Double>> {
        if (desired.isEmpty()) return emptyList()
        val values = desired.map { current[it] ?: 0.0 }
        val kept = keptIndexes(values)
        if (kept.size == desired.size) return emptyList()
        val plan = ArrayList<Pair<String, Double>>()
        var index = 0
        while (index < desired.size) {
            if (index in kept) { index += 1; continue }
            val start = index
            while (index < desired.size && index !in kept) index += 1
            val count = index - start
            val above = if (start > 0) values[start - 1] else null
            val below = if (index < desired.size) values[index] else null
            val run = List(count) { step ->
                when {
                    above != null && below != null -> above - (above - below) * (step + 1) / (count + 1)
                    above != null -> above - (step + 1)
                    else -> below!! + (count - step)
                }
            }
            val fits = run.withIndex().all { (position, candidate) ->
                candidate.isFinite() && (position == 0 || run[position - 1] - candidate >= MIN_POSITION_GAP) &&
                    (above == null || above - candidate >= MIN_POSITION_GAP) && (below == null || candidate - below >= MIN_POSITION_GAP)
            }
            // No room between two neighbours: renumber the whole group above everything it holds now.
            if (!fits) {
                val top = values.max()
                return desired.mapIndexed { position, id -> id to top + (desired.size - position) }
            }
            run.forEachIndexed { position, value -> plan += desired[start + position] to value }
        }
        return plan
    }
}
