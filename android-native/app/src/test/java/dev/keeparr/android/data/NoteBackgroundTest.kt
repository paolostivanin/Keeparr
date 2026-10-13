package dev.keeparr.android.data

import android.content.Context
import org.robolectric.RuntimeEnvironment
import com.caverock.androidsvg.SVG
import dev.keeparr.android.ui.BackgroundArt
import dev.keeparr.android.ui.buildHomeProjection
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.io.File

@RunWith(RobolectricTestRunner::class)
class NoteBackgroundTest {
    private val context: Context get() = RuntimeEnvironment.getApplication()
    private val fixture by lazy {
        JSONObject(File(requireNotNull(System.getProperty("keeparr.native.fixture"))).readText()).getJSONObject("noteColors")
    }
    private val sources by lazy { File(requireNotNull(System.getProperty("keeparr.native.fixture"))).parentFile.parentFile.resolve("src/assets/images/backgrounds") }

    @Test fun parsesEveryStoredFormAndTheTwelveNames() {
        val names = listOf("groceries", "tasks", "movies", "cafes", "romantic", "gym", "recipes", "travel", "study", "ideas", "meetings", "budget")
        assertEquals(names, NoteBackground.entries.map { it.key })
        for (name in names) {
            val expected = NoteBackground.entries.single { it.key == name }
            val path = "/assets/images/backgrounds/$name.svg"
            listOf("url(\"$path\")", "url($path)", "url('$path')", "url( \"$path\" )", path, " url($path) ", "url(\"https://keeparr.example/$path\")",
                "url(\"http://localhost:4200$path\")", "url(\"$path?v=2\")").forEach {
                assertEquals(it, expected, NoteBackground.parse(it))
            }
            assertEquals("url($path)", expected.stored)
        }
    }

    @Test fun unknownAndBlankValuesAreNotRendered() {
        listOf("", "  ", "none", "url()", "url(\"\")", "url(/assets/images/backgrounds/image-1.svg)", "url(/assets/images/backgrounds/groceries.png)",
            "url(/other/groceries.svg)", "linear-gradient(red, blue)", "url(/assets/images/backgrounds/groceries.svg) no-repeat").forEach {
            assertNull(it, NoteBackground.parse(it))
        }
    }

    @Test fun darkeningUsesTheSharedIllustrationRule() {
        val samples = fixture.getJSONArray("illustration")
        for (index in 0 until samples.length()) {
            val sample = samples.getJSONObject(index)
            val input = sample.getString("input")
            assertEquals(input, """<rect fill="${sample.getString("dark")}"/>""", NoteBackground.darken("""<rect fill="$input"/>"""))
            assertEquals(input, """<path stroke="${sample.getString("dark")}"/>""", NoteBackground.darken("""<path stroke="$input"/>"""))
        }
        assertEquals("""<g fill="none" stroke-width="3" style="fill:#362f14"/>""", NoteBackground.darken("""<g fill="none" stroke-width="3" style="fill:#fff8d9"/>"""))
        assertEquals("""<stop stop-color="#9e5726"/>""", NoteBackground.darken("""<stop stop-color="#9e5726"/>"""))
    }

    @Test fun everyBackgroundShipsInAssetsAsArtAndThumbnailAndMatchesTheWebSource() {
        for (background in NoteBackground.entries) for (thumbnail in listOf(false, true)) {
            val name = background.asset(dark = false, thumbnail = thumbnail)
            val copy = context.assets.open("backgrounds/$name").use { it.readBytes() }
            assertArrayEquals("$name is the web file", File(sources, name).readBytes(), copy)
        }
    }

    @Test fun everyBackgroundDrawsInBothThemes() {
        for (background in NoteBackground.entries) for (dark in listOf(false, true)) for (thumbnail in listOf(false, true)) {
            assertNotNull("${background.key} dark=$dark thumbnail=$thumbnail", BackgroundArt.load(context, background, dark, thumbnail))
        }
    }

    @Test fun theDarkThemeGetsDarkerArtThanTheLightTheme() {
        for (background in NoteBackground.entries) {
            val light = BackgroundArt.text(context, background, dark = false, thumbnail = false)
            val dark = BackgroundArt.text(context, background, dark = true, thumbnail = false)
            assertNotEquals(background.key, light, dark)
            fun luminanceOfFills(svg: String) = Regex("""fill="#([0-9a-f]{6})"""").findAll(svg)
                .map { NotePalette.luminance(NotePalette.parse("#" + it.groupValues[1])!!) }.toList()
            val lightFills = luminanceOfFills(light)
            val darkFills = luminanceOfFills(dark)
            assertTrue(background.key, darkFills.isNotEmpty() && darkFills.average() < lightFills.average())
        }
        // The first fill of groceries is the page color #fff8d9.
        assertTrue(BackgroundArt.text(context, NoteBackground.Groceries, true, false).contains("""fill="#362f14""""))
    }

    @Test fun aCardCarriesTheBackgroundAndDropsTheColorWhileAnUnknownImageIsKept() {
        fun card(vararg fields: Pair<String, String>): dev.keeparr.android.ui.NoteCardUiModel {
            val note = Note.create(1L)
            note.raw.put("id", 1).put("revision", 1)
            fields.forEach { note.raw.put(it.first, it.second) }
            return buildHomeProjection(listOf(note), "home", "", emptyList()).cards.single()
        }
        val image = card("bgColor" to "#fff8b8", "bgImage" to "url(\"/assets/images/backgrounds/gym.svg\")")
        assertEquals(NoteBackground.Gym, image.background)
        assertNull("the image replaces the color", image.colorArgb)
        val unknown = card("bgColor" to "#fff8b8", "bgImage" to "url(/assets/images/backgrounds/image-1.svg)")
        assertNull(unknown.background)
        assertNull("an unknown image still replaces the color, as on the web", unknown.colorArgb)
        val plain = card("bgColor" to "#fff8b8")
        assertNull(plain.background)
        assertEquals(0xFFFFF8B8.toInt(), plain.colorArgb)
    }

    @Test fun svgParserAcceptsADarkenedDocument() {
        val svg = SVG.getFromString(NoteBackground.darken(File(sources, "groceries.svg").readText()))
        assertTrue(svg.documentViewBox.width() > 0)
    }
}
