package dev.keeparr.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.keeparr.android.BuildConfig
import dev.keeparr.android.ui.components.BrandMark
import dev.keeparr.android.ui.components.SubpageScaffold
import dev.keeparr.android.ui.components.centeredMaxWidth
import dev.keeparr.android.ui.components.screenEnter

/** Attribution and licence facts shown in About. They mirror the repository's NOTICE file; keep the two in step. */
internal object AboutInfo {
    const val SOURCE_URL = "https://github.com/paolostivanin/Keeparr"
    const val UPSTREAM_URL = "https://github.com/ericerkz/kept"
    const val LICENSE_URL = "https://github.com/paolostivanin/Keeparr/blob/main/LICENSE"
    const val SCAFFOLD_URL = "https://github.com/aBrihoum/google-keep-clone"
    const val TAGLINE = "Self-hosted notes with a Google Keep-style feel."
    const val ORIGIN = "Keeparr is a modified derivative of Kept by ericerkz. This version contains substantial " +
        "modifications and additional copyrightable work by Paolo Stivanin and other contributors."
    const val LICENSE = "GNU Affero General Public License v3.0 only (AGPL-3.0-only)."
    const val SCAFFOLD = "Kept's initial UI scaffolding derives from google-keep-clone by aBrihoum (MIT License)."
    val LIBRARIES = listOf(
        "Jetpack Compose, Room, WorkManager, DataStore: Apache License 2.0",
        "OkHttp, kotlinx.serialization, kotlinx.coroutines: Apache License 2.0",
        "jsoup: MIT License",
        "AndroidSVG: Apache License 2.0",
        "Google Sans and Roboto fonts: SIL Open Font License 1.1")
}

@Composable
internal fun AboutScreen(onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val uriHandler = LocalUriHandler.current
    SubpageScaffold("About", onBack = onBack, modifier = Modifier.screenEnter()) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).centeredMaxWidth().padding(bottom = Spacing.xl),
            horizontalAlignment = Alignment.CenterHorizontally) {
            BrandMark(88.dp, Modifier.padding(top = Spacing.lg))
            Text("Keeparr", Modifier.padding(top = Spacing.lg), style = MaterialTheme.typography.headlineMedium)
            Text("Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(AboutInfo.TAGLINE, Modifier.padding(horizontal = Spacing.xxl, vertical = Spacing.sm), textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyMedium)
            SettingsSection("Origin") {
                SettingsRow(Icons.Outlined.Info, "Derived from Kept", AboutInfo.ORIGIN)
                SettingsDivider()
                SettingsRow(Icons.Outlined.Code, "Original project (Kept)", AboutInfo.UPSTREAM_URL.removePrefix("https://"), external = true,
                    onClick = { uriHandler.openUri(AboutInfo.UPSTREAM_URL) })
            }
            SettingsSection("Licence and source") {
                SettingsRow(Icons.Outlined.Gavel, "License", AboutInfo.LICENSE, external = true, onClick = { uriHandler.openUri(AboutInfo.LICENSE_URL) })
                SettingsDivider()
                SettingsRow(Icons.Outlined.Code, "Source code", AboutInfo.SOURCE_URL.removePrefix("https://"), external = true,
                    onClick = { uriHandler.openUri(AboutInfo.SOURCE_URL) })
            }
            SettingsSection("Credits") {
                SettingsRow(Icons.Outlined.FavoriteBorder, "UI scaffolding", AboutInfo.SCAFFOLD, external = true,
                    onClick = { uriHandler.openUri(AboutInfo.SCAFFOLD_URL) })
                SettingsDivider()
                SettingsRow(Icons.Outlined.Inventory2, "Open-source libraries", AboutInfo.LIBRARIES.joinToString("\n"))
            }
        }
    }
}
