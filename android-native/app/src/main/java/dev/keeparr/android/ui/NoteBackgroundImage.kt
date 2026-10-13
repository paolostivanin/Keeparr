package dev.keeparr.android.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import com.caverock.androidsvg.PreserveAspectRatio
import com.caverock.androidsvg.RenderOptions
import com.caverock.androidsvg.SVG
import dev.keeparr.android.data.NoteBackground

/** Where cover-scaled art is anchored: the web uses right bottom on cards, center bottom in the open note. */
internal enum class BackgroundAnchor(val preserve: String) {
    BottomEnd("xMaxYMax slice"), BottomCenter("xMidYMax slice"), Center("xMidYMid slice")
}

/** Parsed background art, shared by every card and the editor. Parsing is the expensive part; drawing is not. */
internal object BackgroundArt {
    private val cache = LruCache<String, SVG>(24)

    /** The SVG for [background], from the `_dark` asset when the web generator produced one, else darkened here. */
    fun load(context: Context, background: NoteBackground, dark: Boolean, thumbnail: Boolean): SVG? {
        val key = background.asset(dark, thumbnail)
        synchronized(cache) { cache.get(key)?.let { return it } }
        val svg = runCatching { SVG.getFromString(text(context, background, dark, thumbnail)) }.getOrNull() ?: return null
        synchronized(cache) { cache.put(key, svg) }
        return svg
    }

    internal fun text(context: Context, background: NoteBackground, dark: Boolean, thumbnail: Boolean): String {
        fun read(name: String) = runCatching { context.assets.open("backgrounds/$name").bufferedReader().use { it.readText() } }.getOrNull()
        val light = { read(background.asset(false, thumbnail)) ?: error("Missing background ${background.key}") }
        return if (dark) read(background.asset(true, thumbnail)) ?: NoteBackground.darken(light()) else light()
    }
}

/**
 * Draws [background] behind the content like CSS `background-size: cover`: scaled to fill, cropped on the side that overflows
 * and anchored at [anchor]. Null draws nothing.
 */
@Composable
internal fun Modifier.noteBackgroundImage(background: NoteBackground?, dark: Boolean, thumbnail: Boolean = false, anchor: BackgroundAnchor = BackgroundAnchor.BottomEnd): Modifier {
    if (background == null) return this
    val context = LocalContext.current
    return drawWithCache {
        val width = size.width.toInt().coerceIn(1, MAX_SIDE)
        val height = size.height.toInt().coerceIn(1, MAX_SIDE)
        val bitmap = BackgroundArt.load(context, background, dark, thumbnail)?.let { svg ->
            Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888).also { target ->
                svg.renderToCanvas(Canvas(target), RenderOptions.create()
                    .viewPort(0f, 0f, width.toFloat(), height.toFloat()).preserveAspectRatio(PreserveAspectRatio.of(anchor.preserve)))
            }.asImageBitmap()
        }
        onDrawBehind { if (bitmap != null) drawImage(bitmap) }
    }
}

private const val MAX_SIDE = 2048
