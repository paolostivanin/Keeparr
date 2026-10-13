# Keeparr implementation plan: editing parity, shared content contract, dark note colors

Created: 2026-10-13 · Release line at creation: v2.2.0
Replaces the maintainability plan (`git show 7404f7a:PLAN.md`). Its open items are carried over in §11.

## 1. Problem statement

1. **Android makes note bodies read-only.**
   - The read-only gate is `NoteFormat.editable()` (`android-native/app/src/main/java/dev/keeparr/android/data/Models.kt:276`). It is a small allow-list of tags and attributes. Anything outside it gets the message "This note contains formatting the native editor does not support yet" (`ui/NoteEditor.kt:372-377`).
   - The web writes plenty outside that list:
     - H1/H2 (`formatBlock`)
     - Chrome style spans
     - the inline-image wrapper
     - Takeout links with `target`/`rel`
     - MCP `ol`, `blockquote`, `pre`, `code`
   - Android also converts HTML with `Html.fromHtml`/`Html.toHtml`, which is lossy and contradicts its own allow-list:
     - `<s>` comes back as a style span that `editable()` rejects.
     - Pasted styles trigger the same rejection.
     - The IME composing underline is saved as `<u>`.
     - Every non-ASCII character is saved as `&#NNN;`, which breaks server search and `plainText`.
     - `href` is written unescaped.
     - Lists inside blocks, `<br>` inside `<li>`, and blank lines before a list are mangled.
2. **Dark theme doesn't darken note colors.** Neither client darkens them, so pastels paint at full brightness on dark surfaces (the web is dark by default).
3. **Editing bugs on both clients.** An audit found 26 Android, 21 web and 2 server issues, several of which lose content silently. The full inventory is in §5.

## 2. Owner decisions and invariants

**Decisions (2026-10-13):**
- **Harmony.** Everything the web can do with note content, Android does too. No string content is ever read-only.
- **Dark note colors on both clients**, from one shared mapping.
- **Fix every finding.**
- **This file replaces PLAN.md.**

**Invariants (they apply to every work item):**
1. **Stored `bgColor` and `bgImage` values are data.** Never retune or migrate palette hex values; dark variants exist only at render time. Adding a swatch is safe; editing or removing one is a data migration.
2. **Untouched content is never rewritten.** A client writes a field only when the user changed it. Opening and closing a note produces no write. If an edit is undone back to the original state, the original string is written back unchanged.
3. **No silent content loss.** Content a client cannot express natively is preserved byte-for-byte (atomic embeds) or kept along with its tag and attributes (inline/block frames).
4. **One contract, two implementations.** Shared fixtures in `test-fixtures/native-contract.json` are the source of truth. Both test suites consume them, and fixture changes need a matching change on both clients.
5. **The existing persistence invariants still hold:** durable local saves, immutable sent operations, `syncId` identity, and dirty drafts that are never overwritten by incoming snapshots. See `docs/sync-protocol.md` and `docs/architecture.md`.

## 3. The content contract

New document: `docs/note-content-contract.md`, normative. It records this section plus the fixture schema.

### 3.1 Whitespace and escaping
- Bodies render with `white-space: pre-wrap` (`src/app/components/input/input.component.scss:213,244`, `src/app/components/notes/notes.component.scss:266`).
  - A raw `\n` in a text node is a line break.
  - Spaces are significant.
  - `&nbsp;` is U+00A0.
- Escaping on write:
  - Text escapes only `&`, `<` and `>`, and writes U+00A0 as `&nbsp;`.
  - Attribute values escape `&` and `"`.
  - Everything else is written as literal UTF-8. This matches Chrome's `innerHTML`.

### 3.2 Vocabulary

| Class | Elements | Behavior on both clients |
|---|---|---|
| Authored blocks (body) | text run, `div`, `<div><br></div>`, `br`, `h1`, `h2`, `ul`/`li` (nested inside `li` or Chrome's sibling shape `<ul><li>a</li><ul>…</ul></ul>`) | create, edit, write |
| Authored inline (body and rows) | `b`, `i`, `u`, `a[href]` | create, edit, write |
| Authored embed | `<div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="/api/uploads/images/…" alt="…"></div><div><br></div>` (exact string) | insert, remove, move with surrounding text |
| Preserved blocks | `p`, `h3`–`h6`, `ol` (with `start`), `blockquote`, `pre`, unknown blocks containing text | editable text; tag and attributes kept |
| Preserved inline | `strong`, `em`, `s`, `strike`, `del`, `code`, `span`/`font` with attributes, `sub`, `sup`, `mark`, `small`, unknown inline | editable text; tag and attributes kept; rendered (bold/italic/strike/mono/color) |
| Atomic embeds | `table`, `hr`, bare `img`, `video`, `audio`, `iframe`, `object`, `canvas`, `svg`, `figure`, any `contenteditable="false"` block | shown (image or labeled preview card), removable as a unit, written back verbatim |
| Structured checklist items (non-string `data`) | — | read-only on both clients, shown with a label. No client creates them |

### 3.3 Title
- The title is plain text on both clients.
- Stored form: escaped text (§3.1).
- Reading decodes entities and tags into text.
- Writing:
  - If the decoded original still equals the new text, write the original string back unchanged.
  - Otherwise write the escaped new text.
- No formatting commands apply to the title.

### 3.4 Editing semantics (Chrome is the reference)

| Action | Result |
|---|---|
| Enter in a block | new sibling block of the same kind; in a heading → new `div` |
| Enter on an empty list item | outdent one level; at level 0, leave the list (line becomes `div`) |
| Backspace at the start of a list item | remove the bullet (outdent to plain line); a second Backspace merges with the previous line |
| Backspace at the start of a heading or quote line | heading → `div`; quote → drop one quote level |
| Paste (body, title, rows) | plain text only. In a list, each non-blank pasted line becomes an item; elsewhere, lines are joined with `<br>` (matches `insertPlainTextAtCursor`, `input.component.ts:1265-1276`) |
| Drop of text/HTML | same as paste |
| Clear | removes inline formatting and bullets; keeps headings (matches `removeBodyBullets` + `removeFormat`) |
| B/I/U with a selection | toggles: removes if the whole selection already has the style, otherwise adds |
| B/I/U with an empty selection | toggles a pending typing style for the next inserted text |
| Row Enter | splits the row at the caret; formatting kept on both sides |
| Row Backspace at its true start | non-empty → merge into the previous **visible** row; empty → delete the row and focus the previous row's end |
| Row multi-line paste | first line goes into the row at the caret, the remaining lines become new rows after it |

### 3.5 Toolbar parity

| Field | Commands |
|---|---|
| Body | H1 · H2 · Normal · • · → · ← · B · I · U · Clear · Undo · Redo |
| Checklist row | B · I · U · Clear · Undo · Redo (block buttons disabled) |
| Title | none |

### 3.6 Hybrid notes
- A note is hybrid when `isCbox && hasMeaningfulBody(body)`.
- `hasMeaningfulBody` means: visible text (nbsp counted as a space, then trimmed) is non-empty, **or** the body contains an `img` or an atomic embed.
- Both clients use this rule in the editor and on cards. Today the web editor (`input.component.ts:525-530`) and web cards (`note-card-preview.component.ts:96`) disagree.

### 3.7 Shared fixtures (`test-fixtures/native-contract.json`, new top-level keys; the existing `content.*` stays)
```json
"editorHtml": {
  "authoredBody": ["…every tag/attribute shape a client may write in a body…"],
  "authoredRow":  ["…"],
  "cases": [{ "id": "web-h1-span", "html": "…", "lines": ["…"], "nonBlankLines": ["…"],
              "canonical": "…", "preview": "…", "hasMeaningfulBody": true, "browserInnerText": false }],
  "edits": [{ "id": "enter-empty-nested-bullet", "html": "…", "selection": [s, e],
              "action": "enter|backspace|bold|italic|underline|h1|h2|normal|bullet|indent|outdent|clear|paste:<text>",
              "expected": "…" }],
  "rows":   [{ "id": "…", "html": "…", "edit": { "selection": [s, e], "insert": "…" }, "expected": "…" }],
  "titles": [{ "html": "Tom &amp; Jerry", "text": "Tom & Jerry" }, { "text": "a<b", "html": "a&lt;b" }]
},
"noteColors": {
  "palette": [{ "name": "Aqua", "light": "#cbf0f8", "dark": "#2d555e" }],
  "fallback": [{ "input": "#ffffff", "dark": "#404040" }],
  "text": [{ "background": "#2d555e", "text": "#e8eaed" }],
  "link": [{ "background": "#cbf0f8", "link": "#1a73e8" }],
  "illustration": [{ "input": "#fff8d9", "dark": "#362f14" }],
  "darkThreshold": 0.12, "maxDarkLuminance": 0.10
},
"checklistOps": [{ "op": "setIndent|toggleDone|moveBefore|split|merge|remove|show|hide",
                   "items": [], "args": {}, "expected": [] }]
```

**Minimum seed for `editorHtml.cases`:**
- Inputs already pinned by tests: `NativeContractTest.kt:563-585`, `BulletsTest.kt`, and the web body at `NativeContractTest.kt:210`.
- `<h1><span style="font-weight: normal;">x</span></h1>`
- `<div><ul><li>a</li></ul></div>`
- `<li>a<br>b</li>`
- stray text inside a `ul`
- a blank line before a list
- `<s>`
- `Caff&#232;`
- the inline-image wrapper
- a table
- `<a href target="_blank" rel="noopener">` (Takeout, `server/server.js:8163`)
- the MCP tags (`mcp/server.mjs:33`)
- legacy Android `<p dir="ltr" style="margin-top:0; margin-bottom:0;">`
- `<ol start="3">`
- a `blockquote` from Chrome's indent
- a five-level list

**Acceptance (contract):**
- [ ] `docs/note-content-contract.md` exists and is linked from `docs/architecture.md` and `docs/native-android-plan.md`.
- [ ] The fixtures contain every case listed above, and both suites load them (see §7).
- [ ] `docs/native-android-plan.md:122` and `docs/native-android-remediation-plan.md:305` no longer describe a read-only policy for string content.

## 4. Work items

Each item lists **Changes**, **Acceptance** (check an item only when every box is true with current evidence) and **Tests**. Paths are relative to the repository root.
- `A/` = `android-native/app/src/main/java/dev/keeparr/android/`
- `AT/` = `android-native/app/src/test/java/dev/keeparr/android/`

### P0 — Contract and fixtures (blocking for P1–P7)

**Changes**
- Write §3 into `docs/note-content-contract.md`.
- Add the `editorHtml`, `noteColors` and `checklistOps` sections to `test-fixtures/native-contract.json`.
- Generate the `noteColors` values from the TypeScript reference (P2.1). Write the `editorHtml` expectations by hand and review them against the browser: load each case into the web editor in a karma spec and record its `splitBodyIntoLines` output.

**Acceptance**
- [ ] The fixture JSON parses and is loaded by `NativeContractTest` (Android) and by a karma/node test (web), even before P1/P2 code consumes it (loader tests only).
- [ ] Every case has an `id` and a one-line comment-equivalent `note` field explaining the quirk it pins.

**Tests**
- Loader smoke tests on both sides.

### P1 — Android HTML codec; no more read-only bodies (highest priority)

#### P1.1 Block model and parser
**Changes:** new package `A/data/html/`.
- `Frame(tag: String?, attrs: List<HtmlAttr>)`: `id` comes from an AtomicLong; `tag == null` is an anonymous run.
- A line is `path: List<Frame>` (root → leaf), plus:
  - `breakBefore`: `BR`, `NEWLINE` or `BLOCK`
  - `trailingBr`
  - `placeholderBr`
- Element classes:
  - container: `ul`, `ol`, `blockquote`, and `li`/`div`/unknown with block children
  - leaf: `div`, `p`, `h1`–`h6`, `pre`, and `li`/unknown with inline-only content
  - embed: per §3.2
  - inline: everything else that holds text
  - `script`, `style` and comments are dropped
- Quirk rules, each pinned by a fixture:
  - A trailing `<br>` after content sets `trailingBr`; a lone `<br>` sets `placeholderBr`.
  - A run ending in a raw `\n` adds no extra line.
  - Whitespace-only top-level runs at the end of the document are dropped.
  - An empty `<div></div>` is dropped.
  - An embed always sits alone on its line.
- The legacy `<p dir="ltr" style="margin-top:0; margin-bottom:0;">` (exact signature) normalizes to `div`.

**Spans** (`HtmlSpans.kt`):
- `KeeparrSpan` marker (serialized); `RenderOnlySpan` marker (never serialized).
- `BlockSpan(path, breakBefore, trailingBr, placeholderBr) : LeadingMarginSpan`:
  - One span per line over `[lineStart, lineEnd+1)`, `SPAN_INCLUSIVE_EXCLUSIVE`.
  - It keeps the `markerOnly` handling for an empty last line (today in `A/data/Bullets.kt:16-24`).
  - Derived fields: `listDepth`, `quoteDepth`, `ordinal`, `marker`, `leafTag`.
  - Draws: bullet glyphs `• ◦ ▪ ▫` or `n.` (respecting `ol[start]`), 20 dp per list level, a 3 dp bar per quote level. Levels beyond 4 are drawn at depth 4 but kept as they are in the data.
- `InlineTagSpan(tag, attrs, order) : MetricAffectingSpan` renders:
  - bold: `b`, `strong`, `font-weight` ≥ 600 or `bold`
  - italic: `i`, `em`, `font-style: italic`
  - underline and strike: `u`, `s`, `strike`, `del`, `text-decoration`
  - monospace: `code`
  - link color plus underline: `a`
  - `sub`, `sup`, `mark`, `small`
  - CSS `color:`
- `HeadingSizeSpan(level)` (RenderOnly): h1 ×1.543, h2 ×1.234, weight 600 (web: `src/styles.scss:671-688`); h3 ×1.15 bold; h4–h6 ×1.0 bold.
- `EmbedSpan(html, kind = Image(src, alt) | Foreign(label, preview))`: a `ReplacementSpan` on U+FFFC.

**Acceptance**
- [ ] Parsing any fixture case produces the expected `lines` and `nonBlankLines`.
- [ ] No parse throws on arbitrary HTML (fuzz test).
- [ ] Ordered lists show `n.` numbering, and `start` is respected.

#### P1.2 Serializer
**Changes:** `NoteHtml.serialize(text, mode)` writes the canonical web dialect.
- Walk lines keeping a stack of open frames. Close and open frames by the common identity prefix. Lines sharing a leaf frame are joined with `<br>` or `\n` according to `breakBefore`.
- An empty line in a fresh or placeholder block is written as `<div><br></div>` (or `<x><br></x>` for its own leaf tag).
- Embeds are written verbatim.
- Inline tags:
  - Take the `InlineTagSpan`s clipped to the line (zero-length spans dropped). Spans that are not `KeeparrSpan` are ignored, which excludes IME composing spans and pasted platform spans.
  - At each boundary, close the tags that end there. A tag closed while nested tags are still open has those nested tags closed and reopened.
  - Then open the tags that start there, ordered by (end desc, order asc).
  - Never nest `a` inside `a`.
- Escaping per §3.1.

**Acceptance**
- [ ] `canonical(x) == fixture.canonical` for every case.
- [ ] `canonical(canonical(x)) == canonical(x)` for every case and for 5,000 seeded random documents.
- [ ] The output contains only tags from `authoredBody`, or tags and attributes that were already present in the input.
- [ ] Non-ASCII characters appear as UTF-8 (no `&#` in the output for input text).
- [ ] `href` with `"`, `<` or `&` round-trips escaped.

#### P1.3 `NoteHtml` API and moving callers over
**Changes:** add `A/data/html/NoteHtml.kt`:
```kotlin
enum class HtmlMode { Body, Row }
object NoteHtml {
  fun parse(html: String, mode: HtmlMode = HtmlMode.Body): SpannableStringBuilder
  fun serialize(text: Spanned, mode: HtmlMode = HtmlMode.Body): String
  fun canonical(html: String, mode: HtmlMode = HtmlMode.Body): String
  fun commit(original: String, originalCanonical: String, edited: Spanned, mode: HtmlMode): String // original when unchanged
  fun lines(html: String): List<String>
  fun nonBlankLines(html: String): List<String>   // == web splitBodyIntoLines(...).lines
  fun displayText(html: String): String
  fun previewText(html: String): String
  fun plainText(html: String): String
  fun hasMeaningfulBody(html: String): Boolean
  fun embeds(html: String): List<String>
  fun firstImageSrc(html: String): String?
  fun titleText(html: String): String
  fun titleHtml(text: String, original: String = ""): String
  fun escapeText(text: String): String
  fun plainTextToHtml(text: String): String     // escape + "\n" -> "<br>"
}
```

**Call sites to move:**
- `A/data/Models.kt`:
  - `Note.hasContent` (60-65) → `titleText` and `hasMeaningfulBody`
  - `NoteFormat.*` → `NoteHtml` or `ChecklistModel` (P4)
- `A/ui/HomeProjector.kt`:
  - search (74): `titleText` + `plainText(body)` + item `plainText`
  - card (95-101): hybrid `bodyText`; `imagePath` falls back to `firstImageSrc(body)`
- `A/ui/KeeparrScreen.kt`:
  - share intent (122) → `plainTextToHtml`
  - 383-387 and 559 → `previewText` / `titleText` / `displayText`
- `A/widgets/NotesWidget.kt` (158, 170, 173, 224, 233): `titleText` / `previewText`; hybrid body support
- `A/data/KeeparrRepository.kt:241` (reminder title) → `titleText`
- `A/reminders/ReminderScheduler.kt:99,115` → `titleText`
- Share a copy (`NoteEditor.kt:241-248`) → `titleText`

**Acceptance**
- [ ] `grep -rn "Html.fromHtml\|Html.toHtml\|Html.escapeHtml" A/` returns nothing.
- [ ] Titles show decoded text (no `&amp;`) on cards, in the editor, widgets, notifications and search.
- [ ] Search finds "caffè" in a note typed on Android.
- [ ] Sharing text with newlines into Keeparr creates `<br>`-separated lines, and "Show checkboxes" on it creates one row per line.

#### P1.4 Editing controller
**Changes:** `A/data/html/RichTextOps.kt`, `class RichTextController(mode)`, pure logic over `Editable` and a selection.
- `normalize(cause = Typed | Paste | Programmatic, insertedNewlineAt)` runs after every change:
  - A line's path comes from the `BlockSpan` that starts **exactly** at the line start.
  - Lines without one inherit a path: a typed newline creates a new sibling leaf (new `li` in a list, `div` after a heading); a pasted newline keeps the same leaf with `BR`.
  - Recompute ordinals and depths.
  - Drop zero-length inline spans and merge adjacent spans with the same tag.
- `handleEnter`, `handleBackspaceAtLineStart(caret): Boolean`: rules per §3.4.
- `toggleInline(tag, start, end)`:
  - Selection is normalized to (min, max).
  - Removal splits `b`/`strong` spans at the edges, and splits style-bold spans into three, dropping `font-weight` from the middle part (likewise for italic and underline).
  - An empty selection toggles `pendingTyping`, or splits the span at the caret.
- Block commands: `setLeaf(h1|h2|div)`, `toggleBullet`, `indent` (nests under the previous `li`; the first item uses the sibling shape), `outdent` (also removes one quote level), `clear`.
- `formattingAt(selection)` returns the active-state set for the toolbar.
- Row mode: block commands are no-ops. A typed or pasted newline raises `onSplit(leftHtml, rightRowsHtml)`.

**Acceptance**
- [ ] Every `editorHtml.edits` fixture passes.
- [ ] Backspace at the start of a bullet line under a plain line removes the bullet and doesn't bullet the line above (fixes A7).
- [ ] Enter on an empty level-2 item gives level 1 (fixes A19).
- [ ] B on fully bold text removes bold with no `<b><b>` (fixes A8).
- [ ] A backward selection works.
- [ ] `<s>x</s>` stays `<s>` after editing nearby text (fixes A1).

#### P1.5 Editor view
**Changes:**
- `A/ui/editor/KeeparrEditText.kt`:
  - `onCreateInputConnection` wraps the connection and intercepts `deleteSurroundingText(before > 0, 0)`, `deleteSurroundingTextInCodePoints` and `sendKeyEvent(KEYCODE_DEL)` when the caret sits collapsed at a line start; `setOnKeyListener` handles hardware keys.
  - `setOnReceiveContentListener`: text is inserted as plain text (fixes A2); images are routed to P6.
  - `onSelectionChanged` hook.
  - Explicit hint, link, highlight and cursor colors (P2.3).
  - Callback that reports the caret rect.
  - Embed taps are found from the touch offset. No `LinkMovementMethod`.
- `A/ui/editor/RichTextField.kt`: the Compose `AndroidView` wrapper that replaces `StyledEditor` (`A/ui/NoteEditor.kt:459-548`).
  - The editor state lives in a plain holder (no Compose state read in `update {}`).
  - The text is reset only when `externalEdits` changes and `canonical(newBody) != serialize(current)`, and the selection is restored (fixes A21).
  - Bring-into-view uses `BringIntoViewRequester` with the caret rect.
- `NoteHtml.commit` caches the original's canonical form at load.

**Acceptance**
- [ ] Typing "Buy milk" with Gboard and closing without a trailing space saves no `<u>` (fixes A3).
- [ ] Pasting colored or heading text from Chrome inserts plain text, and the body stays editable.
- [ ] The caret stays visible while typing at the bottom of a long note with the keyboard open.
- [ ] Opening and closing a note with no edit writes nothing, so the outbox stays unchanged.

#### P1.6 Remove read-only
**Changes:**
- Delete the read-only fallback (`A/ui/NoteEditor.kt:374-377`).
- Delete the `editable()` gates (`NoteEditor.kt:145, 237`) and `NoteFormat.editable`/`editableAttributes` (`Models.kt:276-295`).
- Delete the row read-only branch for string data (`NoteEditor.kt:326, 344-347`); P4 replaces it.

**Acceptance**
- [ ] Every `editorHtml.cases` body opens editable.
- [ ] Atomic embeds render (image or preview card) and survive an edit of the surrounding text byte-for-byte.
- [ ] The string "does not support yet" no longer exists in `A/`.

**Tests (P1):**
- `AT/data/html/NoteHtmlFixtureTest.kt`
- `AT/data/html/RichTextOpsTest.kt`
- `AT/data/html/RoundTripFuzzTest.kt` (seeded, 5,000 documents)
- `AT/ui/editor/KeeparrEditTextTest.kt` (Robolectric: the InputConnection wrapper intercepts Backspace at line start; receive-content gives plain text)
- `BulletsTest.kt` becomes `AT/data/html/BlockModelTest.kt`. Changes: the five-level case is now kept; `orderedListsAreNotEditable` flips to editable and numbered.
- `NativeContractTest.kt` updates:
  - 98-99: table/img preserved, not read-only
  - 232: idempotence check
  - 281-288: every fixture is editable and preserved
  - 356-364: no `Html.toHtml`
  - 563-585: the same expectations through `NoteHtml`

### P2 — Shared dark note colors (web and Android; can run in parallel with P1)

#### P2.1 Color spec, TypeScript reference
**Changes:** add to `src/app/utils/note-color.ts`, next to the existing `noteColorToHex`:
- `NOTE_DARK_COLORS` (the table in §6)
- `darkNoteColor(stored)`
- `noteTextColor(bg)`
- `noteLinkColor(bg)`
- `darkIllustrationColor(hex)`
- `noteSurfaceVars(bgColor, bgImage)`, which returns `--note-bg`, `--note-bg-dark`, `--note-fg`, `--note-fg-dark`, `--note-link`, `--note-link-dark`, `--note-bg-image` and `--note-bg-image-dark`

Algorithms in §6.

**Acceptance**
- [ ] Every one of the 20 pastels maps to the §6 value; the 15 dark swatches and `''` map to themselves.
- [ ] Every dark value has luminance ≤ 0.10 and contrast ≥ 4.5:1 with `#e8eaed` (the table's actual minimum is 6.1).
- [ ] `fixture.noteColors` is generated from this code (script under `scripts/`) and committed.

#### P2.2 Web rendering refactor
**Changes:**
- Stop reading the color back from the DOM:
  - Add `noteColor` and `noteBgImage` fields to `InputComponent`.
  - Set them in `loadNoteIntoEditor` (`input.component.ts:3437-3442`), the palette pick (`~3790-3801`), `applyExternalUpdate` (`~4113-4118`) and `reset` (`~1175-1180`).
  - Read them in `saveNote` (560-561) and `liveEditorNote` (787-788).
  - `applyNoteSurface()` sets the CSS variables on `noteMain` and `noteContainer`.
- `src/styles.scss`: `.note-surface` uses the `-dark` variables by default and the light ones under `body.light-theme`. Theme changes then need no change detection; remove the `themeKey` cache (`notes.component.ts:320-322`).
- Render sites:
  - cards: `note-card-preview.component.html:3`
  - swatches: `input.component.html:965`, `notes.component.html:250`, `navbar.component.html:240`
  - proposals: `main.component.html:196`
  - placeholder color: `input.component.scss:217` → `currentColor` at 60%
- Replace the YIQ text color (`notes.component.ts:269-273, 335-338`, `input.component.ts:3811-3825`) with `noteTextColor`.
- Replace the dead `body.dark-theme` selectors (`src/styles.scss:287, 707-719`, `input.component.scss:1422`) with the surface variables.

**Acceptance**
- [ ] In dark theme, a Cream note shows `#7c4a03` on its card, in the editor and in the swatch; in light theme it shows `#fff8b8`. Toggling the theme updates open editors and cards instantly.
- [ ] Saving a note never writes a dark variant: in dark theme, pick Cream, save, and the stored `bgColor` is `#fff8b8` (spec).
- [ ] Text and link colors on every swatch meet 4.5:1 in both themes.

#### P2.3 Android app
**Changes:**
- `A/data/NotePalette.kt`: `NoteColor(name, hex, dark)`, `display(stored, dark): Int?`, `textColor(argb)`, `linkColor(argb)`; `parse` stays.
- `A/ui/Theme.kt`: `KeeparrTheme` provides `LocalDarkTheme` and a system-bars controller that the editor can override and restore on dispose.
- `UiModeManager.setApplicationNightMode` follows ThemeMode at startup and on every change, so platform dialogs and View resources match the app.
- `NoteCard` (`A/ui/KeeparrScreen.kt:477-487`) maps at render time. `HomeProjector` keeps the stored value, so its cache key stays theme-free.
- Editor:
  - `NoteSurfaceTheme(bg, fg)` overrides the `colorScheme` (surface/onSurface; primary `#FFCF45` on dark backgrounds, `#765900` on light), so TextButtons, Checkbox, menus and toolbar are readable.
  - Scaffold, TopAppBar and status-bar icons follow the note color, like Keep.
  - Bottom bar gets `contentColor = fg` (`NoteEditor.kt:265-266`).
  - Picker swatches show the displayed variant (`NoteEditor.kt:441-445`).
  - The EditText's hint, link, highlight and cursor colors come from `fg`/`linkColor`.

**Acceptance**
- [ ] With system dark mode and ThemeMode=System, a Cream card and editor show `#7c4a03` with text `#e8eaed`; ThemeMode=Light shows `#fff8b8` with `#202124`.
- [ ] Every editor control (top bar, bottom bar, toolbar, checkbox, add item, reminder chip) meets 4.5:1 on all 36 swatches in both themes.
- [ ] Switching ThemeMode to Dark while the system is light also darkens the date/time picker dialogs.

#### P2.4 Widgets
**Changes:** `A/widgets/NotesWidget.kt:152-213`. `tint()` gets a mode.
- ThemeMode.System: `RemoteViews.setColorInt(id, method, light, dark)` for background and foreground.
- Forced Light or Dark: explicit `setInt`, including the default card and frame colors that today come from `res/values(-night)/colors.xml`.
- Widgets refresh when ThemeMode changes (`A/ui/KeeparrScreen.kt:136` → `NotesWidget.refresh`).

**Acceptance**
- [ ] A colored widget row follows system night mode under ThemeMode.System, and follows the forced mode otherwise.
- [ ] `widgetForegroundColor` is replaced by `NotePalette.textColor`.

#### P2.5 One text and link color rule
**Acceptance**
- [ ] Web, Android app and widgets use exactly `#202124`/`#e8eaed` and `#1a73e8`/`#8ab4f8` via the shared rule.
- [ ] Grep finds no `#272727`, `#F5F3EF`, `#F1F1F1` or `rgb(41,39,32)`.

**Tests (P2):**
- `src/app/utils/note-color.test.ts` (extend): fixture palette equals `bgColors` plus the dark table; fallback, text, link and illustration samples.
- Karma spec: saving in dark theme keeps the light hex; the theme toggle swaps the variables.
- `AT/data/NotePaletteTest.kt` (extend): the same fixture.
- `NativeContractTest.kt:240-254`: compare against `noteColors.palette`.
- `AT/widgets/WidgetBehaviorTest.kt:256-271`: night qualifier gives the dark variant via `setColorInt`; forced modes give explicit colors. If the Robolectric shadow ignores night variants, assert the computed pair instead.

### P3 — Android editor feature parity

**Changes**
- **Format toolbar** (`A/ui/editor/FormatToolbar.kt`):
  - An "A" toggle in the bottom bar opens the §3.5 commands for the focused field, through a `LocalRichEditorFocus` registry.
  - Active states come from `formattingAt`.
  - The pending typing style is applied by the controller on each insertion (not through span flags) and cleared on any selection change that isn't from typing.
- **Undo/Redo:** a snapshot history of (html, selection) for text, coalesced over 1 s bursts, plus a port of `ChecklistHistory` (`src/app/utils/checklist-model.ts:73-129`) for structure. Buttons sit in the toolbar, like the web's (`input.component.html:292-295`).
- **Title:** `BasicTextField` shows `NoteHtml.titleText(note.title)` and writes back through `titleHtml(text, original)` (fixes A4).
- **Hybrid notes:** show the body `RichTextField` above the checklist when the note is hybrid (replaces the either/or at `NoteEditor.kt:312-377`, fixes A23).
- **Note images:** `images[placement=top]` go between the title and the body, `bottom` after the body (today all render after, `NoteEditor.kt:378-380`). Per-image remove and move top/bottom (web: `input.component.ts:1545-1554`).
- **ViewModel** (`A/ui/NoteEditorViewModel.kt`):
  - `externalEdits: StateFlow<Long>`, bumped only by `applyIncoming` replacements (110-116), by `acceptServerSnapshot` when the rebased content differs (124-127), by `replace` and by undo.
  - `undoAll()` restores the VM's constructor snapshot. "Undo changes" (`NoteEditor.kt:249-250`) uses it (fixes A13).
  - `EditorSnapshotPolicy.apply` (`A/data/Models.kt:106-114`) replaces a clean draft only when `incoming.revision >= local.revision` (fixes A22).

**Acceptance**
- [ ] H1/H2/Normal/Clear on Android produce exactly the HTML the web produces for the same action (fixture `edits`).
- [ ] A web H2 heading is shown as a heading on Android and stays `<h2>` after editing.
- [ ] Typing "a & b <c>" in the title on Android shows exactly that on the web and in notifications.
- [ ] A hybrid note made on the web shows and edits both body and checklist on Android.
- [ ] Rotating mid-edit and choosing "Undo changes" restores the note as it was when opened.
- [ ] Undo/Redo steps back and forward through text and checklist changes.

**Tests:** VM tests (`externalEdits` bumps only on outside changes; `undoAll` after re-creation; the revision guard); toolbar command tests in `RichTextOpsTest`; title fixture tests.

### P4 — Checklist parity (both clients)

**Changes**
- **Android:** new `A/data/ChecklistModel.kt`, a port of `src/app/utils/checkbox-indent.ts`, `checklist-model.ts` and `checklist-conversion.ts`. It replaces `ChecklistAdapter` (`A/data/Models.kt:371-420`) and the checklist parts of `NoteFormat`:
  - `normalizeIndentLevel` (max 3), `maxIndentLevelAt`, `descendantIndexes`
  - `setIndent` (moves descendants), `toggleDone` (with descendants, fixes A16), `moveBefore` + `normalizeIndentLevels`, `insertAfter`
  - `splitRow`, `mergeIntoPrevious`, `remove`
  - `show`/`hideCheckboxes`: embeds stay in the body, so the note becomes hybrid, like the web
  - ids are max+1 (web: `input.component.ts:1736-1742`)
- **Android rows** become `RichTextField(mode = Row)`:
  - Formatted multi-run items become editable (fixes A26), and leading or double spaces are kept (fixes A17).
  - A typed or pasted newline splits the row (fixes A18).
  - Backspace at the true start merges into the previous visible row, or deletes an empty row (fixes A18).
  - Focus is managed through a rowId → EditText handle map.
- **Android row menu:**
  - Move up/down target the previous/next **visible** row (fixes A15).
  - Indent is shown only below `maxIndentLevelAt`; Outdent only above 0.
  - Checkbox colors come from the note foreground.
- **Web:** Enter splits the row at the caret using `takeCboxTextAfterCaret` (`input.component.ts:1779-1790`) instead of adding an empty row after it. Backspace is covered by W4.
- **Performance:** measure a 300-row checklist. If opening or typing is slow, switch the row list to a `LazyColumn` of AndroidViews.

**Acceptance**
- [ ] Every `checklistOps` fixture passes on both clients.
- [ ] On both clients, checking a parent checks its children; Enter mid-row splits; Backspace at the start merges; Backspace on an empty row deletes it.
- [ ] `<b>first</b> and <i>second</i>` can be edited on Android and keeps both runs.
- [ ] Opening a 300-row checklist on a mid-range device takes < 500 ms and typing has no visible lag (record numbers in the log).

**Tests:** `AT/data/ChecklistModelTest.kt`; new `src/app/utils/checklist-model.test.ts`; `NativeContractTest.kt:289-312, 341-355` rewritten for row mode and `ChecklistModel.splitRow`.

### P5 — Web editing fixes

All in `src/app/components/input/input.component.ts` unless noted. Specs go in `input.component.spec.ts` (one per item).

| ID | Defect (verified) | Change | Acceptance |
|---|---|---|---|
| W1 | Drawing notes: the title is written into the normal `#noteTitle` (3432), then `isDrawingNote` flips (3435); after `detectChanges` the ViewChild is the hidden empty div (html:35). `saveNote` reads `''`, and `syncDrawingImage` makes every close a change → title/body wiped | `editorTitleHtml()`/`editorBodyHtml()` read the DOM only when the live editable element exists, otherwise return the `noteToEdit` values; use them in `saveNote` and `liveEditorNote`. Drawing image re-encoded only when the canvas is dirty | Opening and closing a drawing note that has a title and body keeps both and produces no write |
| W2 | `applyExternalUpdate` writes title/body (4103-4111) before `isHybridNote`/`isCbox` + `detectChanges` (4136-4141) → the fresh template body is empty → the next close saves `''` | `applyNoteToEditor(note, {preserveCaret})`, shared with `loadNoteIntoEditor`: set mode flags, run `detectChanges`, then write content | A remote "show checkboxes" or hybrid change while the note is open, then close → body intact |
| W3 | `addImageFiles` (1377-1380) sets `isCbox = false` in checklist/hybrid notes → items hidden, hybrid body lost | If `isCbox`: `isHybridNote = true`, `detectChanges`, insert into the body, keep the checklist | Dropping an image on a checklist gives a hybrid note with image and all items |
| W4 | Row Backspace: `isAtStart` uses offsets (2079), so it also fires inside later text nodes; it removes the row and its text; previous row taken in data order | True start test: a Range from row start to caret is collapsed and its `toString()` is `''`. Empty row → delete; otherwise merge its HTML into the previous row in **DOM order**, caret at the junction | Backspace at the start of "milk" merges it into the row above; no text lost |
| W5 | `cboxPhKeyDown` (1701-1710) ignores modifiers (Ctrl+V → "v"); Enter/Space create junk; IME breaks | Remove letter-key row creation. Create rows from `input` only (textContent + escape), skipping while composing | Ctrl+V pastes; Enter/Space create nothing; IME typing works |
| W6 | Paste/preferences rewrite `body.innerHTML` (2174-2180, 3926-3931) even with previews off: caret lost, image delete buttons lost, paste not undoable | Decorate only when `richLinkPreviews` is on and the URL set changed; keep the caret (`updateHtmlWithCursorPreservation`); re-run `hydrateInlineImageButtons`. Preferences re-decorate only when `richLinkPreviews` changed. Paste through `execCommand('insertText')`/`insertLineBreak` (Range path kept above 500 lines) | After a paste the caret sits after the pasted text, image delete buttons remain, Ctrl+Z undoes the paste |
| W7 | `applyTextFormat` (2490-2511) applies H1/H2/Aa/B/I/U to the title and rows | Block commands body only; inline commands body and rows; none in the title (also block Ctrl+B/I/U there). Enter in the title moves focus to the body or first row; an emptied title (`<br>`) saves as `''`. `selectionBelongsToTextEditor` (2415-2424) adds rows, drops the title. The A bar is enabled in checklist notes with block buttons disabled outside the body | Fixture `titles` pass; no tag ever appears in a title the web saves |
| W8 | `[innerHTML]="cb.data"` (html:864) rebinds after `syncCboxDomIntoModel` (1108) → caret reset; the Angular sanitizer strips row markup | `RowHtmlDirective`: writes `innerHTML` only when it differs from the DOM and the row isn't being typed in; cleans through a `sanitizeRowHtml` allow-list (vocabulary §3.2) | Tab-indenting after typing, or toggling another row, keeps the caret; row markup unchanged |
| W9 | "Show checkboxes" with inline images makes "close" items and drops the wrapper (430; `src/app/utils/checklist-conversion.ts`) | Treat `.inline-note-image-wrap` as one leftover node, skip `[data-inline-image-tool]`, work on `stripEditorChrome` output | Show checkboxes on a body with an image: no "close" item; image stays in the body (note becomes hybrid) |
| W10 | Hide/show re-inserts hydrated link-preview cards with dead buttons (2199, 460) | Use cleaned HTML, then `decorateLinksForEditor` + hydrate | Preview buttons work after hide/show |
| W11 | No keyboard undo/redo for checklist structure | Ctrl/Cmd+Z, Shift+Z, Ctrl+Y → `shouldUseCboxHistory` → `stepCboxHistory` | Deleting a row and pressing Ctrl+Z restores it |
| W12 | The mobile A bar closes on every tap in the text (2339-2341) | Keep it open when the tap is inside editable note text | Bar stays open while moving the caret |
| W13 | A new note can be saved twice when outside-click/back is repeated during `db.add` (329-354, 650-686) | Single in-flight create promise, reused by `mouseDownEvent`, `mobileBack` and `saveNote` | Rapid double outside-click creates one note (spec with a delayed `db.add`) |
| W14 | Close during an in-flight autosave starts a parallel update (599-625) | Store `coEditSavePromise`; close awaits it first | Spec: close during a pending autosave → updates run one after another |
| W15 | Draft restore (817-826) can overwrite text typed before IndexedDB loads | `userInputSinceOpen` flag; skip restoring fields the user already touched | Spec: type before the restore resolves → typed text kept |
| W16 | Text/HTML drops into body, title or rows unfiltered (1337-1349); single-line row paste left to the browser (1755) | Plain-text drop handler; row paste always plain via `insertText` | Dropping rich HTML inserts plain text only |
| W17 | `cboxInputFocus` (1810-1831) moves the caret to the end after a mouse focus (verify first) | Move the caret only on keyboard or programmatic focus | Clicking mid-row puts the caret at the click |
| W18 | Structured rows render "[object Object]" (html:864) | Show a read-only label like Android | Fixture `structuredChecklistItem` shows the label |
| W19 | MCP checklist `indentLevel` max 4 (`mcp/server.mjs:28`) vs server max 3 (`server/server.js:7979`) | Set it to 3 | `npm run test:mcp` covers it |
| W20 | Hybrid rule differs between the editor (525-530) and cards (`note-card-preview.component.ts:96`) | Shared `hasMeaningfulBody` (§3.6) in a util used by both | Fixture `hasMeaningfulBody` passes in karma |
| W21 | Dead `body.dark-theme` selectors | Covered by P2.2 | — |

**Server items:**

| ID | Defect | Change | Acceptance |
|---|---|---|---|
| S1 | `plainText` (`server/note-text.js:3-16`) decodes only named entities, so reminder bodies show `Caff&#232;` | Also decode numeric entities (decimal and hex) | Unit test in `server/domain-modules.test.js` |
| S2 | `LIKE` search (`server/note-search.js:93-106`) misses legacy entity-encoded text | Also match the query's numeric-entity encoding (OR the encoded variant for queries with non-ASCII) | Search "caffè" finds both `Caffè` and `Caff&#232;` bodies |

### P6 — Android inline images

**Changes**
- Attach button or receive-content with an image:
  - **Online:** upload now via `POST /api/uploads/images` (no note id needed; `server/server.js:4427`), reusing the multipart code from `A/data/Media.kt:81-94`. Then insert the exact §3.2 wrapper string at the caret.
  - **Offline:** the existing outbox images-array path (`KeeparrRepository.attach`, `Media.upload`), which both clients render.
  - Non-images keep the attachment path.
- `A/ui/editor/EmbedBinder.kt`:
  - `EmbedSpan` image bitmaps come from `Media.preview` (authenticated, cached).
  - Reflow after loading by removing and re-setting the span (no TextWatcher event).
  - `getSize` reserves the height from `PreviewGeometry` to avoid jumps.
- Tapping the image's corner removes it (the web's delete button). Tapping a foreign embed opens a read-only detail sheet with Remove.
- Cards use `firstImageSrc(body)` when `images` is empty (the web shows inline images on cards).

**Acceptance**
- [ ] An image inserted on Android shows inline at the same position on the web, with the same wrapper HTML.
- [ ] A web inline image shows on Android at its position; removing it on Android removes it on the web.
- [ ] Offline insertion falls back to `images[]` and syncs later.

**Tests:** Robolectric tests for wrapper insertion at the caret, embed removal, and the offline fallback (fake upload port).

### P7 — Background images (bgImage parity)

**Changes**
- `scripts/generate-dark-backgrounds.mjs` imports `darkIllustrationColor` and rewrites `fill`/`stroke` hex values of the 12 `src/assets/images/backgrounds/*.svg` (+ `_ph`) into committed `*_dark.svg` / `*_dark_ph.svg`.
- Web: `noteSurfaceVars` maps a known `x.svg` to `x_dark.svg` for `--note-bg-image-dark`. Text on a background image is `#202124` in the light theme and `#e8eaed` in the dark theme.
- Android:
  - A Gradle `Sync` task copies the SVGs into a generated assets srcDir, so there is one source of truth.
  - `NoteBackground.parse(bgImage)` accepts `url("…/x.svg")`, `url(…)` or a bare path and matches the 12 names. Unknown values are kept, not rendered.
  - Rendered with androidsvg (already used in `A/data/Media.kt:189-197`), cover-scaled to match the web CSS (check `input.component.scss:99` and the card CSS).
  - The picker gets a "Backgrounds" row (`_ph` thumbnails); selecting one writes `url(/assets/images/backgrounds/x.svg)` and clears nothing else, like the web.

**Acceptance**
- [ ] A background chosen on either client shows on both, in both themes.
- [ ] Choosing a color clears the background on both (consistent with the web).
- [ ] A drift test fails if the committed dark SVGs differ from regenerated output.

**Tests:** `src/app/utils/dark-backgrounds.test.ts` (drift); Android `NoteBackgroundTest`.

### P8 — Cleanup and docs

**Changes:** delete `NoteFormat`, `A/data/Bullets.kt` and `ChecklistAdapter` once they have no callers. Update `docs/architecture.md` (the content-codec ownership map) and the native docs listed in P0. Append the execution log (§12).

**Acceptance**
- [ ] No dead code (`lintDebug` clean, no unused classes).
- [ ] The docs match the code.

## 5. Bug inventory → work item

**Android:**

| ID | Bug | Fixed in |
|---|---|---|
| A1 | `<s>` round-trip makes the body read-only mid-typing | P1.2/P1.4 |
| A2 | Styled paste makes the body read-only | P1.5 |
| A3 | IME composing underline saved as `<u>` | P1.2 |
| A4 | Title raw HTML in editor, widget, notifications, search | P1.3/P3 |
| A5 | Non-ASCII saved as `&#NNN;` | P1.2 (+ S1/S2 for legacy) |
| A6 | Share-intent newlines lost | P1.3 |
| A7 | Backspace at a bullet line start bullets the line above | P1.4 |
| A8 | B/I/U add-only, stacked tags, backward selection ignored | P1.4 |
| A9 | Lists inside blocks lose bullets | P1.1 |
| A10 | `<br>` inside `<li>` flattened | P1.1 |
| A11 | Stray content inside `<ul>` deleted | P1.1 |
| A12 | Blank lines before a list vanish | P1.1 |
| A13 | "Undo changes" uses the wrong baseline after rotation | P3 |
| A14 | `href` unescaped | P1.2 |
| A15 | Move up targets hidden rows; Indent shown at max | P4 |
| A16 | Parent check doesn't cascade | P4 |
| A17 | Leading or double spaces in rows | P4 |
| A18 | Keyboard newline in a row; Backspace on an empty row | P4 |
| A19 | Enter on an empty nested bullet leaves the list | P1.4 |
| A20 | Brittle style-string match | P1 (removed) |
| A21 | Stale `lastEmitted` reset race | P1.5/P3 |
| A22 | Snapshot policy ignores revisions | P3 |
| A23 | Hybrid body hidden | P3 |
| A24 | Bottom bar, accent and EditText colors unreadable on note colors | P2.3 |
| A25 | Locale-dependent `font-size` from `Html.toHtml` | P1.2 |
| A26 | Multi-run rows read-only | P4 |

**Web:** W1–W21. **Server:** S1–S2. Both are listed in P5.

## 6. Dark color specification

**Palette** (stored value → dark render value):

| Light | Dark | Light | Dark | Light | Dark | Light | Dark |
|---|---|---|---|---|---|---|---|
| Aqua #cbf0f8 | #2d555e | Lemon #fef7cc | #5e5621 | Rose #f8c7c0 | #592d26 | Flamingo #ffc2d1 | #602030 |
| Apricot #fddcbb | #5e4022 | Lilac #e8d7ff | #3b2060 | Sage #e6f4d7 | #40522e | Coral #ffab91 | #602f20 |
| Blush #fdcfe8 | #5b2245 | Mint #ccff90 | #345920 | Sky #d2e3fc | #243a5c | Turquoise #a7ffeb | #16504b |
| Cream #fff8b8 | #7c4a03 | Peach #ffd8b5 | #603e20 | Creamsicle #ffb74d | #604620 | Lime #e6ee9c | #525629 |
| Lavender #d7aefb | #42275e | Cornflower #abc4ff | #203360 | Sand #efe0c8 | #51442e | Periwinkle #c5cae9 | #31354e |

- Aqua, Blush, Cream, Lavender, Mint and Turquoise use Google Keep's own dark values; the rest come from `darkNoteColor`.
- The 15 dark swatches (Red `#5b2121` … Cyan `#144a5c`) and `''` map to themselves.
- If 7:1 contrast is wanted everywhere, use these instead: Aqua `#2b525b`, Cream `#6d4103`, Lemon `#554d1e`, Mint `#32551f`, Lime `#4b4f26`.

**Algorithms** (identical in TS and Kotlin; fixtures generated from TS):
- **`darkNoteColor(stored)`**:
  1. Parse 3-, 6- or 8-digit hex or `rgb()/rgba()`. Unparseable or empty → return the input unchanged.
  2. Palette hit → return the table value.
  3. WCAG luminance ≤ 0.12 → return the normalized lowercase hex.
  4. Otherwise go to HSL: h kept; s' = min(0.5·s, 0.6); lightness starts at 25 (integer hundredths) and decreases by 1 while luminance > 0.10 and lightness > 15. Channels use `Math.round(x·255)` (half-up).
  5. Return lowercase `#rrggbb`.
  
  Samples, re-pinned from TS: `#ffffff→#404040`, `#f28b82→#5a2a26`, `#fbbc04→#5f4f21`, `#ff0000→#602020`; `#0000ff` and `#5b0000` unchanged.
- **`noteTextColor(displayedBg)`**: whichever of `#202124` and `#e8eaed` has the higher WCAG contrast; ties → `#202124`. No color → the theme text color. Background image → `#202124` in the light theme, `#e8eaed` in the dark theme.
- **`noteLinkColor(bg)`**: `#1a73e8` when the text color is `#202124`, otherwise `#8ab4f8`.
- **`darkIllustrationColor(hex)`** = HSL(h, min(s, 0.45), 0.10 + (1 − l)·0.6). Example: `#fff8d9→#362f14`.

## 7. Test plan

**Web (repository root):**
- `npm run test:utils`:
  - `note-color.test.ts` (extended)
  - new `checklist-model.test.ts`
  - `checklist-conversion.test.ts` (wrapper as leftover, tool skipped)
  - new `dark-backgrounds.test.ts`
- Karma:
  - New `src/app/utils/keeparr-html.spec.ts`: fixture `nonBlankLines` through `splitBodyIntoLines(DOMParser body)`, `innerText` for `browserInnerText` cases, `sanitizeRowHtml` keeps the vocabulary, `hasMeaningfulBody`, and fixture `titles`. Add `"resolveJsonModule": true` to `tsconfig.spec.json`.
  - `input.component.spec.ts`: update the "single pasted line left to the browser" spec (312) and the A-bar close spec (367); add one spec per W item.
- Server and MCP: `npm run test:server`, `npm run test:mcp`, `npm run test:native` (S1, S2, W19).

**Android (`android-native/`):**
- New: `NoteHtmlFixtureTest`, `RichTextOpsTest`, `RoundTripFuzzTest`, `BlockModelTest`, `KeeparrEditTextTest`, `ChecklistModelTest`, `NoteBackgroundTest`, embed and inline-image tests, ViewModel tests (P3).
- Updated: `NativeContractTest`, `NotePaletteTest`, `WidgetBehaviorTest`, `HomeProjectionTest` (hybrid `bodyText`, title decoding).
- Micro-benchmark (JVM unit test, reported in the log): parse + normalize + serialize of a 50 KB fixture body, median < 16 ms. If it is slower on device, debounce serialization to about 120 ms, flushing on pause, close and toolbar actions.

**Commands:**
```bash
# repository root
npm run build
CHROME_BIN=/usr/bin/chromium npm test -- --watch=false --browsers=ChromeHeadless
npm run test:utils && npm run test:native && npm run test:sync && npm run test:reminders
npm run test:server && npm run test:scale && npm run test:mcp
git diff --check
# android-native/
./gradlew testDebugUnitTest assembleDebug lintDebug
./gradlew testDebugUnitTest --tests 'dev.keeparr.android.data.html.*'
```

## 8. Execution

1. **P0 first, single-threaded:** the contract doc and fixtures, so every workstream builds against the same spec.
2. **Then at most 3 parallel agents**, each in its own git worktree:
   - **A — Android editor:** P1 → P3 → P4 (Android side) → P6.
   - **B — Web and server:** P2.1–P2.2 → P5 (W1–W20, S1–S2) → P4 (web side) → P7 generator.
   - **C — Android colors:** P2.3–P2.5 → P7 (Android side). It touches the color code in `NoteEditor.kt`, so rebase onto A once P1 lands.
3. **Merge order:** P0 → B's P2.1 (the color spec C depends on) → A's P1 → C → the rest. Every merged phase leaves all §7 commands green.
4. **Commits:** one reviewable commit per work item or phase. No Co-Authored-By trailers.
5. **Rules carried over from the previous plan:** inspect the tree before each slice and preserve user work; add regression tests for every data-loss fix; never clear pending user data to solve an upgrade problem; append the log in §12 with checks run and their results.

## 9. Release gates (definition of done)

- [ ] Every work item's acceptance boxes are checked with current evidence.
- [ ] Every §7 command passes on the final head.
- [ ] **Cross-client journeys,** each run both directions (web → Android and Android → web):
  1. A note with H1, H2, a three-level bullet list, B/I/U/strikethrough, an inline image, a Takeout link and accented text: fully editable on the other client. After an edit there, the original client shows the same structure, and the stored HTML has UTF-8 accents and no style noise added by a client.
  2. A checklist with nested and completed rows: check a parent; Enter mid-row; Backspace merge; reorder; then hide and show checkboxes. Identical result on both clients.
  3. A hybrid note: both parts editable on both clients.
  4. Dark and light theme on both clients: pastels show the §6 dark values on cards, in the editor, the picker and widgets (system night); stored `bgColor` is unchanged (check via the API).
  5. Background image picked on Android, viewed on the web in both themes, and the reverse.
  6. Web: drawing note with a title, open then close → title kept; a remote checkbox toggle while the note is open, then close → body kept.
- [ ] **Device QA matrix:** Gboard, Samsung Keyboard and SwiftKey × (Backspace at line/row start, Enter in a heading/list/row, composing, paste, pending bold); a 300-row checklist; a 50 KB body; TalkBack labels on the toolbar and embeds. Record unavailable hardware separately (see §11).

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Size of the Android editor rewrite | Pure controller, fixture corpus, seeded fuzz round-trip, phased merges |
| IME differences in Backspace/Enter interception | InputConnection wrapper plus key listener; device matrix |
| Per-keystroke normalize + serialize is O(n) | Benchmark; debounced serialization fallback |
| The first Android edit rewrites legacy bodies (`<p dir…>` → `div`, `&#232;` → `è`) | Visually identical; untouched notes never rewritten; existing field-level merge handles concurrent edits |
| EditText inside a Compose scroll | Explicit bring-into-view; `LazyColumn` fallback for long checklists |
| `setApplicationNightMode` recreates the activity | State lives in the ViewModel and `rememberSaveable`; caret loss on theme switch is acceptable |
| Dark illustration colors need a design review | Generated by script, so easy to retune |
| Robolectric may not model `setColorInt` night actions | Assert the computed light/dark pair directly |

## 11. Out of scope and carried-over items

**Out of scope (follow-ups):**
- A native Android drawing editor: drawings stay viewable and preserved, and their title and body are editable.
- Editing inside foreign tables: they stay atomic and removable.
- Rich titles.
- Web-only extras not about content: completed-item suggestions, the "move completed to bottom" preference, link preview cards, location reminders.

**Carried over from the previous plan** (`git show 7404f7a:PLAN.md`, §M6), still open:
- **M6.4 — Supported Android acceptance.** Blocked on hardware: API 34/35/36 devices, gateway/mTLS, permissions, reboot/timezone, insets, launchers.
- **M6.5 — Accessibility and lifecycle acceptance.** The web part is done; TalkBack and Android lifecycle cycles need hardware.
- **M6.6 — Installable release configuration.** Needs a signing/distribution decision and a device install.

## 12. Execution log

Append one entry per slice: date, items, decisions, checks run with results, remaining blockers, and the next dependency.

### 2026-10-13: P0 contract and fixtures, P2.1 color reference

- Added `docs/note-content-contract.md` (linked from `docs/architecture.md`, `docs/native-android-plan.md`; read-only wording fixed at `native-android-plan.md:122` and `native-android-remediation-plan.md:305`).
- Added fixture sections `editorHtml` (82 cases, 78 edits, 21 rows, titles, titleEdits), `noteColors` (generated by `scripts/generate-note-color-fixtures.mjs`) and `checklistOps` (59 ops). `nonBlankLines` was computed with the real `splitBodyIntoLines` over parse5; the rest is hand-written (schema in the contract doc, section 6).
- Added the P2.1 functions to `src/app/utils/note-color.ts` with tests.
- Decisions: `edits`/`rows` carry the editor `text`; `rows[].expected` is always an array; `noteTextColor`/`noteLinkColor` take a `dark` flag for the no-color case.
- Finding: the fixed link colors cannot reach 4.5:1 on every pastel (Lavender light 2.4:1, Cream dark 3.5:1), so the P2.2 acceptance line "text and link colors meet 4.5:1 on every swatch" holds for text only.
- Open: the plan's Backspace-at-list-item rule differs from real Chrome for non-first items; fixtures follow the plan.
- Checks: `npm run test:utils` 63 pass; `npm run test:native` pass; `NativeContractTest` 54 pass (incl. `sharedEditorFixturesLoad`).
- Next: P1 (Android codec) and P2.2 (web rendering) build against these fixtures.
