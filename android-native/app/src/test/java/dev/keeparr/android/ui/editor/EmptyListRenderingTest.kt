package dev.keeparr.android.ui.editor

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.view.View
import android.view.inputmethod.EditorInfo
import dev.keeparr.android.data.html.HtmlMode
import dev.keeparr.android.data.html.NoteHtml
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34, 35])
class EmptyListRenderingTest {
    private fun withField(html: String, test: (KeeparrEditText) -> Unit) {
        val activity = Robolectric.buildActivity(Activity::class.java).setup()
        try {
            val view = KeeparrEditText(activity.get(), HtmlMode.Body).apply {
                setPadding(0, 0, 0, 0)
                setTextColor(Color.BLACK)
                textSize = 18f
                textCursorDrawable = GradientDrawable().apply { setColor(Color.RED); setSize(2, 24) }
                setDocument(NoteHtml.parse(html))
            }
            activity.get().setContentView(view)
            view.requestFocus()
            view.setSelection(view.length())
            test(view)
        } finally { activity.pause().stop().destroy() }
    }

    private fun draw(view: KeeparrEditText): Bitmap {
        view.measure(View.MeasureSpec.makeMeasureSpec(480, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(240, View.MeasureSpec.EXACTLY))
        view.layout(0, 0, 480, 240)
        return Bitmap.createBitmap(480, 240, Bitmap.Config.ARGB_8888).also {
            val canvas = Canvas(it)
            canvas.drawColor(Color.WHITE)
            view.draw(canvas)
        }
    }

    private fun assertEmptyItemVisible(view: KeeparrEditText, depth: Int = 1) {
        val bitmap = draw(view)
        val line = view.layout.lineCount - 1
        val inset = (20 * view.resources.displayMetrics.density * depth).toInt()
        val top = view.layout.getLineTop(line) + view.totalPaddingTop
        val bottom = view.layout.getLineBottom(line) + view.totalPaddingTop
        val report = java.io.File("build/reports/editor-rendering/empty-list-depth-$depth.png")
        report.parentFile!!.mkdirs()
        report.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        assertTrue("the empty item must paint its marker before typing",
            (top until bottom).any { y -> (0 until inset).any { x ->
                val pixel = bitmap.getPixel(x, y)
                Color.red(pixel) < 200 && Color.green(pixel) < 200 && Color.blue(pixel) < 200
            } })
        assertEquals("the caret must be indented before typing", inset, view.caretRect()!!.left)
        assertTrue("the native cursor must be drawn at the indented position",
            (top until bottom).any { y -> (inset until inset + 3).any { x -> bitmap.getPixel(x, y) == Color.RED } })
    }

    @Test fun startingAListShowsTheBulletAndCaretImmediately() = withField("") { view ->
        view.edit { view.controller.toggleBullet(it, 0, 0) }
        assertEmptyItemVisible(view)
        assertEquals("", view.text.toString())
        assertEquals("<ul><li><br></li></ul>", NoteHtml.serialize(view.text))
    }

    @Test fun enterShowsABulletBeforeTypingWithoutMovingThePreviousItem() = withField("<ul><li>first</li></ul>") { view ->
        draw(view)
        val margin = view.layout.getParagraphLeft(0)
        val input = view.onCreateInputConnection(EditorInfo())!!
        input.commitText("\n", 1)
        assertEmptyItemVisible(view)
        assertEquals(margin, view.layout.getParagraphLeft(0))
        val caret = view.caretRect()!!.left
        input.commitText("next", 1)
        draw(view)
        assertEquals(caret, view.layout.getParagraphLeft(1))
        assertEquals("<ul><li>first</li><li>next</li></ul>", NoteHtml.serialize(view.text))
        repeat(4) { input.deleteSurroundingText(1, 0) }
        assertEmptyItemVisible(view)
        input.commitText("\n", 1)
        draw(view)
        assertEquals("<ul><li>first</li></ul><div><br></div>", NoteHtml.serialize(view.text))
        assertEquals(0, view.caretRect()!!.left)
    }

    @Test fun anEmptyNestedWebItemRendersAtItsOwnDepth() = withField("<ul><li>parent<ul><li><br></li></ul></li></ul>") { view ->
        assertEmptyItemVisible(view, depth = 2)
        val originalMargin = view.layout.getParagraphLeft(0)
        view.onCreateInputConnection(EditorInfo())!!.commitText("\n", 1)
        assertEmptyItemVisible(view)
        assertEquals("<ul><li>parent</li><li><br></li></ul>", NoteHtml.serialize(view.text))
        view.edit { view.controller.toggleBullet(it, view.length(), view.length()) }
        draw(view)
        assertEquals("toggling the empty item never shifts its parent", originalMargin, view.layout.getParagraphLeft(0))
    }

    @Test fun manuallyBulletingAnEmptyLineDoesNotBulletOrIndentThePlainLineAbove() = withField("<div>plain</div>") { view ->
        draw(view)
        val originalMargin = view.layout.getParagraphLeft(0)
        view.onCreateInputConnection(EditorInfo())!!.commitText("\n", 1)
        view.edit { view.controller.toggleBullet(it, view.length(), view.length()) }
        assertEmptyItemVisible(view)
        assertEquals(originalMargin, view.layout.getParagraphLeft(0))
        assertEquals("<div>plain</div><ul><li><br></li></ul>", NoteHtml.serialize(view.text))
        view.setDocument(NoteHtml.parse(NoteHtml.serialize(view.text)), keepSelection = true)
        assertEmptyItemVisible(view)
    }
}
