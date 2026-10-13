# Note content contract

Normative. The web editor and the native Android editor read and write the same HTML strings (note body, note title, checklist item `data`), so they must agree on vocabulary, escaping and editing results. The shared fixtures in `test-fixtures/native-contract.json` are the source of truth: both test suites consume them, and a fixture change needs a matching change on both clients. The web tests live in `src/app/utils/` (`native-contract-fixtures.test.ts`, `note-color.test.ts`); the Android loader is `NativeContractTest.sharedEditorFixturesLoad`.

Invariants:

1. Stored `bgColor` and `bgImage` values are data. Dark variants exist only at render time. Adding a swatch is safe; editing or removing one is a data migration.
2. Untouched content is never rewritten. A client writes a field only when the user changed it; opening and closing a note produces no write. If an edit is undone back to the original state, the original string is written back unchanged.
3. No silent content loss. Content a client cannot express natively is preserved byte-for-byte (atomic embeds) or kept along with its tag and attributes (inline and block frames).
4. String content is never read-only on either client.

## 1. Whitespace and escaping

- Bodies render with `white-space: pre-wrap`. A raw `\n` in a text node is a line break, spaces are significant, `&nbsp;` is U+00A0.
- Text escapes only `&`, `<` and `>`, and writes U+00A0 as `&nbsp;`. Attribute values escape `&` and `"` (so `<` and `>` stay literal inside attributes). Everything else is literal UTF-8 (no numeric entities on write). This matches Chrome's `innerHTML`.
- Boolean attributes are written as `name=""`, attributes keep their source order, and values are double-quoted.

## 2. Vocabulary

| Class | Elements | Behavior on both clients |
|---|---|---|
| Authored blocks (body) | text run, `div`, `<div><br></div>`, `br`, `h1`, `h2`, `ul`/`li` (nested inside `li`, or Chrome's sibling shape `<ul><li>a</li><ul>...</ul></ul>`) | create, edit, write |
| Authored inline (body and rows) | `b`, `i`, `u`, `a[href]` | create, edit, write |
| Authored embed | `<div class="inline-note-image-wrap" contenteditable="false"><img class="inline-note-image" src="/api/uploads/images/..." alt="..."></div><div><br></div>` (exact string) | insert, remove, move with surrounding text |
| Preserved blocks | `p`, `h3`-`h6`, `ol` (with `start`), `blockquote`, `pre`, unknown blocks containing text | editable text; tag and attributes kept |
| Preserved inline | `strong`, `em`, `s`, `strike`, `del`, `code`, `span`/`font` with attributes, `sub`, `sup`, `mark`, `small`, unknown inline | editable text; tag and attributes kept; rendered (bold, italic, strike, mono, color) |
| Atomic embeds | `table`, `hr`, bare `img`, `video`, `audio`, `iframe`, `object`, `canvas`, `svg`, `figure`, any `contenteditable="false"` block | shown (image or labeled preview card), removable as a unit, written back verbatim |
| Structured checklist items (non-string `data`) | - | read-only on both clients, shown with a label. No client creates them |

## 3. Title

- The title is plain text on both clients. Stored form is escaped text (section 1). Reading decodes entities and strips tags into text; an emptied contenteditable title (`<br>`) reads and saves as `""`.
- Writing: if the decoded original equals the new text, write the original string back unchanged; otherwise write the escaped new text.
- No formatting commands apply to the title.

## 4. Editing semantics (Chrome is the reference)

| Action | Result |
|---|---|
| Enter in a block | new sibling block of the same kind; at the end of a heading, a new `div`; in the bare first line, Chrome's shape (`ab<div><br></div>`) |
| Enter on an empty list item | outdent one level; at level 0 leave the list (the line becomes `div`) |
| Backspace at the start of a list item | remove the bullet (outdent to a plain line, splitting the list); a second Backspace merges with the previous line |
| Backspace at the start of a heading or quote line | heading becomes `div`; quote drops one quote level |
| Paste (body, title, rows) | plain text only. In a list each non-blank pasted line becomes an item; elsewhere lines are joined with `<br>` (matches `insertPlainTextAtCursor`) |
| Drop of text or HTML | same as paste |
| Clear | removes inline formatting (`b i u s strong em` and style spans) and bullets; keeps headings and links |
| B/I/U with a selection | toggles: removes if the whole selection already has the style, otherwise adds |
| B/I/U with an empty selection | toggles a pending typing style for the next inserted text; the stored string does not change |
| Row Enter | splits the row at the caret; formatting is kept on both sides |
| Row Backspace at its true start | non-empty: merge into the previous **visible** row; empty: delete the row and focus the previous row's end |
| Row multi-line paste | first line goes into the row at the caret, the remaining lines become new rows after it, the text after the caret stays behind the last line |

The Backspace-at-list-item rule is the plan's wording; real Chrome merges a non-first item into the previous item on the first press. The fixtures follow the plan (`backspace-bullet-middle-of-list`), so the web editor handles Backspace at the start of a list item, heading or quote line itself (`InputComponent.backspaceAtBodyLineStart`: the item becomes a `div` and splits the list, a heading becomes a `div`, a quote line leaves one quote level); the second press is the browser's own merge. `input.component.spec.ts` replays these fixtures in Chrome. That list edit is made on the DOM, so it is not a step of the browser's undo history.

Toolbar: body offers H1, H2, Normal, bullet, indent, outdent, B, I, U, Clear, Undo, Redo. A checklist row offers B, I, U, Clear, Undo, Redo (block buttons disabled). The title offers none.

## 5. Hybrid notes

A note is hybrid when `isCbox && hasMeaningfulBody(body)`. `hasMeaningfulBody` is true when the visible text (U+00A0 counted as a space, then trimmed) is non-empty, or the body contains an `img` or an atomic embed. Both clients use this rule in the editor and on cards.

## 6. Fixture schema

Everything under `editorHtml`, `noteColors` and `checklistOps`. Every entry has a unique `id` and a one-line `note` explaining the quirk it pins. Invisible characters are written as `\u` escapes: `\u00a0` is nbsp and `\ufffc` stands for an embed in editor text.

### 6.1 Model terms

- **Editor text** is the document as one string: lines joined by `\n`, each atomic embed one `\ufffc` character, UTF-16 offsets. A truly empty body has no lines (`[]`); `<div><br></div>`, `<br>` or an empty `<li>` is one empty line (`[""]`).
- **Canonical form** is the dialect a client writes after an edit. It is a lossless re-serialization of the parsed document, not a rewrite into a fixed template: tag, attributes and nesting of block frames are kept (including the sibling list shape, bare first lines, and `p` tags). The only normalizations are:
  - text is re-escaped per section 1 (numeric and named entities decode to UTF-8; nbsp stays `&nbsp;`);
  - the exact legacy Android signature `<p dir="ltr" style="margin-top:0; margin-bottom:0;">` becomes `div`; other `p` tags are kept;
  - `script`, `style` and comments are dropped;
  - an empty `<div></div>` is dropped; zero-length inline elements are dropped;
  - trailing top-level whitespace-only runs (ASCII whitespace; nbsp is content) are dropped, and a final raw newline of a run adds no line;
  - an empty line that is only a raw newline between blocks is written as `<div><br></div>`;
  - adjacent inline elements with the same tag and attributes are merged after an edit (not on a read);
  - `canonical(canonical(x)) == canonical(x)`.
- **Preview text** shows list markers: unordered `• ◦ ▪ ▫` by depth, ordered `n.` (respecting `ol[start]`, restarting per list), two spaces of indent per level, depth capped at 4 for glyph and indent (level 5 is kept in the data and drawn at level 4). A stray text run inside a list has no marker and no indent. Quotes and headings have no marker. Lines of an item continued with `<br>` are not pinned: cases that involve them have no `preview`.
- **nonBlankLines** is exactly what the web's `splitBodyIntoLines` returns for the parsed body (whitespace runs collapse to one space, nbsp becomes a space, blank lines are skipped, tables and `hr` do not split lines). Quirky results are recorded as they are and the case `note` says so. It is omitted where the web walker is not a sensible reference (`script-style-dropped`).

### 6.2 `editorHtml`

| Key | Shape | Checks |
|---|---|---|
| `authoredBody`, `authoredRow` | arrays of strings | every string a client may write; each is a fixed point of `canonical` |
| `cases[]` | `{id, note, html, lines, nonBlankLines?, canonical, preview?, hasMeaningfulBody, browserInnerText}` | `lines(html)`, `nonBlankLines(html)`, `canonical(html)`, `previewText(html)`, `hasMeaningfulBody(html)`. `browserInnerText: true` means a pre-wrap element's `innerText` equals `lines.join("\n")` (karma only). `preview` is omitted where not pinned (embeds, `<br>` in `li`) |
| `edits[]` | `{id, note, html, text, selection:[s,e], action, expected}` | apply `action` at `selection` (offsets into `text`, the editor text of `html`; `s > e` is a backward selection) and compare the new body string with `expected` (the canonical form). `action` is `enter`, `backspace`, `bold`, `italic`, `underline`, `h1`, `h2`, `normal`, `bullet`, `indent`, `outdent`, `clear`, or `paste:<text>` (text may contain `\n`, `\r\n`) |
| `rows[]` | `{id, note, html, text, edit:{selection:[s,e], insert}, expected:[...]}` | replace `[s,e)` of the row's display text `text` with `insert`; `expected` is always an array of row html strings. A `\n` (or `\r\n`) in `insert` splits the row, so a typed Enter and a multi-line paste are the same operation: insert, then split at each line break |
| `titles[]` | `{id, note, html, text, canonicalHtml?}` | `titleText(html) == text`; `titleHtml(text) == (canonicalHtml ?? html)`; `titleHtml(text, html) == html` |
| `titleEdits[]` | `{id, note, original, text, html}` | `titleHtml(text, original) == html` |

Edit and row details that the fixtures rely on:

- Text inserted by an edit takes the format of the character before the caret (the character after it at offset 0); when replacing a non-empty selection it takes the format of the first replaced character.
- Indent nests an item under the previous `li`; the first item has no previous `li` and uses the sibling shape `<ul><ul><li>a</li></ul></ul>`. Indent on a plain line writes Chrome's `<blockquote style="margin: 0 0 0 40px; border: none; padding: 0px;">`.
- Mid-heading Enter is not pinned (Chrome splits the heading, the plan says new `div`).
- Overlapping inline spans are closed and reopened at boundaries; tags that start together are ordered by end descending, then by existing order (`bold-overlap-reopens`, `bold-around-link`).

### 6.3 `noteColors`

Generated by `node scripts/generate-note-color-fixtures.mjs` from `src/app/utils/note-color.ts` (`--check` fails when the committed file is stale). Never edit it by hand.

| Key | Shape | Checks |
|---|---|---|
| `palette[]` | `{name, light, dark}` | all 35 stored swatches: `darkNoteColor(light) == dark`. 20 pastels use the table, the 15 dark swatches map to themselves |
| `fallback[]` | `{input, dark}` | `darkNoteColor(input)`: 3/6/8-digit hex and `rgb()/rgba()` are parsed; luminance <= 0.12 stays as is; otherwise HSL with s = min(0.5 s, 0.6), lightness 25 (hundredths) lowered by 1 while luminance > 0.10 and lightness > 15, channels `Math.round`; unparseable or empty input is returned unchanged |
| `text[]` | `{background, text, dark?}` | `noteTextColor(background, dark)`: the better contrast of `#202124` and `#e8eaed` (ties `#202124`); no or unparseable color gives the theme text color, so those entries carry the theme flag `dark` |
| `link[]` | `{background, link, dark?}` | `noteLinkColor`: theme accent when it reaches 4.5:1 contrast; otherwise the matching high-contrast text color (links are underlined) |
| `illustration[]` | `{input, dark}` | `darkIllustrationColor`: HSL(h, min(s, 0.45), 0.10 + (1 - l) * 0.6) |
| `darkThreshold`, `maxDarkLuminance` | numbers | 0.12 and 0.10 |

Contrast: text and link colors reach at least 4.5:1 on every stored swatch in both themes. On backgrounds where the theme accent cannot meet that threshold, links use the matching text color and remain underlined.

### 6.4 `checklistOps`

`{id, note, op, items, args, expected}`. Rows are `{id, done, data, indentLevel, ...unknown}`; unknown fields and structured (non-string) `data` survive every op. `expected` is the resulting rows array, or `null` when the op changes nothing or does not apply. Ops are pure; ids are never reused (new ids are max numeric id + 1). Indent levels are 0 to 3.

| op | args | Semantics |
|---|---|---|
| `setIndent` | `{id, indentLevel}` | level clamps to 0..3 and to the row above plus one; descendants (contiguous deeper rows) shift by the same delta and clamp at 0..3 |
| `toggleDone` | `{id}` | the row and all descendants take the row's toggled state |
| `moveBefore` | `{id, beforeId \| null}` | only that row moves (children stay); `null` moves to the end; then `normalizeIndentLevels` over the list; self or same-place moves are `null` |
| `split` | `{id, left, right}` | the row takes `left`, a new unchecked row with `right` and the same indent is inserted directly after it (before its children); structured rows give `null` |
| `merge` | `{id, visibleIds?}` | a row without visible text (after stripping tags, nbsp counted as space) is deleted; otherwise its html is appended to the previous row in `visibleIds` order (default: list order), which keeps its id, done and indent, and the row is removed; no previous row or a structured row on either side gives `null` |
| `remove` | `{id}` | removes only that row |
| `show` | `{body}` | expected is `{items, body}`: each `nonBlankLines(body)` entry becomes an unchecked level-0 row with escaped text, appended after existing rows; `body` keeps only the embeds (inline image wrappers) so the note becomes hybrid |
| `hide` | `{body}` | expected is `{items: [], body}`: `body` followed by `<div>data</div>` for each unchecked string row with visible text; checked rows are dropped; an unchecked structured row blocks it (`null`) |

Removing or merging a row can leave a deeper row without a parent. The fixtures avoid pinning that state; renderers apply `normalizeIndentLevels`.
