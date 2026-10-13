package dev.keeparr.android.ui.editor

import android.graphics.Bitmap
import android.text.Spanned
import dev.keeparr.android.KeeparrApplication
import dev.keeparr.android.data.Media
import dev.keeparr.android.data.html.EmbedKind
import dev.keeparr.android.data.html.EmbedSpan
import dev.keeparr.android.ui.PreviewGeometry
import dev.keeparr.android.ui.previewDecodeSize
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Gives the image embeds of an editor their bitmaps. Pictures come from the authenticated, cached preview pipeline; until
 * one arrives the span reserves the height remembered for that picture so the text does not jump when it shows up.
 */
class EmbedBinder(private val scope: CoroutineScope, private val load: suspend (src: String, maxDimension: Int) -> Bitmap?) {
    constructor(app: KeeparrApplication, scope: CoroutineScope) : this(scope, { src, size -> Media(app).preview(src, maxDimension = size) })

    private val loading = HashSet<EmbedSpan>()

    fun bind(view: KeeparrEditText) {
        val text = view.text
        for (span in text.getSpans(0, text.length, EmbedSpan::class.java)) {
            if (span.data.kind != EmbedKind.Image || span.bitmap != null || !loading.add(span)) continue
            span.ratio = PreviewGeometry.ratio(span.data.src)
            scope.launch {
                val bitmap = try { load(span.data.src, previewDecodeSize(view.width, span.maxHeight)) } finally { loading.remove(span) }
                if (bitmap != null) {
                    PreviewGeometry.remember(span.data.src, bitmap.width, bitmap.height)
                    span.bitmap = bitmap
                    reflow(view, span)
                }
            }
        }
    }

    /** Removing and setting the span again makes the layout measure it anew, without a text change event. */
    private fun reflow(view: KeeparrEditText, span: EmbedSpan) {
        val text = view.text
        val start = text.getSpanStart(span)
        val end = text.getSpanEnd(span)
        if (start < 0) { view.invalidate(); return }
        text.removeSpan(span)
        text.setSpan(span, start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        view.embedChanged()
    }
}
