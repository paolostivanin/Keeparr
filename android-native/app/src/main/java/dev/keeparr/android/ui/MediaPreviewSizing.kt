package dev.keeparr.android.ui

import android.util.LruCache

/**
 * Decode size for a preview slot: the longest side of the space the image can occupy, rounded up to a bucket so small
 * layout changes (insets, rotation, split screen) reuse the cached decode instead of creating another bitmap per pixel
 * of width, and clamped to what the decoder accepts.
 */
internal fun previewDecodeSize(slotWidthPx: Int, slotHeightPx: Int, bucketPx: Int = 128, maxPx: Int = 2048): Int {
    val longest = maxOf(slotWidthPx, slotHeightPx).coerceAtLeast(1)
    val bucketed = ((longest + bucketPx - 1) / bucketPx) * bucketPx
    return bucketed.coerceIn(bucketPx, maxPx)
}

/** Aspect ratios of previews that have been shown, so a recycled lazy-list item reserves its final height at once. */
internal object PreviewGeometry {
    private const val DEFAULT_RATIO = 4f / 3f
    private val ratios = LruCache<String, Float>(512)

    fun remember(path: String, width: Int, height: Int) {
        if (width > 0 && height > 0) ratios.put(path.take(256) + path.hashCode(), width.toFloat() / height)
    }

    fun ratio(path: String): Float = ratios.get(path.take(256) + path.hashCode()) ?: DEFAULT_RATIO

    /** Height the slot occupies for [widthPx] columns of image, never more than [maxHeightPx]. */
    fun reservedHeightPx(path: String, widthPx: Int, maxHeightPx: Int): Int =
        (widthPx / ratio(path)).toInt().coerceIn(1, maxHeightPx.coerceAtLeast(1))
}
