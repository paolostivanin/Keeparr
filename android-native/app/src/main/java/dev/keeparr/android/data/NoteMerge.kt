package dev.keeparr.android.data

import org.json.JSONArray
import org.json.JSONObject

/**
 * Field-level three-way merge for guarded note saves; a port of `src/app/utils/note-merge.ts`.
 * `base` is the accepted state an edit started from, `local` the saved draft and `latest` what the server holds now.
 * Fields the user did not change always follow the server, so concurrent changes elsewhere survive. Whole fields are
 * compared (a checklist is one field), exactly like the web, so a row edited on both sides is a real conflict.
 */
object NoteMerge {
    /** Same list and order as `EDITOR_DRAFT_FIELDS` on the web. */
    val GUARD_FIELDS = listOf("noteTitle", "noteBody", "pinned", "bgColor", "bgImage", "checkBoxes", "images", "isCbox",
        "labels", "binder", "archived", "trashed")

    data class Result(val merged: JSONObject, val conflicts: List<String>, val localFields: List<String>)

    /** Deep copy of just the guarded fields (missing ones become null), stored on the outbox entry as its base. */
    fun pickGuardFields(note: JSONObject): JSONObject {
        val picked = JSONObject()
        for (field in GUARD_FIELDS) picked.put(field, note.opt(field)?.let { deepCopy(it) } ?: JSONObject.NULL)
        return picked
    }

    private fun deepCopy(value: Any): Any = when (value) {
        is JSONObject -> value.copyJson()
        is JSONArray -> JSONArray(value.toString())
        else -> value
    }

    private fun scalar(note: JSONObject, field: String): String = if (note.isNull(field)) "" else note.optString(field)
    private fun flag(note: JSONObject, field: String): String = (note.opt(field) as? Boolean ?: (note.optBoolean(field))).toString()

    /** Representation-independent value used only to compare fields. */
    fun canonicalField(note: JSONObject, field: String): String = when (field) {
        "labels" -> JSONArray(note.optJSONArray("labels")?.objects().orEmpty()
            .filter { it.opt("added") != false }.map { it.text("name") }.sorted()).toString()
        "checkBoxes" -> JSONArray(note.optJSONArray("checkBoxes")?.objects().orEmpty().map { item ->
            JSONArray().put(item.opt("id")).put(item.optBoolean("done")).put(item.text("data")).put(item.optInt("indentLevel", 0))
        }).toString()
        "images" -> JSONArray(note.optJSONArray("images")?.objects().orEmpty().map { image ->
            JSONArray().put(image.opt("id")).put(image.opt("dataUrl")).put(image.text("name"))
                .put(image.text("placement").ifEmpty { "bottom" })
        }).toString()
        "bgColor" -> NotePalette.parse(scalar(note, field))?.let { NotePalette.toHex(it) } ?: scalar(note, field).trim()
        "pinned", "isCbox", "archived", "trashed" -> flag(note, field)
        else -> scalar(note, field)
    }

    fun changedFields(from: JSONObject, to: JSONObject): List<String> =
        GUARD_FIELDS.filter { canonicalField(from, it) != canonicalField(to, it) }

    fun merge(base: JSONObject, local: JSONObject, latest: JSONObject): Result {
        val localFields = changedFields(base, local)
        val conflicts = localFields.filter {
            canonicalField(latest, it) != canonicalField(base, it) && canonicalField(latest, it) != canonicalField(local, it)
        }
        return Result(overlay(latest, local, localFields.filter { it !in conflicts }), conflicts, localFields)
    }

    /** `latest` with the listed fields taken from `local`; every other key (including unknown ones) stays the server's. */
    fun overlay(latest: JSONObject, local: JSONObject, fields: List<String>): JSONObject {
        val next = latest.copyJson()
        for (field in fields) next.put(field, local.opt(field)?.let { deepCopy(it) } ?: JSONObject.NULL)
        return next
    }
}
