package dev.keeparr.android.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * What a committed change touched, so only dependent side effects run. [notes] holds the syncIds of notes whose widget
 * rows can differ (including notes whose reminder changed), [order] means the personal order changed, [alarms] means the
 * reminder schedule can differ (reminder/occurrence change, or a note appearing, disappearing, archived or trashed),
 * and [full] is the recovery scope that rebuilds everything.
 */
data class EffectScope(val notes: Set<String> = emptySet(), val order: Boolean = false, val alarms: Boolean = false, val full: Boolean = false) {
    val isEmpty get() = !full && !order && !alarms && notes.isEmpty()
    val touchesWidgets get() = full || order || notes.isNotEmpty()
    val touchesAlarms get() = full || alarms

    operator fun plus(other: EffectScope) = if (this.isEmpty) other else if (other.isEmpty) this else
        EffectScope(notes + other.notes, order || other.order, alarms || other.alarms, full || other.full)

    /** A single-note widget only depends on its note; every collection view depends on membership, content and order. */
    fun affectsWidget(filter: String): Boolean = when {
        full -> true
        filter.startsWith("note:") -> filter.removePrefix("note:") in notes
        else -> notes.isNotEmpty() || order
    }

    companion object {
        val FULL = EffectScope(full = true)
        fun note(syncId: String, alarms: Boolean = false) = EffectScope(notes = setOf(syncId), alarms = alarms)
    }
}

/**
 * Applies post-commit effects. Alarm reconciliation is never delayed; widget updates are merged for a short quiet period,
 * but never later than [maxDelayMillis] after the first request in a burst, so continuous edits cannot starve widgets.
 */
class EffectDispatcher(private val scope: CoroutineScope, private val quietMillis: Long = 250, private val maxDelayMillis: Long = 1000,
    private val clock: () -> Long = System::currentTimeMillis,
    private val alarms: suspend () -> Unit, private val widgets: (EffectScope) -> Unit) {
    private val lock = Any()
    private var pending = EffectScope()
    private var firstRequestedAt = 0L
    private var job: Job? = null

    fun request(effect: EffectScope) {
        if (effect.isEmpty) return
        if (effect.touchesAlarms) scope.launch { alarms() }
        if (!effect.touchesWidgets) return
        synchronized(lock) {
            if (pending.isEmpty) firstRequestedAt = clock()
            pending += effect.copy(alarms = false)
            val wait = minOf(quietMillis, maxOf(0L, firstRequestedAt + maxDelayMillis - clock()))
            job?.cancel()
            job = scope.launch {
                delay(wait)
                flush()
            }
        }
    }

    /** Runs the merged widget scope now. */
    fun flush() {
        val due = synchronized(lock) { pending.also { pending = EffectScope(); job = null } }
        if (!due.isEmpty) widgets(due)
    }
}
