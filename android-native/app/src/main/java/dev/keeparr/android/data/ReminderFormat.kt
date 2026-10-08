package dev.keeparr.android.data

import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

object ReminderFormat {
    fun dateTime(value: String, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
        runCatching { Instant.parse(value).atZone(zone).format(DateTimeFormatter.ofPattern("MMM d · h:mm a", locale)) }
            .getOrDefault(value)

    fun displayDueAt(reminder: JSONObject, now: Instant = Instant.now()): String {
        val plan = runCatching { ReminderPlanner.plan(reminder, now, "reminder-display", emptySet()) }.getOrNull()
        return plan?.next?.text("dueAtUtc") ?: plan?.overdue?.lastOrNull()?.text("dueAtUtc") ?: reminder.text("dueAtUtc")
    }

    fun indexByNote(notes: List<Note>, reminders: List<JSONObject>): Map<String, JSONObject> {
        val notesById = notes.associateBy { it.id }
        return reminders.asSequence()
            .filter { it.text("status") == "pending" && it.text("dueAtUtc").isNotBlank() }
            .mapNotNull { reminder ->
                val syncId = reminder.text("noteSyncId").ifBlank { notesById[reminder.optLong("noteId")]?.syncId.orEmpty() }
                syncId.takeIf { it.isNotBlank() }?.let { it to reminder }
            }
            .groupBy({ it.first }, { it.second })
            .mapValues { (_, candidates) -> candidates.minByOrNull { dueInstant(displayDueAt(it)) }!! }
    }

    private fun dueInstant(value: String): Instant = runCatching { Instant.parse(value) }.getOrDefault(Instant.MAX)
}
