package dev.kept.android.data

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
}
