package dev.kept.android.data

data class NoteColor(val name: String, val hex: String)

/** Kept's shared note colors, kept in sync with src/app/interfaces/tooltip.ts. */
object NotePalette {
    val colors = listOf(
        NoteColor("Default", ""),
        NoteColor("Aqua", "#cbf0f8"),
        NoteColor("Apricot", "#fddcbb"),
        NoteColor("Blush", "#fdcfe8"),
        NoteColor("Cream", "#fff8b8"),
        NoteColor("Lavender", "#d7aefb"),
        NoteColor("Lemon", "#fef7cc"),
        NoteColor("Lilac", "#e8d7ff"),
        NoteColor("Mint", "#ccff90"),
        NoteColor("Peach", "#ffd8b5"),
        NoteColor("Rose", "#f8c7c0"),
        NoteColor("Sage", "#e6f4d7"),
        NoteColor("Sky", "#d2e3fc"),
        NoteColor("Creamsicle", "#ffb74d"),
        NoteColor("Cornflower", "#abc4ff"),
        NoteColor("Flamingo", "#ffc2d1"),
        NoteColor("Coral", "#ffab91"),
        NoteColor("Turquoise", "#a7ffeb"),
        NoteColor("Lime", "#e6ee9c"),
        NoteColor("Sand", "#efe0c8"),
        NoteColor("Periwinkle", "#c5cae9"),
        NoteColor("Red", "#5b2121"),
        NoteColor("Orange", "#5b3a21"),
        NoteColor("Yellow", "#4a4a1a"),
        NoteColor("Green", "#1a4a1a"),
        NoteColor("Teal", "#1a4a4a"),
        NoteColor("Blue", "#1a2e4a"),
        NoteColor("Dark blue", "#0f172a"),
        NoteColor("Purple", "#2e1a4a"),
        NoteColor("Pink", "#4a1a2e"),
        NoteColor("Brown", "#3a211a"),
        NoteColor("Gray", "#334155"),
        NoteColor("Indigo", "#282a5c"),
        NoteColor("Magenta", "#5c1a4a"),
        NoteColor("Mustard", "#5c4a14"),
        NoteColor("Cyan", "#144a5c")
    )

    private val rgbPattern = Regex("""^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,[^)]*)?\)$""", RegexOption.IGNORE_CASE)

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

    private fun Char.hexPair() = Character.digit(this, 16) * 17
    private fun argb(a: Int, r: Int, g: Int, b: Int) = (a shl 24) or (r shl 16) or (g shl 8) or b
}
