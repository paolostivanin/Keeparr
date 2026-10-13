package dev.keeparr.android.data

/** A palette swatch: [hex] is the stored (light) value, [dark] the value shown under the dark theme ("" for Default). */
data class NoteColor(val name: String, val hex: String, val dark: String)

/**
 * Keeparr's shared note colors, kept in sync with src/app/interfaces/tooltip.ts and src/app/utils/note-color.ts.
 *
 * Stored `bgColor` values are data and never change. The dark variant exists only at render time ([display]), and the
 * rules below are checked against `noteColors` in test-fixtures/native-contract.json (generated from the TypeScript).
 *
 * Link colors are fixed (`#1a73e8` / `#8ab4f8`) and chosen with the text color, so they are not guaranteed 4.5:1 on
 * every pastel (Lavender light 2.4:1, Cream dark 3.5:1). Text always meets 4.5:1; links are the documented exception.
 */
object NotePalette {
    const val TEXT_LIGHT_THEME = 0xFF202124.toInt()
    const val TEXT_DARK_THEME = 0xFFE8EAED.toInt()
    const val LINK_LIGHT_THEME = 0xFF1A73E8.toInt()
    const val LINK_DARK_THEME = 0xFF8AB4F8.toInt()
    /** Colors at or below this luminance are already dark and render unchanged. */
    const val DARK_THRESHOLD = 0.12
    /** The generated dark variant is darkened until it reaches this luminance. */
    const val MAX_DARK_LUMINANCE = 0.10

    val colors = listOf(
        NoteColor("Default", "", ""),
        NoteColor("Aqua", "#cbf0f8", "#2d555e"),
        NoteColor("Apricot", "#fddcbb", "#5e4022"),
        NoteColor("Blush", "#fdcfe8", "#5b2245"),
        NoteColor("Cream", "#fff8b8", "#7c4a03"),
        NoteColor("Lavender", "#d7aefb", "#42275e"),
        NoteColor("Lemon", "#fef7cc", "#5e5621"),
        NoteColor("Lilac", "#e8d7ff", "#3b2060"),
        NoteColor("Mint", "#ccff90", "#345920"),
        NoteColor("Peach", "#ffd8b5", "#603e20"),
        NoteColor("Rose", "#f8c7c0", "#592d26"),
        NoteColor("Sage", "#e6f4d7", "#40522e"),
        NoteColor("Sky", "#d2e3fc", "#243a5c"),
        NoteColor("Creamsicle", "#ffb74d", "#604620"),
        NoteColor("Cornflower", "#abc4ff", "#203360"),
        NoteColor("Flamingo", "#ffc2d1", "#602030"),
        NoteColor("Coral", "#ffab91", "#602f20"),
        NoteColor("Turquoise", "#a7ffeb", "#16504b"),
        NoteColor("Lime", "#e6ee9c", "#525629"),
        NoteColor("Sand", "#efe0c8", "#51442e"),
        NoteColor("Periwinkle", "#c5cae9", "#31354e"),
        NoteColor("Red", "#5b2121", "#5b2121"),
        NoteColor("Orange", "#5b3a21", "#5b3a21"),
        NoteColor("Yellow", "#4a4a1a", "#4a4a1a"),
        NoteColor("Green", "#1a4a1a", "#1a4a1a"),
        NoteColor("Teal", "#1a4a4a", "#1a4a4a"),
        NoteColor("Blue", "#1a2e4a", "#1a2e4a"),
        NoteColor("Dark blue", "#0f172a", "#0f172a"),
        NoteColor("Purple", "#2e1a4a", "#2e1a4a"),
        NoteColor("Pink", "#4a1a2e", "#4a1a2e"),
        NoteColor("Brown", "#3a211a", "#3a211a"),
        NoteColor("Gray", "#334155", "#334155"),
        NoteColor("Indigo", "#282a5c", "#282a5c"),
        NoteColor("Magenta", "#5c1a4a", "#5c1a4a"),
        NoteColor("Mustard", "#5c4a14", "#5c4a14"),
        NoteColor("Cyan", "#144a5c", "#144a5c")
    )

    private val rgbPattern = Regex("""^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)$""", RegexOption.IGNORE_CASE)
    private val darkByLight: Map<Int, Int> = colors.filter { it.hex.isNotEmpty() }
        .associate { (parse(it.hex) ?: 0) to (parse(it.dark) ?: 0) }

    /**
     * Parses a stored bgColor into an ARGB int, or null when there is no usable color.
     * The web editor saves colors read back from the DOM, so values may be `rgb(r, g, b)` instead of `#rrggbb`.
     */
    fun parse(value: String): Int? {
        val text = value.trim()
        if (text.isEmpty()) return null
        rgbPattern.matchEntire(text)?.let { match ->
            val (r, g, b) = match.destructured.toList().map { it.toIntOrNull()?.coerceIn(0, 255) ?: 255 }
            return argb(0xFF, r, g, b)
        }
        val hex = text.removePrefix("#")
        if (hex.any { Character.digit(it, 16) < 0 }) return null
        return when (hex.length) {
            3 -> argb(0xFF, hex[0].hexPair(), hex[1].hexPair(), hex[2].hexPair())
            6 -> (0xFF000000 or hex.toLong(16)).toInt()
            8 -> hex.toLong(16).toInt()
            else -> null
        }
    }

    /** True when both values describe the same color, regardless of hex/rgb notation; blank means "no color". */
    fun sameColor(a: String, b: String): Boolean =
        if (a.isBlank() || b.isBlank()) a.isBlank() && b.isBlank() else parse(a)?.let { it == parse(b) } == true

    /**
     * The color to draw for a stored bgColor: the stored value itself under the light theme, [darkColor] under the dark
     * theme. Null when there is no usable color. The result is opaque (the web drops any alpha as well).
     */
    fun display(stored: String, dark: Boolean): Int? {
        // CSS reads 8 digits as #rrggbbaa, which is what the web shows; `parse` keeps its historical #aarrggbb.
        val text = stored.trim()
        val css = if (Regex("^#[0-9a-fA-F]{8}$").matches(text)) text.substring(0, 7) else text
        val color = parse(css) ?: return null
        return display(color, dark)
    }

    /** [display] for an already parsed stored color. */
    fun display(stored: Int, dark: Boolean): Int = stored.opaque().let { if (dark) darkColor(it) else it }

    /** The dark render value for an opaque stored color; see PLAN.md section 6. */
    fun darkColor(color: Int): Int {
        val rgb = color.opaque()
        darkByLight[rgb]?.let { return it }
        if (luminance(rgb) <= DARK_THRESHOLD) return rgb
        val hsl = rgbToHsl(rgb)
        val saturation = minOf(0.5 * hsl[1], 0.6)
        var lightness = 25 // integer hundredths
        var out = hslToRgb(hsl[0], saturation, lightness / 100.0)
        while (luminance(out) > MAX_DARK_LUMINANCE && lightness > 15) {
            lightness -= 1
            out = hslToRgb(hsl[0], saturation, lightness / 100.0)
        }
        return out
    }

    /** Whichever theme text color contrasts more with [background]; ties go to the light-theme color. */
    fun textColor(background: Int): Int {
        val bg = luminance(background)
        return if (contrast(bg, luminance(TEXT_DARK_THEME)) > contrast(bg, luminance(TEXT_LIGHT_THEME))) TEXT_DARK_THEME else TEXT_LIGHT_THEME
    }

    /** The link color that goes with [textColor] for the same background. */
    fun linkColor(background: Int): Int = if (textColor(background) == TEXT_LIGHT_THEME) LINK_LIGHT_THEME else LINK_DARK_THEME

    /** The theme's own text and link colors, for a note without a color or one drawn over a background image. */
    fun themeText(dark: Boolean): Int = if (dark) TEXT_DARK_THEME else TEXT_LIGHT_THEME
    fun themeLink(dark: Boolean): Int = if (dark) LINK_DARK_THEME else LINK_LIGHT_THEME

    /** Dark-theme counterpart of an illustration fill/stroke: HSL(h, min(s, 0.45), 0.10 + (1 - l) * 0.6). */
    fun darkIllustrationColor(color: Int): Int {
        val hsl = rgbToHsl(color.opaque())
        return hslToRgb(hsl[0], minOf(hsl[1], 0.45), 0.10 + (1 - hsl[2]) * 0.6)
    }

    fun toHex(color: Int): String = "#%06x".format(color and 0xFFFFFF)

    /** WCAG relative luminance, 0..1. */
    fun luminance(color: Int): Double {
        fun lin(channel: Int): Double {
            val c = channel / 255.0
            return if (c <= 0.04045) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * lin((color shr 16) and 0xFF) + 0.7152 * lin((color shr 8) and 0xFF) + 0.0722 * lin(color and 0xFF)
    }

    fun contrast(a: Double, b: Double): Double = (maxOf(a, b) + 0.05) / (minOf(a, b) + 0.05)
    fun contrast(a: Int, b: Int): Double = contrast(luminance(a), luminance(b))

    private fun rgbToHsl(color: Int): DoubleArray {
        val r = ((color shr 16) and 0xFF) / 255.0
        val g = ((color shr 8) and 0xFF) / 255.0
        val b = (color and 0xFF) / 255.0
        val max = maxOf(r, g, b)
        val min = minOf(r, g, b)
        val l = (max + min) / 2
        val d = max - min
        if (d == 0.0) return doubleArrayOf(0.0, 0.0, l)
        val s = d / (1 - Math.abs(2 * l - 1))
        val h = when (max) {
            r -> ((g - b) / d + 6) % 6
            g -> (b - r) / d + 2
            else -> (r - g) / d + 4
        }
        return doubleArrayOf(h * 60, s, l)
    }

    /** Channels are rounded half up, like `Math.round` in the TypeScript reference. */
    private fun hslToRgb(h: Double, s: Double, l: Double): Int {
        val c = (1 - Math.abs(2 * l - 1)) * s
        val x = c * (1 - Math.abs(((h / 60) % 2) - 1))
        val m = l - c / 2
        val (r, g, b) = when (Math.floor(h / 60).toInt() % 6) {
            0 -> Triple(c, x, 0.0)
            1 -> Triple(x, c, 0.0)
            2 -> Triple(0.0, c, x)
            3 -> Triple(0.0, x, c)
            4 -> Triple(x, 0.0, c)
            else -> Triple(c, 0.0, x)
        }
        fun channel(v: Double) = Math.round((v + m) * 255).toInt()
        return argb(0xFF, channel(r), channel(g), channel(b))
    }

    private fun Int.opaque() = this or (0xFF shl 24)
    private fun Char.hexPair() = Character.digit(this, 16) * 17
    private fun argb(a: Int, r: Int, g: Int, b: Int) = (a shl 24) or (r shl 16) or (g shl 8) or b
}
