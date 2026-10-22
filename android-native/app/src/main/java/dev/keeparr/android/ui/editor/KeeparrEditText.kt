package dev.keeparr.android.ui.editor

import android.content.ClipData
import android.content.Context
import android.graphics.Canvas
import android.graphics.Rect
import android.graphics.RectF
import android.net.Uri
import android.text.Editable
import android.text.InputType
import android.text.Selection
import android.text.Spanned
import android.text.TextWatcher
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper
import android.widget.EditText
import dev.keeparr.android.data.html.Doc
import dev.keeparr.android.data.html.BlockSpan
import dev.keeparr.android.data.html.LineRange
import dev.keeparr.android.data.html.EditCause
import dev.keeparr.android.data.html.EmbedSpan
import dev.keeparr.android.data.html.InlineTagSpan
import dev.keeparr.android.data.html.HtmlMode
import dev.keeparr.android.data.html.RichTextController

/**
 * The editable surface of the note body and of checklist rows. It owns a [RichTextController] and keeps every change on
 * the document going through it: typed text, Enter, Backspace at a line start (which the keyboard reports as a delete
 * request or a key event), paste and drop (always plain text), and taps on embeds.
 */
class KeeparrEditText(context: Context, val mode: HtmlMode) : EditText(context) {
    val controller = RichTextController(mode)

    /** Called after every change to the document, typed or programmatic. */
    var onDocumentChanged: (() -> Unit)? = null
    var onSelectionUpdated: ((Int, Int) -> Unit)? = null
    var onCaretRect: ((Rect) -> Unit)? = null
    /** An embed was tapped; [onRemove] is true for the corner handle of an image. */
    var onEmbedTap: ((span: EmbedSpan, offset: Int, onRemove: Boolean) -> Unit)? = null
    var onLinkTap: ((String) -> Unit)? = null
    var onImageContent: ((Uri, String) -> Unit)? = null
    /** Rows only: Backspace with the caret at the very start of the row. Return true when it was handled. */
    var onBackspaceAtStart: (() -> Boolean)? = null

    // The platform calls onSelectionChanged from the superclass constructor, before the fields below exist.
    private var constructed = false
    private var suppress = 0
    private var snapshot: RichTextController.Snapshot? = null
    private var insertedStart = 0
    private var insertedCount = 0
    internal var deferNextDocumentChange = false
    private var touchDownX = 0f
    private var touchDownY = 0f

    private val watcher = object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {
            if (suppress > 0 || controller.isApplying || s !is Spanned) { snapshot = null; return }
            snapshot = controller.capture(s, start, start + count)
        }

        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
            insertedStart = start
            insertedCount = count
        }

        override fun afterTextChanged(editable: Editable) {
            if (suppress > 0 || controller.isApplying) return
            val captured = snapshot ?: return
            snapshot = null
            val pastedLines = insertedCount > 1 && editable.subSequence(insertedStart, insertedStart + insertedCount).contains('\n')
            suppress++
            try { controller.afterChange(editable, captured, insertedCount, if (pastedLines) EditCause.Paste else EditCause.Typed) }
            finally { suppress-- }
            if (deferNextDocumentChange) { deferNextDocumentChange = false; return }
            documentChanged()
        }
    }

    init {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        background = null
        gravity = android.view.Gravity.TOP or android.view.Gravity.START
        addTextChangedListener(watcher)
        setOnReceiveContentListener(arrayOf("text/*", "image/*")) { _, payload ->
            val clip: ClipData = payload.clip
            val description = clip.description
            val text = StringBuilder()
            for (i in 0 until clip.itemCount) {
                val item = clip.getItemAt(i)
                val uri = item.uri
                val mime = if (i < description.mimeTypeCount) description.getMimeType(i) else description.getMimeType(0)
                if (uri != null && item.text == null && mime.startsWith("image/")) onImageContent?.invoke(uri, mime)
                else {
                    if (text.isNotEmpty()) text.append('\n')
                    text.append(item.coerceToText(context))
                }
            }
            if (text.isNotEmpty()) insertPlain(text)
            null
        }
        setOnKeyListener { _, keyCode, event ->
            keyCode == KeyEvent.KEYCODE_DEL && event.action == KeyEvent.ACTION_DOWN && !event.isShiftPressed && interceptBackspace()
        }
        constructed = true
    }

    // ---- document -----------------------------------------------------------------------------------------

    /** Replaces the whole document without running the editing rules. */
    fun setDocument(document: Spanned, keepSelection: Boolean = false) {
        val start = selectionStart.coerceAtLeast(0)
        val end = selectionEnd.coerceAtLeast(0)
        suppress++
        try { setText(document, BufferType.EDITABLE) } finally { suppress-- }
        if (keepSelection) setSelection(start.coerceAtMost(length()), end.coerceAtMost(length()))
        applyEmbedWidth()
    }

    /** Runs [block] (a controller command) without the text watcher also reacting, then reports the change. */
    fun <T> edit(block: (Editable) -> T): T {
        suppress++
        val result = try { block(text) } finally { suppress-- }
        documentChanged()
        return result
    }

    fun insertPlain(raw: CharSequence) {
        edit { controller.paste(it, selectionStart.coerceAtLeast(0), selectionEnd.coerceAtLeast(0), raw) }
    }

    private fun documentChanged() {
        applyEmbedWidth()
        invalidate()
        onDocumentChanged?.invoke()
        reportCaret()
    }

    private fun interceptBackspace(): Boolean {
        val caret = selectionStart
        if (caret < 0 || caret != selectionEnd) return false
        if (mode == HtmlMode.Row) return caret == 0 && onBackspaceAtStart?.invoke() == true
        suppress++
        val handled = try { controller.handleBackspaceAtLineStart(text, caret) } finally { suppress-- }
        if (handled) documentChanged()
        return handled
    }

    // ---- keyboard -----------------------------------------------------------------------------------------

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        val target = super.onCreateInputConnection(outAttrs) ?: return null
        return object : InputConnectionWrapper(target, true) {
            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean =
                (beforeLength > 0 && afterLength == 0 && interceptBackspace()) || super.deleteSurroundingText(beforeLength, afterLength)

            override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
                (beforeLength > 0 && afterLength == 0 && interceptBackspace()) || super.deleteSurroundingTextInCodePoints(beforeLength, afterLength)

            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_DEL) {
                    if (event.action == KeyEvent.ACTION_DOWN && interceptBackspace()) return true
                }
                return super.sendKeyEvent(event)
            }
        }
    }

    // ---- selection, caret and embeds ----------------------------------------------------------------------------

    private fun emptyFinalBlock(): BlockSpan? {
        if (mode != HtmlMode.Body || (text.isNotEmpty() && text.last() != '\n')) return null
        return Doc.spanAt(text, LineRange(length(), length()))?.takeIf { it.markerOnly && it.contentInset > 0 }
    }

    /**
     * Layout deliberately ignores paragraph spans on a trailing empty line. Keep its zero-length block metadata
     * out of the preceding paragraph's margins, and paint this line explicitly. The clipped second pass moves the
     * platform's cursor (including its blink) and hint together; the document and IME offsets stay unchanged.
     */
    override fun onDraw(canvas: Canvas) {
        val block = emptyFinalBlock()
        val layout = layout
        if (block == null || layout == null) { super.onDraw(canvas); return }
        val line = layout.getLineForOffset(length())
        val top = layout.getLineTop(line) + totalPaddingTop
        val bottom = layout.getLineBottom(line) + totalPaddingTop
        val direction = layout.getParagraphDirection(line)
        val inset = direction * block.contentInset.toFloat()
        val saved = canvas.save()
        canvas.clipOutRect(scrollX.toFloat(), top.toFloat(), (scrollX + width).toFloat(), bottom.toFloat())
        super.onDraw(canvas)
        canvas.restoreToCount(saved)
        val lastLine = canvas.save()
        canvas.clipRect(scrollX.toFloat(), top.toFloat(), (scrollX + width).toFloat(), bottom.toFloat())
        canvas.translate(inset, 0f)
        super.onDraw(canvas)
        canvas.restoreToCount(lastLine)
        val color = paint.color
        paint.color = currentTextColor
        val x = totalPaddingLeft + if (direction > 0) 0 else layout.width
        block.drawDecoration(canvas, paint, x, direction, top,
            layout.getLineBaseline(line) + totalPaddingTop, bottom)
        paint.color = color
    }

    private fun caretHorizontal(caret: Int): Int {
        val layout = layout ?: return totalPaddingLeft
        val extra = if (caret == length()) emptyFinalBlock()?.contentInset ?: 0 else 0
        val direction = layout.getParagraphDirection(layout.getLineForOffset(caret))
        return layout.getPrimaryHorizontal(caret).toInt() + totalPaddingLeft + direction * extra
    }

    override fun onSelectionChanged(selStart: Int, selEnd: Int) {
        super.onSelectionChanged(selStart, selEnd)
        if (!constructed || selStart < 0 || selEnd < 0) return
        controller.onSelectionChanged(selStart, selEnd)
        onSelectionUpdated?.invoke(selStart, selEnd)
        reportCaret()
    }

    private fun reportCaret() {
        val callback = onCaretRect ?: return
        val layout = layout ?: return
        val caret = selectionEnd
        if (caret < 0 || caret > length()) return
        val line = layout.getLineForOffset(caret)
        val x = caretHorizontal(caret)
        callback(Rect(x, layout.getLineTop(line) + totalPaddingTop, x + 2, layout.getLineBottom(line) + totalPaddingTop))
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        applyEmbedWidth()
    }

    /** Embeds are as wide as the text area; changing that changes their height, so the layout is redone. */
    fun applyEmbedWidth() {
        val width = width - totalPaddingLeft - totalPaddingRight
        if (width <= 0) return
        val spans = text.getSpans(0, text.length, EmbedSpan::class.java)
        var changed = false
        for (span in spans) if (span.maxWidth != width) { span.maxWidth = width; changed = true }
        if (changed) post { requestLayout(); invalidate() }
    }

    /** Re-measures after an embed's image arrived. */
    fun embedChanged() { requestLayout(); invalidate() }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> { touchDownX = event.x; touchDownY = event.y }
            MotionEvent.ACTION_UP -> {
                val slop = ViewConfiguration.get(context).scaledTouchSlop
                if (Math.abs(event.x - touchDownX) <= slop && Math.abs(event.y - touchDownY) <= slop) tapAt(event.x, event.y)
            }
        }
        return super.onTouchEvent(event)
    }

    private fun tapAt(x: Float, y: Float) {
        val layout = layout ?: return
        val line = layout.getLineForVertical((y - totalPaddingTop + scrollY).toInt())
        val offset = layout.getOffsetForHorizontal(line, x - totalPaddingLeft).coerceIn(0, (text.length - 1).coerceAtLeast(0))
        val link = text.getSpans(offset, (offset + 1).coerceAtMost(text.length), InlineTagSpan::class.java).lastOrNull { it.link }
        val href = link?.attrs?.firstOrNull { it.name == "href" }?.value
        if (!href.isNullOrBlank() && onLinkTap != null) { onLinkTap?.invoke(href); return }
        val listener = onEmbedTap ?: return
        val span = Doc.embedAt(text, offset) ?: return
        val top = layout.getLineTop(line) + totalPaddingTop.toFloat()
        val bottom = layout.getLineBottom(line) + totalPaddingTop.toFloat()
        if (y < top || y > bottom) return
        val area = RectF(totalPaddingLeft.toFloat(), top, totalPaddingLeft + span.maxWidth.toFloat(), bottom)
        val onRemove = span.data.kind == dev.keeparr.android.data.html.EmbedKind.Image &&
            span.removeHandle(span.imageBounds(area)).contains(x, y)
        listener(span, offset, onRemove)
    }

    /** Where the caret is, for bring-into-view. */
    fun caretRect(): Rect? {
        val layout = layout ?: return null
        val caret = selectionEnd.coerceIn(0, length())
        val line = layout.getLineForOffset(caret)
        val x = caretHorizontal(caret)
        return Rect(x, layout.getLineTop(line) + totalPaddingTop, x + 2, layout.getLineBottom(line) + totalPaddingTop)
    }

    fun moveCaretToEnd() { Selection.setSelection(text, text.length) }
}
