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
        NoteColor("Gray", "#334155")
    )
}
