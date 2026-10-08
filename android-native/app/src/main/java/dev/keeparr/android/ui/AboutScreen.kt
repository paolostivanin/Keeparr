package dev.keeparr.android.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.keeparr.android.BuildConfig
import dev.keeparr.android.R

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
        "AndroidSVG: Apache License 2.0")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AboutScreen(onBack: () -> Unit) {
    BackHandler(onBack = onBack)
    val uriHandler = LocalUriHandler.current
    Scaffold(topBar = {
        TopAppBar(title = { Text("About") }, navigationIcon = {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, contentDescription = "Back") }
        })
    }) { padding ->
        Column(Modifier.padding(padding).fillMaxSize().verticalScroll(rememberScrollState()).padding(bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally) {
            Spacer(Modifier.height(16.dp))
            Box(Modifier.size(96.dp).clip(RoundedCornerShape(26.dp)).background(Color(0xFFFBBC04))) {
                Image(painterResource(R.drawable.ic_launcher_foreground), contentDescription = null, Modifier.fillMaxSize())
            }
            Spacer(Modifier.height(16.dp))
            Text("Keeparr", style = MaterialTheme.typography.headlineMedium)
            Text("Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(AboutInfo.TAGLINE, Modifier.padding(horizontal = 32.dp, vertical = 8.dp), textAlign = TextAlign.Center,
                style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            SettingsSection("Origin") {
                SettingsRow(Icons.Outlined.Info, "Derived from Kept", AboutInfo.ORIGIN)
                SettingsDivider()
                SettingsRow(Icons.Outlined.Code, "Original project (Kept)", AboutInfo.UPSTREAM_URL.removePrefix("https://"),
                    onClick = { uriHandler.openUri(AboutInfo.UPSTREAM_URL) })
            }
            SettingsSection("Licence and source") {
                SettingsRow(Icons.Outlined.Gavel, "License", AboutInfo.LICENSE, onClick = { uriHandler.openUri(AboutInfo.LICENSE_URL) })
                SettingsDivider()
                SettingsRow(Icons.Outlined.Code, "Source code", AboutInfo.SOURCE_URL.removePrefix("https://"),
                    onClick = { uriHandler.openUri(AboutInfo.SOURCE_URL) })
            }
            SettingsSection("Credits") {
                SettingsRow(Icons.Outlined.Favorite, "UI scaffolding", AboutInfo.SCAFFOLD, onClick = { uriHandler.openUri(AboutInfo.SCAFFOLD_URL) })
                SettingsDivider()
                SettingsRow(Icons.Outlined.Inventory2, "Open-source libraries", AboutInfo.LIBRARIES.joinToString("\n"))
            }
        }
    }
}
