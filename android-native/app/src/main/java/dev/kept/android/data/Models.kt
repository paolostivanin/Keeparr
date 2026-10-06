package dev.kept.android.data

import android.text.Html
import android.text.SpannableStringBuilder
import android.text.Spanned
import org.jsoup.Jsoup
import org.jsoup.nodes.Element
import org.jsoup.nodes.Node
import org.jsoup.nodes.TextNode
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.UUID

fun JSONObject.copyJson() = JSONObject(toString())
fun JSONObject.text(key: String, fallback: String = ""): String = if (isNull(key)) fallback else optString(key, fallback)
fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }

data class Note(val raw: JSONObject) {
    val syncId get() = raw.text("syncId")
    val id get() = raw.optLong("id")
    val title get() = raw.text("noteTitle")
    val body get() = raw.text("noteBody")
    val pinned get() = raw.optBoolean("pinned")
    val locked get() = raw.optBoolean("locked")
    val checklist get() = raw.optBoolean("isCbox")
    val items get() = raw.optJSONArray("checkBoxes")?.objects().orEmpty()
    val order get() = raw.optDouble("sortOrder")
    val revision get() = raw.optLong("revision")
    val owner get() = raw.optLong("ownerUserId")
    val binder get() = raw.text("binder")
    val archived get() = raw.optBoolean("archived")
    val trashed get() = raw.optBoolean("trashed")
    val labels get() = raw.optJSONArray("labels")?.objects().orEmpty().filter { it.optBoolean("added") }.map { it.text("name") }

    // Anything the user would lose by discarding the note; bgColor and pinned are cosmetic and don't count.
    val hasContent get() = Jsoup.parseBodyFragment(title).text().isNotBlank() ||
        NoteFormat.bodyLines(body).isNotEmpty() || body.contains("<img", ignoreCase = true) ||
        (body.isNotBlank() && !NoteFormat.editable(body)) ||
        items.any { it.opt("data") !is String || Jsoup.parseBodyFragment(it.text("data")).text().isNotBlank() } ||
        (raw.optJSONArray("images")?.length() ?: 0) > 0 || (raw.optJSONArray("attachments")?.length() ?: 0) > 0 ||
        labels.isNotEmpty() || binder.isNotBlank()

    companion object {
        fun create(userId: Long, checklist: Boolean = false) = Note(JSONObject().apply {
            put("syncId", "note-${UUID.randomUUID()}"); put("id", -System.currentTimeMillis()); put("revision", 0)
            put("ownerUserId", userId); put("noteTitle", ""); put("noteBody", ""); put("isCbox", checklist)
            put("pinned", false); put("archived", false); put("trashed", false); put("locked", false)
            put("bgColor", ""); put("bgImage", ""); put("binder", ""); put("sortOrder", System.currentTimeMillis())
            put("checkBoxes", JSONArray()); put("images", JSONArray()); put("labels", JSONArray())
        })
    }
}

data class ProfiledNoteSnapshot(val profile: String, val note: Note, val submitted: Note? = null)

enum class Discard { DISCARDED, SYNCED, KEPT }

enum class ConflictResolution { USE_SERVER, REPLACE_WITH_DRAFT, SAVE_AS_COPY, DISCARD }

object EditorSnapshotPolicy {
    private val serverManagedFields = setOf(
        "id", "revision", "ownerUserId", "createdAt", "updatedAt", "trashedAt", "isDemo", "lwwPhysicalMs", "lwwLogical",
        "lwwDeviceId", "lwwOperationId", "collaborators", "ownerDisplayName", "ownerUsername",
        "ownerAvatarDataUrl", "ownerAvatarPreset", "lastEditorUserId", "lastEditorDisplayName",
        "completedChecklistCollapsed", "attachments"
    )

    fun sameEditableContent(first: Note, second: Note): Boolean {
        val left = first.raw.copyJson()
        val right = second.raw.copyJson()
        serverManagedFields.forEach { key -> left.remove(key); right.remove(key) }
        return canonicalJson(left) == canonicalJson(right)
    }

    private fun canonicalJson(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().sorted().joinToString(prefix = "{", postfix = "}") { key ->
            "${JSONObject.quote(key)}:${canonicalJson(value.opt(key))}"
        }
        is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { index -> canonicalJson(value.opt(index)) }
        JSONObject.NULL, null -> "null"
        is String -> JSONObject.quote(value)
        is Number, is Boolean -> value.toString()
        else -> JSONObject.quote(value.toString())
    }

    fun apply(local: Note, incoming: Note?, dirty: Boolean): Note? {
        if (incoming == null) return null
        if (local.id <= 0 && incoming.id > 0) {
            return Note(local.raw.copyJson().put("id", incoming.id).put("revision", incoming.revision))
        }
        if (dirty && local.id > 0 && incoming.id == local.id && sameEditableContent(local, incoming)) return incoming
        if (!dirty && local.id > 0 && incoming.id == local.id && incoming.raw.toString() != local.raw.toString()) return incoming
        return null
    }
}

object NoteOrder {
    val comparator = compareByDescending<Note> { it.pinned }.thenByDescending { it.order }
        .thenByDescending { it.id }.thenBy { it.syncId }
    fun visible(notes: List<Note>, filter: String = "home"): List<Note> = notes.filter { note ->
        when {
            filter == "trash" -> note.trashed
            filter == "archive" -> note.archived && !note.trashed
            note.archived || note.trashed -> false
            filter == "pinned" -> note.pinned
            filter.startsWith("label:") -> filter.removePrefix("label:") in note.labels
            filter.startsWith("binder:") -> filter.removePrefix("binder:") == note.binder
            filter.startsWith("note:") -> filter.removePrefix("note:") == note.syncId
            filter == "shared" -> (note.raw.optJSONArray("collaborators")?.length() ?: 0) > 0
            else -> note.binder.isEmpty()
        }
    }.sortedWith(comparator)
}

// Only the formats represented by Android's styled text editor are editable.
// Preserve the original HTML when the user changes another field.
object NoteFormat {
    private val supported = setOf("br", "p", "div", "b", "strong", "i", "em", "u", "s", "strike", "a", "span")
    private val attributePattern = Regex("""([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))""")

    // The web renders bodies with white-space: pre-wrap, so a raw newline is a visible line break there while
    // Html.fromHtml collapses it into a space. Turning each one into <br> makes Android show what the web shows.
    private fun breakRawNewlines(parent: Element) {
        for (child in parent.childNodes().toList()) {
            if (child is Element) breakRawNewlines(child)
            else if (child is TextNode && child.wholeText.contains('\n')) {
                child.wholeText.replace("\r\n", "\n").split('\n').forEachIndexed { index, part ->
                    if (index > 0) child.before(Element("br"))
                    if (part.isNotEmpty()) child.before(TextNode(part))
                }
                child.remove()
            }
        }
    }

    // The one conversion behind the editor and every read-only view, so they cannot disagree.
    fun spanned(html: String): Spanned {
        val document = Jsoup.parseBodyFragment(html)
        document.outputSettings().prettyPrint(false)
        breakRawNewlines(document.body())
        val result = SpannableStringBuilder(Html.fromHtml(document.body().html(), Html.FROM_HTML_MODE_COMPACT))
        // fromHtml ends every block with a newline; serializing it back would add a blank line on each reload.
        var end = result.length
        while (end > 0 && result[end - 1] == '\n') end--
        result.delete(end, result.length)
        return result
    }

    fun displayText(html: String): String = spanned(html).toString()

    // One <p> per line, with <br> for blank lines: unlike the consecutive mode this round-trips blank lines. The
    // newlines toHtml puts between tags are formatting only, and the web would render them as extra blank lines.
    fun serialize(text: Spanned): String = Html.toHtml(text, Html.TO_HTML_PARAGRAPH_LINES_INDIVIDUAL).replace("\n", "")

    fun editable(html: String): Boolean = Regex("<\\s*(/?)\\s*([a-zA-Z0-9]+)([^>]*)>").findAll(html).all { match ->
        val tag = match.groupValues[2].lowercase()
        val attributes = match.groupValues[3]
        tag in supported && editableAttributes(tag, attributes)
    }

    private fun editableAttributes(tag: String, raw: String): Boolean {
        val attributes = attributePattern.findAll(raw).toList()
        if (attributePattern.replace(raw, "").replace("/", "").isNotBlank()) return false
        return attributes.all { match ->
            val name = match.groupValues[1].lowercase()
            val value = match.groups[2]?.value ?: match.groups[3]?.value ?: match.groups[4]?.value.orEmpty()
            when (name) {
                "href" -> tag == "a" && runCatching { java.net.URI(value).scheme?.lowercase() in setOf("http", "https", "mailto") }.getOrDefault(false)
                "style" -> tag in setOf("p", "div", "span") && value in setOf("", "margin-top:0; margin-bottom:0;")
                "dir" -> tag in setOf("p", "div", "span") && value.lowercase() in setOf("ltr", "rtl")
                else -> false
            }
        }
    }

    fun checklistItemEditable(data: Any?): Boolean {
        if (data !is String || !editable(data)) return false
        val body = Jsoup.parseBodyFragment(data).body()
        val textNodes = body.getAllElements().flatMap { it.textNodes() }.filter { it.text().isNotBlank() }
        return textNodes.size == 1
    }

    fun editedChecklistItem(data: Any?, visibleText: String): Any? {
        if (data !is String) return data
        if (Regex("<\\s*[a-zA-Z]").containsMatchIn(data)) {
            if (!checklistItemEditable(data)) return data
            val document = Jsoup.parseBodyFragment(data)
            document.outputSettings().prettyPrint(false)
            document.body().getAllElements().flatMap { it.textNodes() }.first { it.text().isNotBlank() }.text(visibleText)
            return document.body().html()
        }
        return Html.escapeHtml(visibleText)
    }

    private val blockTags = setOf("p", "div", "li", "ul", "ol", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6")

    // One entry per visible line: <br> and block elements end a line, blank lines are skipped.
    fun bodyLines(html: String): List<String> {
        val lines = mutableListOf<String>()
        val current = StringBuilder()
        fun flush() {
            val text = current.toString().replace('\u00a0', ' ').trim()
            if (text.isNotEmpty()) lines += text
            current.clear()
        }
        fun walk(node: Node) {
            if (node is TextNode) current.append(node.wholeText.replace(Regex("\\s+"), " "))
            else if (node is Element && node.tagName() == "br") flush()
            else if (node is Element) {
                val block = node.tagName() in blockTags
                if (block) flush()
                node.childNodes().forEach(::walk)
                if (block) flush()
            }
        }
        Jsoup.parseBodyFragment(html).body().childNodes().forEach(::walk)
        flush()
        return lines
    }

    // "Show checkboxes": every body line becomes an unchecked item appended after any items already on the note.
    fun showCheckboxes(raw: JSONObject, firstId: Long): List<JSONObject> {
        val existing = raw.optJSONArray("checkBoxes")?.objects().orEmpty()
        val start = maxOf(firstId, (existing.maxOfOrNull { it.optLong("id") } ?: 0L) + 1)
        val added = bodyLines(raw.optString("noteBody")).mapIndexed { index, line ->
            JSONObject().put("id", start + index).put("done", false).put("data", Html.escapeHtml(line)).put("indentLevel", 0)
        }
        raw.put("isCbox", true).put("noteBody", "").put("checkBoxes", JSONArray(existing + added))
        return added
    }

    fun checkedItemCount(items: List<JSONObject>) = items.count { it.optBoolean("done") }

    // Structured (non-string) items cannot become plain lines without losing their content.
    fun canHideCheckboxes(items: List<JSONObject>) = items.all { it.optBoolean("done") || it.opt("data") is String }

    // "Hide checkboxes": unchecked items become lines after the existing body; checked items are dropped.
    fun hideCheckboxes(raw: JSONObject) {
        val lines = raw.optJSONArray("checkBoxes")?.objects().orEmpty().filter { !it.optBoolean("done") }
            .map { it.text("data") }.filter { Jsoup.parseBodyFragment(it).text().isNotBlank() }
        raw.put("noteBody", raw.optString("noteBody") + lines.joinToString("") { "<div>$it</div>" })
            .put("isCbox", false).put("checkBoxes", JSONArray())
    }
}

object ChecklistAdapter {
    fun setDone(items: JSONArray, index: Int, done: Boolean): JSONArray = updateItem(items, index) { it.put("done", done) }

    fun indent(items: JSONArray, index: Int, delta: Int): JSONArray = updateItem(items, index) { item ->
        item.put("indentLevel", (item.optInt("indentLevel") + delta).coerceIn(0, 5))
    }

    fun move(items: JSONArray, from: Int, to: Int): JSONArray {
        val result = JSONArray(items.toString())
        if (from !in 0 until result.length() || to !in 0 until result.length()) return result
        val entries = (0 until result.length()).map { result.opt(it) }.toMutableList()
        java.util.Collections.swap(entries, from, to)
        return JSONArray().also { updated -> entries.forEach(updated::put) }
    }

    private fun updateItem(items: JSONArray, index: Int, update: (JSONObject) -> Unit): JSONArray {
        val result = JSONArray(items.toString())
        result.optJSONObject(index)?.let(update)
        return result
    }
}

object ReminderPlanner {
    data class ExpiredWindow(val count: Int, val firstDueAtUtc: String, val lastDueAtUtc: String)
    data class OccurrencePlan(val overdue: List<JSONObject>, val next: JSONObject?, val expired: ExpiredWindow?)
    private fun format(instant: Instant) = java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(instant)

    fun deliveryKey(occurrence: JSONObject, profile: String): String {
        val profileKey = java.security.MessageDigest.getInstance("SHA-256").digest(profile.toByteArray())
            .take(8).joinToString("") { "%02x".format(it) }
        return "$profileKey/${occurrence.text("occurrenceId")}/v${occurrence.optLong("scheduleVersion", 1).coerceAtLeast(1)}"
    }

    fun catchUpSummaryKey(profile: String, syncId: String, version: Long, window: ExpiredWindow): String {
        val profileKey = java.security.MessageDigest.getInstance("SHA-256").digest(profile.toByteArray())
            .take(8).joinToString("") { "%02x".format(it) }
        return "$profileKey/catch-up/$syncId/v${version.coerceAtLeast(1)}/${window.firstDueAtUtc}/${window.lastDueAtUtc}"
    }

    fun plan(reminder: JSONObject, now: Instant, profile: String, deliveredKeys: Set<String>,
        maxIndividualCatchUp: Int = 7, maxHistory: Int = 100_000): OccurrencePlan {
        require(maxIndividualCatchUp > 0 && maxHistory > 0)
        val recentOverdue = java.util.ArrayDeque<JSONObject>()
        var expiredCount = 0
        var firstExpiredAt: String? = null
        var lastExpiredAt: String? = null
        val syncId = reminder.text("syncId")
        val version = reminder.optLong("scheduleVersion", 1).coerceAtLeast(1)
        val zone = reminder.text("timezone", "UTC")
        val rule = reminder.text("repeatRule").takeIf { it.isNotBlank() }
        val anchor = reminder.text("scheduleAnchorAtUtc", reminder.text("dueAtUtc"))
        var due = Instant.parse(reminder.text("dueAtUtc"))
        var next: JSONObject? = null
        var finished = false
        for (step in 0 until maxHistory) {
            if (due.isAfter(now)) {
                val dueAtUtc = format(due)
                next = reminder.copyJson().put("dueAtUtc", dueAtUtc)
                    .put("occurrenceId", Recurrence.occurrenceId(syncId, dueAtUtc, version)).put("state", "pending")
                finished = true
                break
            }
            val dueAtUtc = format(due)
            val occurrence = reminder.copyJson().put("dueAtUtc", dueAtUtc)
                .put("occurrenceId", Recurrence.occurrenceId(syncId, dueAtUtc, version)).put("state", "pending")
            if (deliveryKey(occurrence, profile) !in deliveredKeys) {
                if (recentOverdue.size == maxIndividualCatchUp) {
                    val expired = recentOverdue.removeFirst()
                    expiredCount += 1
                    if (firstExpiredAt == null) firstExpiredAt = expired.text("dueAtUtc")
                    lastExpiredAt = expired.text("dueAtUtc")
                }
                recentOverdue.addLast(occurrence)
            }
            val following = Recurrence.next(dueAtUtc, zone, rule, anchor)
            if (following == null) {
                finished = true
                break
            }
            val parsed = Instant.parse(following)
            check(parsed.isAfter(due)) { "Reminder recurrence did not advance time." }
            due = parsed
            if (step == maxHistory - 1) break
        }
        check(finished) { "Reminder recurrence catch-up limit exceeded for $syncId." }
        val expired = if (expiredCount > 0) ExpiredWindow(expiredCount, requireNotNull(firstExpiredAt), requireNotNull(lastExpiredAt)) else null
        return OccurrencePlan(recentOverdue.toList(), next, expired)
    }

    fun nextDelivery(reminders: List<JSONObject>, occurrences: List<JSONObject>, now: Instant): Instant? {
        val remindersBySyncId = reminders.associateBy { it.text("syncId") }
        val actions = occurrences.associateBy { it.text("occurrenceId") }
        val candidates = mutableListOf<Instant>()
        for (occurrence in occurrences) {
            if (occurrence.text("state") != "snoozed") continue
            val reminder = remindersBySyncId[occurrence.text("syncId")] ?: continue
            if (occurrence.optLong("scheduleVersion", 1) != reminder.optLong("scheduleVersion", 1)) continue
            val snooze = runCatching { Instant.parse(occurrence.text("snoozeUntil")) }.getOrNull()
            if (snooze != null && snooze.isAfter(now)) candidates += snooze
        }
        for (reminder in reminders) {
            if (reminder.text("status") != "pending") continue
            var due = runCatching { Instant.parse(reminder.text("dueAtUtc")) }.getOrNull() ?: continue
            val anchor = reminder.text("scheduleAnchorAtUtc", reminder.text("dueAtUtc"))
            val timezone = reminder.text("timezone", "UTC")
            val repeat = reminder.text("repeatRule").takeIf { it.isNotBlank() }
            val version = reminder.optLong("scheduleVersion", 1).coerceAtLeast(1)
            var settled = false
            for (step in 0 until 100_000) {
                val id = Recurrence.occurrenceId(reminder.text("syncId"), due.toString(), version)
                when (actions[id]?.text("state")) {
                    "dismissed", "snoozed" -> {
                        val next = Recurrence.next(due.toString(), timezone, repeat, anchor)
                        if (next == null) {
                            settled = true
                            break
                        }
                        due = Instant.parse(next)
                    }
                    else -> {
                        candidates += due
                        settled = true
                        break
                    }
                }
            }
            check(settled) { "Reminder next-delivery catch-up limit exceeded for ${reminder.text("syncId")}." }
        }
        return candidates.minOrNull()
    }
}

object RedactedDiagnostics {
    fun build(appVersion: String, sdk: Int, device: String, connection: ConnectionSnapshot, state: String,
        cachedNotes: Int, cachedReminders: Int, pending: List<Outbox>, notificationsAllowed: Boolean,
        preciseAlarmsAllowed: Boolean, lastConnectionErrorPresent: Boolean): JSONObject {
        val operationTypes = pending.groupingBy { it.type }.eachCount()
        return JSONObject().put("appVersion", appVersion).put("androidSdk", sdk).put("device", device)
            .put("serverConfigured", connection.origin.isNotBlank()).put("clientCertificateSelected", connection.alias.isNotBlank())
            .put("customGatewayHeadersConfigured", connection.headers.isNotBlank()).put("sessionPresent", connection.token.isNotBlank())
            .put("connectionState", state).put("cachedNotes", cachedNotes).put("cachedReminders", cachedReminders)
            .put("pendingOperations", pending.size).put("pendingOperationTypes", JSONObject(operationTypes as Map<*, *>))
            .put("conflicts", pending.count { it.conflict != null }).put("notificationsAllowed", notificationsAllowed)
            .put("preciseAlarmsAllowed", preciseAlarmsAllowed).put("lastConnectionErrorPresent", lastConnectionErrorPresent)
    }
}

object Recurrence {
    fun sameInstant(first: String?, second: String?): Boolean {
        if (first == second) return true
        val firstInstant = runCatching { first?.let(Instant::parse) }.getOrNull()
        val secondInstant = runCatching { second?.let(Instant::parse) }.getOrNull()
        return firstInstant != null && firstInstant == secondInstant
    }

    fun normalizeRule(rule: String?): String? {
        if (rule.isNullOrBlank()) return null
        val json = runCatching { JSONObject(rule) }.getOrNull() ?: return null
        val type = json.text("type")
        if (type !in setOf("daily", "weekly", "monthly", "custom_days")) return null
        return JSONObject().put("type", type)
            .also {
                if (type == "custom_days") it.put("intervalDays", json.optLong("intervalDays", 1).coerceAtLeast(1))
                it.put("moveToTopOnTrigger", json.optBoolean("moveToTopOnTrigger"))
            }.toString()
    }

    fun next(due: String, zone: String, rule: String?, anchor: String = due): String? {
        if (rule.isNullOrBlank()) return null
        val json = runCatching { JSONObject(rule) }.getOrNull() ?: return null
        val timezone = runCatching { ZoneId.of(zone) }.getOrDefault(ZoneId.of("UTC"))
        val time = ZonedDateTime.ofInstant(Instant.parse(due), timezone)
        val anchorTime = runCatching { ZonedDateTime.ofInstant(Instant.parse(anchor), timezone) }.getOrDefault(time)
        val next = when (json.text("type")) {
            "daily" -> time.plusDays(1)
            "weekly" -> time.plusWeeks(1)
            "monthly" -> time.toLocalDate().plusMonths(1).withDayOfMonth(1)
                .withDayOfMonth(minOf(anchorTime.dayOfMonth, time.toLocalDate().plusMonths(1).lengthOfMonth()))
                .atTime(anchorTime.toLocalTime()).atZone(timezone)
            "custom_days" -> time.plusDays(json.optLong("intervalDays", 1).coerceAtLeast(1))
            else -> null
        }?.toInstant()
        return next?.let { java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(it) }
    }

    fun isOccurrence(anchor: String, targetDue: String, zone: String, rule: String?): Boolean {
        val target = runCatching { Instant.parse(targetDue) }.getOrNull() ?: return false
        var due = runCatching { Instant.parse(anchor).toString() }.getOrNull() ?: return false
        if (sameInstant(due, targetDue)) return true
        if (rule.isNullOrBlank()) return false
        for (step in 0 until 100_000) {
            val next = next(due, zone, rule, anchor) ?: return false
            val nextInstant = Instant.parse(next)
            if (nextInstant <= Instant.parse(due)) throw IllegalStateException("Recurrence rule did not advance time.")
            if (nextInstant == target) return true
            if (nextInstant > target) return false
            due = next
        }
        throw IllegalStateException("Occurrence is beyond the supported recurrence validation range.")
    }
    fun occurrenceId(syncId: String, due: String, scheduleVersion: Long = 1): String =
        "$syncId@${java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.parse(due))}#v${scheduleVersion.coerceAtLeast(1)}"
}
