package dev.keeparr.android.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** One text and link color rule across web, app and widgets (PLAN.md P2.5). */
class NoteColorRuleTest {
    private val repository = File(requireNotNull(System.getProperty("keeparr.native.fixture"))).parentFile.parentFile

    @Test fun theSharedConstantsAreTheRule() {
        assertEquals("#202124", NotePalette.toHex(NotePalette.TEXT_LIGHT_THEME))
        assertEquals("#e8eaed", NotePalette.toHex(NotePalette.TEXT_DARK_THEME))
        assertEquals("#1a73e8", NotePalette.toHex(NotePalette.LINK_LIGHT_THEME))
        assertEquals("#8ab4f8", NotePalette.toHex(NotePalette.LINK_DARK_THEME))
    }

    @Test fun noRetiredTextColorsRemainInTheWebOrAndroidSources() {
        val retired = Regex("""#272727\b|#f5f3ef\b|#f1f1f1\b|0xff(272727|f5f3ef|f1f1f1)\b|rgb\(\s*41\s*,\s*39\s*,\s*32\s*\)""", RegexOption.IGNORE_CASE)
        val roots = listOf("src", "android-native/app/src/main").map { File(repository, it) }
        val extensions = setOf("kt", "xml", "ts", "scss", "css", "html")
        val hits = roots.flatMap { root ->
            root.walkTopDown().filter { it.isFile && it.extension in extensions && !it.path.contains("/assets/") }
                .filter { retired.containsMatchIn(it.readText()) }.map { it.relativeTo(repository).path }.toList()
        }
        assertTrue("retired colors in $hits", hits.isEmpty())
    }
}
