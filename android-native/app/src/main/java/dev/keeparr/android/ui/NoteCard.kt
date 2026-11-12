package dev.keeparr.android.ui

import android.graphics.Bitmap
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.data.Media
import dev.keeparr.android.data.NotePalette
import dev.keeparr.android.ui.components.MetaChip

/** Labels shown on a card before the rest are summed up as "+N". */
private const val CARD_LABELS = 3

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
internal fun NoteCard(app: KeeparrApplication, note: NoteCardUiModel, modifier: Modifier, selected: Boolean, selecting: Boolean,
    reorderEnabled: Boolean, reorder: NoteReorderController, onClick: () -> Unit, onLongClick: () -> Unit, onMove: (Int) -> Unit,
    canMove: (Int) -> Boolean) {
    DisposableEffect(note.syncId, reorder) { onDispose { reorder.disposed(note.syncId) } }
    // Only this card's own highlight state is observed, so a changing drop target recomposes just two cards.
    val dragging by remember(note.syncId, reorder) { derivedStateOf { reorder.draggingId == note.syncId } }
    val dropTarget by remember(note.syncId, reorder) { derivedStateOf { reorder.targetId == note.syncId } }
    // The stored color is data; the dark variant is derived here at render time.
    val displayed = note.colorArgb?.let { NotePalette.display(it, LocalDarkTheme.current) }
    val color = displayed?.let { Color(it) } ?: MaterialTheme.colorScheme.surface
    val foreground = if (note.hasBackgroundImage) MaterialTheme.colorScheme.onSurface
        else displayed?.let { Color(NotePalette.textColor(it)) } ?: MaterialTheme.colorScheme.onSurface
    val highlighted = selected || dropTarget
    val shape = MaterialTheme.shapes.card
    // A colored note gets a hairline in its own text color, so the border stays soft on every swatch in light and dark.
    val outline = if (note.colorArgb != null) foreground.copy(alpha = .14f) else MaterialTheme.colorScheme.outlineVariant
    val body = MaterialTheme.typography.bodyMedium
    val muted = foreground.copy(alpha = .7f)
    // The press ripple is drawn by the clickable, outside the Surface, so it takes the card's text color and its rounded clip from here.
    CompositionLocalProvider(LocalContentColor provides foreground) {
    Surface(shape = shape, color = color, contentColor = foreground,
        border = BorderStroke(if (highlighted) 2.dp else 1.dp, if (highlighted) MaterialTheme.colorScheme.primary else outline),
        modifier = modifier.fillMaxWidth().alpha(if (dragging) .6f else 1f)
            .onGloballyPositioned { reorder.positioned(note.syncId, it.boundsInWindow()) }
            .clip(shape)
            .combinedClickable(onClick = onClick, onLongClick = onLongClick,
                onClickLabel = when { !selecting -> "Open note"; selected -> "Deselect"; else -> "Select" },
                onLongClickLabel = if (reorderEnabled) "Select, or drag to reorder" else "Select")
            .semantics {
                this.selected = selected
                // Dragging is not available to every user, so the same moves are exposed as accessibility actions.
                if (reorderEnabled) customActions = listOfNotNull(
                    CustomAccessibilityAction("Move earlier") { onMove(-1); true }.takeIf { canMove(-1) },
                    CustomAccessibilityAction("Move later") { onMove(1); true }.takeIf { canMove(1) })
            }) {
        Box {
            Column(Modifier.noteBackgroundImage(note.background.takeUnless { note.locked }, LocalDarkTheme.current)) {
                if (note.locked) Row(Modifier.padding(Dimens.cardPadding), verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                    Icon(Icons.Outlined.Lock, null, Modifier.size(Dimens.iconSmall))
                    Text("Locked note", style = body)
                }
                else {
                    // The picture runs to the card's edges, like a cover; the text keeps the card padding below it.
                    note.imagePath?.let { MediaImage(app, it, contentScale = ContentScale.Crop) }
                    val labels = note.labels
                    val hasFooter = note.reminderText != null || labels.isNotEmpty() || note.shared
                    val hasText = note.title.isNotBlank() || note.bodyText.isNotBlank() || note.checklistItems.isNotEmpty() || note.completedCount > 0
                    if (hasText || hasFooter || note.imagePath == null) Column(Modifier.padding(Dimens.cardPadding),
                        verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                        if (note.title.isNotBlank()) Text(note.title, style = MaterialTheme.typography.titleMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                        if (note.bodyText.isNotBlank()) Text(note.bodyText, style = body, maxLines = 12, overflow = TextOverflow.Ellipsis)
                        if (note.checklistItems.isNotEmpty()) Column(verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                            note.checklistItems.forEach { item -> Row(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                                // The box is as tall as one text line and scales with the font size, so it stays centered on the first line.
                                Box(Modifier.height(textDp(body.lineHeight)), contentAlignment = Alignment.Center) {
                                    Icon(if (item.done) Icons.Outlined.CheckBox else Icons.Outlined.CheckBoxOutlineBlank,
                                        if (item.done) "Completed" else "Not completed", Modifier.size(textDp(18.sp)),
                                        tint = if (item.done) muted else foreground)
                                }
                                Text(item.text, style = if (item.done) body.copy(textDecoration = TextDecoration.LineThrough) else body,
                                    color = if (item.done) muted else Color.Unspecified, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            } }
                        }
                        // The same wording as the editor, the widget and the web.
                        if (note.completedCount > 0) Text("(${note.completedCount}) Completed items",
                            style = MaterialTheme.typography.labelMedium, color = muted)
                        if (hasFooter) FlowRow(Modifier.padding(top = Spacing.xxs), horizontalArrangement = Arrangement.spacedBy(Spacing.xs + Spacing.xxs),
                            verticalArrangement = Arrangement.spacedBy(Spacing.xs + Spacing.xxs)) {
                            note.reminderText?.let { MetaChip(it, icon = Icons.Outlined.Schedule, dense = true) }
                            labels.take(CARD_LABELS).forEach { MetaChip(it, dense = true) }
                            if (labels.size > CARD_LABELS) MetaChip("+${labels.size - CARD_LABELS}", dense = true)
                            if (note.shared) Box(Modifier.height(24.dp), contentAlignment = Alignment.Center) {
                                Icon(Icons.Outlined.PeopleOutline, "Shared note", Modifier.size(Dimens.iconSmall), tint = muted)
                            }
                        }
                    }
                }
            }
            if (selected) Icon(Icons.Filled.CheckCircle, null, Modifier.align(Alignment.TopEnd).padding(Spacing.xs + Spacing.xxs)
                .size(22.dp).background(color, CircleShape), tint = MaterialTheme.colorScheme.primary)
        }
    }
    }
}

@Composable
internal fun textDp(size: TextUnit) = with(LocalDensity.current) { size.toDp() }

@Composable
internal fun MediaImage(app: KeeparrApplication, path: String, maxHeight: Dp = 240.dp, contentScale: ContentScale = ContentScale.Fit) {
    val profile = app.settings.profile
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val density = LocalDensity.current
        val maxHeightPx = with(density) { maxHeight.roundToPx() }
        val widthPx = constraints.maxWidth
        // Decode for the space this slot can actually fill, not a fixed size.
        val decodeSize = previewDecodeSize(widthPx, maxHeightPx)
        var bitmap by remember(profile, path) { mutableStateOf<Bitmap?>(null) }
        var failed by remember(profile, path) { mutableStateOf(false) }
        var attempt by remember(profile, path) { mutableIntStateOf(0) }
        LaunchedEffect(profile, path, decodeSize, attempt) {
            val loaded = Media(app).preview(path, maxDimension = decodeSize)
            if (loaded != null) { PreviewGeometry.remember(path, loaded.width, loaded.height); bitmap = loaded; failed = false }
            else if (bitmap == null) failed = true
        }
        val current = bitmap
        if (current != null) Image(current.asImageBitmap(), "Note image", Modifier.fillMaxWidth().heightIn(max = maxHeight), contentScale = contentScale)
        else {
            // Loading and failure keep the height the loaded image will take, so the card does not jump.
            val reserved = with(density) { PreviewGeometry.reservedHeightPx(path, widthPx, maxHeightPx).toDp() }
            Box(Modifier.fillMaxWidth().height(reserved).background(LocalContentColor.current.copy(alpha = .05f)), contentAlignment = Alignment.Center) {
                if (failed) TextButton(onClick = { failed = false; attempt++ }, modifier = Modifier.semantics {
                    contentDescription = "Image could not be loaded. Tap to retry."
                }) { Icon(Icons.Outlined.BrokenImage, null); Text("Retry", Modifier.padding(start = Spacing.xs + Spacing.xxs)) }
                else CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            }
        }
    }
}
