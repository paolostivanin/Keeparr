package dev.keeparr.android.data

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import dev.keeparr.android.ui.noteAccent
import dev.keeparr.android.ui.noteColorScheme
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NotePaletteTest {
    @Test fun parsesHexInEveryLength() {
        assertEquals(0xFFCBF0F8.toInt(), NotePalette.parse("#cbf0f8"))
        assertEquals(0xFFCBF0F8.toInt(), NotePalette.parse("#CBF0F8"))
        assertEquals(0xFFCBF0F8.toInt(), NotePalette.parse("cbf0f8"))
        assertEquals(0xFFAABBCC.toInt(), NotePalette.parse("#abc"))
        assertEquals(0x80CBF0F8.toInt(), NotePalette.parse("#80cbf0f8"))
    }

    @Test fun parsesCssRgbSavedByTheWebEditor() {
        assertEquals(0xFFCBF0F8.toInt(), NotePalette.parse("rgb(203, 240, 248)"))
        assertEquals(0xFFCBF0F8.toInt(), NotePalette.parse("rgb(203,240,248)"))
        assertEquals(0xFFCBF0F8.toInt(), NotePalette.parse(" RGBA(203, 240, 248, 0.5) "))
        assertEquals(0xFFFF0000.toInt(), NotePalette.parse("rgb(300, 0, 0)"))
    }

    @Test fun returnsNullWithoutAUsableColor() {
        listOf("", "   ", "transparent", "#cbf0f", "#ggg", "rgb(1, 2)", "url(x)").forEach {
            assertNull(it, NotePalette.parse(it))
        }
    }

    @Test fun everyPaletteColorParses() {
        NotePalette.colors.filter { it.hex.isNotEmpty() }.forEach { assertNotNull(it.name, NotePalette.parse(it.hex)) }
    }

    @Test fun sameColorIgnoresNotation() {
        assertTrue(NotePalette.sameColor("rgb(203, 240, 248)", "#cbf0f8"))
        assertTrue(NotePalette.sameColor("#CBF0F8", "#cbf0f8"))
        assertTrue(NotePalette.sameColor("", ""))
        assertFalse(NotePalette.sameColor("", "#cbf0f8"))
        assertFalse(NotePalette.sameColor("rgb(203, 240, 249)", "#cbf0f8"))
        assertFalse(NotePalette.sameColor("garbage", "garbage"))
    }

    private val colors by lazy {
        JSONObject(java.io.File(requireNotNull(System.getProperty("keeparr.native.fixture"))).readText()).getJSONObject("noteColors")
    }
    private fun <T> objects(array: org.json.JSONArray, read: (JSONObject) -> T) = (0 until array.length()).map { read(array.getJSONObject(it)) }
    private fun hex(color: Int) = NotePalette.toHex(color)
    private fun argb(value: String) = NotePalette.parse(value)!!

    @Test fun darkVariantsMatchTheSharedFixture() {
        objects(colors.getJSONArray("palette")) { it }.forEach {
            assertEquals(it.getString("name"), it.getString("dark"), hex(NotePalette.display(it.getString("light"), true)!!))
            assertEquals(it.getString("name"), it.getString("light"), hex(NotePalette.display(it.getString("light"), false)!!))
        }
    }

    @Test fun theFallbackAlgorithmMatchesTheSharedFixture() {
        objects(colors.getJSONArray("fallback")) { it }.forEach {
            val input = it.getString("input")
            val expected = it.getString("dark")
            val actual = NotePalette.display(input, true)
            // Empty and unparseable input has no color, where the TypeScript hands the input back unchanged.
            if (NotePalette.parse(input) == null) assertNull(input, actual) else assertEquals(input, expected, hex(actual!!))
        }
    }

    @Test fun textAndLinkColorsMatchTheSharedFixture() {
        objects(colors.getJSONArray("text")) { it }.forEach {
            val background = it.getString("background")
            val dark = it.optBoolean("dark")
            val actual = NotePalette.parse(background)?.let(NotePalette::textColor) ?: NotePalette.themeText(dark)
            assertEquals("$background dark=$dark", it.getString("text"), hex(actual))
        }
        objects(colors.getJSONArray("link")) { it }.forEach {
            val background = it.getString("background")
            val dark = it.optBoolean("dark")
            val actual = NotePalette.parse(background)?.let(NotePalette::linkColor) ?: NotePalette.themeLink(dark)
            assertEquals("$background dark=$dark", it.getString("link"), hex(actual))
        }
    }

    @Test fun illustrationColorsMatchTheSharedFixture() {
        objects(colors.getJSONArray("illustration")) { it }.forEach {
            assertEquals(it.getString("input"), it.getString("dark"), hex(NotePalette.darkIllustrationColor(argb(it.getString("input")))))
        }
    }

    @Test fun storedValuesAreNeverRewrittenAndDarkValuesAreNotRemapped() {
        assertEquals(0xFFFFF8B8.toInt(), NotePalette.display("#fff8b8", false))
        assertEquals(0xFF7C4A03.toInt(), NotePalette.display("rgb(255, 248, 184)", true))
        assertEquals("a dark swatch maps to itself", 0xFF5B2121.toInt(), NotePalette.display("#5b2121", true))
        assertNull(NotePalette.display("", true))
    }

    private val themes = listOf(false, true)
    private fun swatches() = NotePalette.colors.filter { it.hex.isNotEmpty() }

    @Test fun textMeetsFourPointFiveToOneOnEverySwatchInBothThemes() {
        for (swatch in swatches()) for (dark in themes) {
            val background = NotePalette.display(swatch.hex, dark)!!
            val ratio = NotePalette.contrast(NotePalette.textColor(background), background)
            assertTrue("${swatch.name} dark=$dark text $ratio", ratio >= 4.5)
        }
    }

    @Test fun editorControlsMeetFourPointFiveToOneOnEverySwatchInBothThemes() {
        val base = androidx.compose.material3.lightColorScheme()
        for (swatch in swatches()) for (dark in themes) {
            val displayed = NotePalette.display(swatch.hex, dark)!!
            val background = Color(displayed)
            val foreground = Color(NotePalette.textColor(displayed))
            val scheme = noteColorScheme(base, background, foreground)
            fun ratio(a: Color, b: Color) = NotePalette.contrast(a.toArgb(), b.toArgb())
            val label = "${swatch.name} dark=$dark"
            // Top bar, bottom bar, toolbar, checkbox label, add item and reminder chip: onSurface on surface and the containers.
            listOf(scheme.surface, scheme.surfaceContainer, scheme.surfaceContainerHigh, scheme.surfaceContainerHighest, scheme.surfaceVariant)
                .forEach { assertTrue("$label onSurface on container ${ratio(scheme.onSurface, it)}", ratio(scheme.onSurface, it) >= 4.5) }
            // TextButtons ("List item", reminder chip), the pinned icon and checked checkboxes use the accent.
            assertTrue("$label accent ${ratio(scheme.primary, scheme.surface)}", ratio(scheme.primary, scheme.surface) >= 4.5)
            assertTrue("$label onPrimary ${ratio(scheme.onPrimary, scheme.primary)}", ratio(scheme.onPrimary, scheme.primary) >= 4.5)
            assertEquals(scheme.primary, noteAccent(background, foreground))
        }
    }

    @Test fun theAccentIsThePlansChoiceWhereItReachesContrast() {
        val cream = Color(NotePalette.display("#fff8b8", false)!!)
        assertEquals(Color(0xFF765900), noteAccent(cream, Color(0xFF202124)))
        val creamDark = Color(NotePalette.display("#fff8b8", true)!!)
        assertEquals(Color(0xFFFFCF45), noteAccent(creamDark, Color(0xFFE8EAED)))
    }

    @Test fun linksMeetFourPointFiveToOneOnEverySwatchInBothThemes() {
        fun ratio(swatch: String, dark: Boolean): Double {
            val background = NotePalette.display(swatch, dark)!!
            return NotePalette.contrast(NotePalette.linkColor(background), background)
        }
        for (swatch in swatches()) for (dark in themes) assertTrue("${swatch.name} dark=$dark link contrast", ratio(swatch.hex, dark) >= 4.5)
    }

}
