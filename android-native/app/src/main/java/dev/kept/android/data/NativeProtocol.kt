package dev.kept.android.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.json.JSONArray
import org.json.JSONObject

@Serializable
private data class MutationEnvelope(val mutations: List<JsonObject>)

object NativeProtocol {
    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    /** The envelope is typed while each raw JSON payload keeps arbitrary extension fields. */
    fun mutationBatch(mutations: List<JSONObject>): JSONObject {
        val payloads = mutations.map { json.parseToJsonElement(it.toString()).jsonObject }
        return JSONObject(json.encodeToString(MutationEnvelope(payloads)))
    }

    fun mutationBatch(mutations: JSONArray): JSONObject = mutationBatch(mutations.objects())
}
