package dev.keeparr.android.data

/**
 * The 12 illustrated note backgrounds shared with the web (src/assets/images/backgrounds). A note stores one in `bgImage`
 * as CSS: the web writes `url("/assets/images/backgrounds/x.svg")`, other writers `url(...)` or a bare path.
 */
enum class NoteBackground(val key: String, val label: String) {
    Groceries("groceries", "Groceries"), Tasks("tasks", "Tasks"), Movies("movies", "Movies"), Cafes("cafes", "Cafes"),
    Romantic("romantic", "Romantic"), Gym("gym", "Gym"), Recipes("recipes", "Recipes"), Travel("travel", "Travel"),
    Study("study", "Study"), Ideas("ideas", "Ideas"), Meetings("meetings", "Meetings"), Budget("budget", "Budget");

    val path get() = "$DIRECTORY/$key.svg"

    /** What the picker stores; the web's own picker writes the same form. */
    val stored get() = "url($path)"

    /** Asset names under `backgrounds/`, for the full-size art and the thumbnail. */
    fun asset(dark: Boolean, thumbnail: Boolean) = "$key${if (dark) "_dark" else ""}${if (thumbnail) "_ph" else ""}.svg"

    companion object {
        const val DIRECTORY = "/assets/images/backgrounds"
        private val known = entries.associateBy { it.key }
        private val reference = Regex("""^(?:url\(\s*)?(["']?)(?:[^"'()]*?/)?assets/images/backgrounds/([a-z]+)\.svg(?:[?#][^"'()]*)?\1\s*\)?$""")

        /** The known background a stored `bgImage` names, or null for blank and unknown values (which are kept, not drawn). */
        fun parse(bgImage: String): NoteBackground? = reference.matchEntire(bgImage.trim())?.groupValues?.get(2)?.let(known::get)

        private val paint = Regex("""\b(fill|stroke)(\s*[=:]\s*["']?)#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b""")

        /**
         * The dark-theme art for an SVG's text: every hex `fill`/`stroke` goes through [NotePalette.darkIllustrationColor], the
         * same rule the web generator applies to produce the committed `*_dark.svg` files. Used when no `_dark` asset exists.
         */
        fun darken(svg: String): String = paint.replace(svg) { match ->
            val parsed = NotePalette.parse("#" + match.groupValues[3]) ?: return@replace match.value
            "${match.groupValues[1]}${match.groupValues[2]}${NotePalette.toHex(NotePalette.darkIllustrationColor(parsed))}"
        }
    }
}
