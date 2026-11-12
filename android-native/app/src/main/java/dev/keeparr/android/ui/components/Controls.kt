package dev.keeparr.android.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.outlined.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.keeparr.android.R
import dev.keeparr.android.ui.Spacing
import dev.keeparr.android.ui.chip
import dev.keeparr.android.ui.extendedColors

/** The app icon on its brand-yellow tile, for the sign-in screen, the drawer and About. */
@Composable
internal fun BrandMark(size: Dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(RoundedCornerShape(size * 0.27f)).background(MaterialTheme.extendedColors.brand)) {
        Image(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, Modifier.fillMaxSize())
    }
}

/** A small label for a group of content: "Pinned", "Labels", "Server". */
@Composable
internal fun SectionHeader(text: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Text(text, modifier, style = MaterialTheme.typography.labelLarge, color = color)
}

/**
 * A compact pill for note metadata (a label, the binder, a reminder). Its colors come from the current content color, so the
 * same chip reads correctly on the app surface and on every note color. A clickable chip keeps a 48dp touch target.
 */
@Composable
internal fun MetaChip(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null, dense: Boolean = false,
    onClick: (() -> Unit)? = null) {
    val content = LocalContentColor.current
    val color = content.copy(alpha = .07f)
    val border = BorderStroke(1.dp, content.copy(alpha = .18f))
    val body: @Composable () -> Unit = {
        Row(Modifier.heightIn(min = if (dense) 24.dp else 32.dp).padding(horizontal = if (dense) Spacing.sm else Spacing.md),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs + Spacing.xxs)) {
            icon?.let { Icon(it, null, Modifier.size(if (dense) 14.dp else 16.dp)) }
            Text(text, style = if (dense) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelMedium,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    if (onClick != null) Surface(onClick = onClick, modifier = modifier, shape = MaterialTheme.shapes.chip, color = color,
        contentColor = content, border = border, content = body)
    else Surface(modifier, shape = MaterialTheme.shapes.chip, color = color, contentColor = content, border = border, content = body)
}

/** A password or passcode field with a show/hide toggle and an IME action that runs [onImeAction]. */
@Composable
internal fun PasswordField(value: String, onValueChange: (String) -> Unit, label: String, modifier: Modifier = Modifier,
    imeAction: ImeAction = ImeAction.Done, onImeAction: () -> Unit = {}, isError: Boolean = false, supportingText: String? = null,
    enabled: Boolean = true, leadingIcon: ImageVector? = null) {
    var visible by rememberSaveable { mutableStateOf(false) }
    OutlinedTextField(value, onValueChange, modifier, enabled = enabled, label = { Text(label) }, singleLine = true, isError = isError,
        supportingText = supportingText?.let { { Text(it) } }, leadingIcon = leadingIcon?.let { { Icon(it, null) } },
        visualTransformation = if (visible) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = imeAction, autoCorrectEnabled = false),
        keyboardActions = KeyboardActions(onAny = { onImeAction() }),
        trailingIcon = {
            IconButton(onClick = { visible = !visible }) {
                Icon(if (visible) Icons.Outlined.VisibilityOff else Icons.Outlined.Visibility, if (visible) "Hide $label" else "Show $label")
            }
        })
}

/**
 * The confirmation dialog every destructive or significant action uses. [error] shows inside the dialog (a snackbar would be
 * hidden behind its scrim), and [busy] disables both buttons while the action runs.
 */
@Composable
internal fun ConfirmDialog(title: String, text: String, confirmLabel: String, onConfirm: () -> Unit, onDismiss: () -> Unit,
    destructive: Boolean = false, dismissLabel: String = "Cancel", icon: ImageVector? = null, error: String? = null, busy: Boolean = false) {
    AlertDialog(onDismissRequest = { if (!busy) onDismiss() }, icon = icon?.let { { Icon(it, null) } }, title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.md)) {
                Text(text)
                error?.let { StatusBanner(it, tone = BannerTone.Error) }
            }
        },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = !busy, colors = if (destructive)
                ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error) else ButtonDefaults.textButtonColors()) {
                Text(confirmLabel)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text(dismissLabel) } })
}
