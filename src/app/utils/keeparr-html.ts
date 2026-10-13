/**
 * The web side of the note content contract (docs/note-content-contract.md): title text,
 * "meaningful body" and the checklist-row sanitizer. Browser-only (they use inert <template>
 * parsing); the fixtures in test-fixtures/native-contract.json are checked by
 * keeparr-html.spec.ts.
 */

/** Text escaping on write: only `&`, `<`, `>`; U+00A0 as `&nbsp;`. Everything else stays literal UTF-8. */
export function escapeText(text: string): string {
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;');
}

function parseFragment(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html || '';
  return template.content;
}

/** The text a stored title shows: entities decoded, tags dropped (`<br>` of an emptied contenteditable is empty). */
export function titleText(html: string): string {
  const fragment = parseFragment(html);
  fragment.querySelectorAll('script, style').forEach(element => element.remove());
  return fragment.textContent || '';
}

/**
 * The string to store for a title. A title the user did not change keeps its original string
 * (a legacy `Caff&#232;` or `<b>x</b>` is not rewritten); otherwise the new text is escaped.
 */
export function titleHtml(text: string, original = ''): string {
  if (original && titleText(original) === text) return original;
  return escapeText(text);
}

/** Atomic embeds (contract section 2): shown and removed as a unit, never edited as text. */
const EMBED_SELECTOR = 'img, table, hr, video, audio, iframe, object, canvas, svg, figure, [contenteditable="false"]';

/**
 * Whether a body holds anything worth showing: visible text (U+00A0 counts as a space, then trim)
 * or an image / atomic embed. One rule for the editor and the cards.
 */
export function hasMeaningfulBody(html?: string | null): boolean {
  if (!html) return false;
  const fragment = parseFragment(html);
  fragment.querySelectorAll('script, style').forEach(element => element.remove());
  if ((fragment.textContent || '').replace(/\u00a0/g, ' ').trim()) return true;
  return !!fragment.querySelector(EMBED_SELECTOR);
}

const ROW_TAGS = new Set(['B', 'I', 'U', 'A', 'STRONG', 'EM', 'S', 'STRIKE', 'DEL', 'CODE', 'SPAN', 'FONT', 'SUB', 'SUP', 'MARK', 'SMALL', 'BR']);
/** Elements dropped together with their content. */
const ROW_DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'BASE', 'SVG', 'MATH', 'FORM', 'TEXTAREA', 'SELECT', 'VIDEO', 'AUDIO', 'CANVAS']);
const ROW_ATTRIBUTES: Record<string, readonly string[]> = {
  A: ['href', 'target', 'rel', 'title'],
  SPAN: ['style', 'class'],
  FONT: ['color', 'face', 'size', 'style'],
  MARK: ['style'],
};
const SAFE_STYLE_PROPERTIES = new Set([
  'color', 'background-color', 'font-weight', 'font-style', 'font-size', 'font-family', 'text-decoration', 'text-decoration-line',
  'text-decoration-color', 'text-decoration-style', 'vertical-align', 'white-space',
]);
const SAFE_URL = /^(?:https?:|mailto:|tel:|\/|#|\.\.?\/|[^:/?#]+(?:[/?#]|$))/i;

function safeStyle(value: string): string {
  const kept: string[] = [];
  for (const declaration of value.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const text = declaration.slice(colon + 1).trim();
    if (!SAFE_STYLE_PROPERTIES.has(property) || !text || /url\s*\(|expression\s*\(|[<>{}\\]|@import/i.test(text)) continue;
    kept.push(`${property}: ${text};`);
  }
  return kept.join(' ');
}

function sanitizeNode(node: Node, output: Node) {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      output.appendChild(document.createTextNode(child.textContent || ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.tagName.toUpperCase();
    if (ROW_DROP.has(tag)) continue;
    if (!ROW_TAGS.has(tag)) {
      // Unknown or block markup: keep its text (rows are one line of inline content).
      sanitizeNode(element, output);
      continue;
    }
    const copy = document.createElement(tag.toLowerCase());
    const allowed = new Set(ROW_ATTRIBUTES[tag] ?? []);
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value;
      // Safe extension attributes must survive a view/save without being edited.
      if (!allowed.has(name) && !name.startsWith('data-') && !name.startsWith('aria-') && name !== 'title' && name !== 'dir') continue;
      if (/^on/i.test(name) || name === 'srcdoc') continue;
      if (['href', 'src', 'xlink:href', 'action', 'formaction'].includes(name) && !SAFE_URL.test(value.replace(/[\u0000- ]/g, ''))) continue;
      if (name === 'style') {
        const style = safeStyle(value);
        if (style) copy.setAttribute('style', style);
        continue;
      }
      if (name === 'class' && !/^[\w\s-]*$/.test(value)) continue;
      copy.setAttribute(name, value);
    }
    if (tag === 'A' && copy.hasAttribute('target') && !copy.hasAttribute('rel')) copy.setAttribute('rel', 'noopener');
    sanitizeNode(element, copy);
    output.appendChild(copy);
  }
}

/**
 * Cleans the stored html of a checklist row before it is written into the editable row: inline
 * vocabulary of the contract (`b i u a strong em s strike del code span font sub sup mark small br`)
 * stays with its attributes, scripts, handlers, unsafe links and unknown markup do not. A string that
 * is already clean comes back byte for byte.
 */
export function sanitizeRowHtml(html: string): string {
  const source = parseFragment(String(html ?? ''));
  const out = document.createElement('div');
  sanitizeNode(source, out);
  return out.innerHTML;
}
