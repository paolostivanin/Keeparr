package dev.keeparr.android.ui.editor

import dev.keeparr.android.data.html.appendAttributes
import dev.keeparr.android.data.html.HtmlAttr
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/** Uploads a staged image so that it can be referenced from the body; returns the server's `{url, name}`. */
fun interface InlineImageUploadPort {
    suspend fun upload(staged: JSONObject): JSONObject
}

/**
 * Inline images: online, the picture is uploaded now and the exact wrapper the web writes goes into the body at the caret;
 * offline (or when the upload fails), it falls back to the note's images array through the outbox, which both clients
 * render, and syncs later.
 */
object InlineImages {
    /** `<div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="..." alt="..."></div>` */
    fun wrapperHtml(url: String, name: String): String = StringBuilder("<div class=\"inline-note-image-wrap\" contenteditable=\"false\"><img class=\"inline-note-image\"").also {
        appendAttributes(it, listOf(HtmlAttr("src", url), HtmlAttr("alt", name)))
        it.append("></div>")
    }.toString()

    val imageMimeTypes = setOf("image/png", "image/jpeg", "image/gif", "image/webp")

    fun isInlineImage(staged: JSONObject) = staged.optString("mime") in imageMimeTypes

    sealed interface Outcome {
        class Inline(val html: String) : Outcome
        object Queued : Outcome
    }

    suspend fun place(staged: JSONObject, port: InlineImageUploadPort, queueOffline: suspend () -> Unit): Outcome {
        val uploaded = try { port.upload(staged) } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
        if (uploaded == null || uploaded.optString("url").isBlank()) { queueOffline(); return Outcome.Queued }
        return Outcome.Inline(wrapperHtml(uploaded.getString("url"), uploaded.optString("name")))
    }
}
