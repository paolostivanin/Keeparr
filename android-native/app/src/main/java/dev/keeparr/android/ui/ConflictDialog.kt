package dev.keeparr.android.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.SyncProblem
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.data.ConflictResolution
import dev.keeparr.android.data.Outbox
import dev.keeparr.android.data.html.NoteHtml
import dev.keeparr.android.data.objects
import dev.keeparr.android.data.text
import dev.keeparr.android.ui.components.BannerTone
import dev.keeparr.android.ui.components.StatusBanner
import dev.keeparr.android.ui.components.rememberActionRunner
import org.json.JSONObject

/** Resolves one conflicted outbox entry: what the draft and the server each have, and what to keep. */
@Composable
internal fun ConflictDialog(app: KeeparrApplication, entry: Outbox, onDismiss: () -> Unit) {
    val result = remember(entry) { JSONObject(entry.conflict!!) }
    val latest = result.optJSONObject("latest")
    var error by remember(entry) { mutableStateOf<String?>(null) }
    var busy by remember(entry) { mutableStateOf(false) }
    val action = rememberActionRunner { error = it; busy = false }
    val primaryResolution = when (entry.type) {
        "note.upsert" -> if (latest == null) ConflictResolution.SAVE_AS_COPY else ConflictResolution.REPLACE_WITH_DRAFT
        "reminder.upsert" -> if (latest == null) ConflictResolution.DISCARD else ConflictResolution.REPLACE_WITH_DRAFT
        "media.upload" -> ConflictResolution.SAVE_AS_COPY
        else -> ConflictResolution.DISCARD
    }
    val primaryLabel = when (entry.type) {
        "note.upsert" -> if (latest == null) "Save draft as copy" else "Replace server version"
        "reminder.upsert" -> if (latest == null) "Discard schedule" else "Keep my schedule"
        "media.upload" -> "Save as copy"
        "reminder.action" -> "Discard outdated action"
        "note.view-state" -> "Use server preference"
        else -> "Resolve"
    }
    fun resolveWith(choice: ConflictResolution) {
        busy = true
        error = null
        action {
            app.repository.resolve(entry, choice)
            app.repository.sync()
            onDismiss()
        }
    }
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, icon = { Icon(Icons.Outlined.SyncProblem, null) },
        title = { Text("Keep your draft safe") },
        text = { Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
            Text(result.text("error", "This edit conflicts with a newer version."))
            when (entry.type) {
                "note.upsert" -> {
                    val draft = JSONObject(entry.payload)
                    VersionBlock("Your draft", NoteHtml.titleText(draft.text("noteTitle")), NoteHtml.previewText(draft.text("noteBody")))
                    latest?.let { server ->
                        VersionBlock("Server version", NoteHtml.titleText(server.text("noteTitle")), NoteHtml.previewText(server.text("noteBody")))
                        val localItems = draft.optJSONArray("checkBoxes")?.objects().orEmpty().associateBy { it.optLong("id") }
                        val serverItems = server.optJSONArray("checkBoxes")?.objects().orEmpty().associateBy { it.optLong("id") }
                        val differing = (localItems.keys + serverItems.keys).filter { id ->
                            localItems[id]?.toString() != serverItems[id]?.toString()
                        }
                        if (differing.isNotEmpty()) VersionBlock("Checklist differences", null, differing.take(30).joinToString("\n") { id ->
                            val localText = localItems[id]?.opt("data")?.toString() ?: "(missing)"
                            val serverText = serverItems[id]?.opt("data")?.toString() ?: "(missing)"
                            "Item $id · yours: $localText · server: $serverText"
                        }, maxLines = 30)
                    }
                }
                "media.upload" -> {
                    val upload = JSONObject(entry.payload)
                    VersionBlock("Pending file", upload.text("name", "attachment"),
                        "You can save the local note and file as a new note on this account, or discard the pending upload.")
                }
                "reminder.upsert" -> {
                    val local = JSONObject(entry.payload)
                    VersionBlock("Your schedule", null, "${local.text("dueAtUtc")} · ${local.text("repeatRule", "once")}")
                    latest?.let { VersionBlock("Server schedule", null, "${it.text("dueAtUtc")} · ${it.text("repeatRule", "once")}") }
                }
                "reminder.action" -> Text("This reminder action is no longer valid for the current schedule. The reminder itself is unchanged.")
            }
            error?.let { StatusBanner(it, tone = BannerTone.Error) }
        } },
        // Long labels, so the choices stack instead of squeezing into one row.
        confirmButton = { Column(horizontalAlignment = Alignment.End) {
            TextButton(onClick = { resolveWith(primaryResolution) }, enabled = !busy) { Text(primaryLabel) }
            if (entry.type == "note.upsert" && latest != null) {
                TextButton(onClick = { resolveWith(ConflictResolution.SAVE_AS_COPY) }, enabled = !busy) { Text("Save as copy") }
            }
            TextButton(onClick = { resolveWith(if (latest != null) ConflictResolution.USE_SERVER else ConflictResolution.DISCARD) }, enabled = !busy) {
                Text(if (latest != null) "Use server version" else "Discard")
            }
        } })
}

/** One side of a conflict: a labelled tonal block with an optional title and a preview. */
@Composable
private fun VersionBlock(label: String, title: String?, preview: String, maxLines: Int = 6) {
    Surface(Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.card, color = MaterialTheme.colorScheme.surfaceContainerHighest) {
        Column(Modifier.padding(Dimens.cardPadding), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            title?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.titleSmall) }
            if (preview.isNotBlank()) Text(preview, style = MaterialTheme.typography.bodyMedium, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
        }
    }
}
