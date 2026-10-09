// Note titles, bodies and checklist items are HTML that other users' browsers put into the page (a collaborator can write
// to a shared note through the API). Scripts do not run from innerHTML, but event handlers such as <img onerror> do, even
// on a detached element, so active content is removed when a note is stored.
//
// Clean values are returned untouched, byte for byte: re-serializing every body would rewrite <br> and entities, which the
// clients compare and round-trip exactly. Only a value that contains active content goes through the sanitizer.
const sanitizeHtml = require('sanitize-html');

const ACTIVE_TAG = /<\s*\/?\s*(?:script|iframe|frame|frameset|object|embed|applet|meta|base|link|form|svg|math|style)\b/i;
const EVENT_ATTRIBUTE = /<[^>]*[\s"'/]on[a-z]+\s*=/i;
const SCRIPT_URL = /<[^>]*[\s"'/](?:href|src|xlink:href|action|formaction|data|srcdoc|poster|background)\s*=\s*["']?[\s\u0000-\u001f]*(?:javascript|vbscript|data\s*:\s*text\/html)/i;

function hasActiveContent(html) {
  return ACTIVE_TAG.test(html) || EVENT_ATTRIBUTE.test(html) || SCRIPT_URL.test(html);
}

// What the editor itself produces (blocks, lists, inline formatting, links, inline images and their wrappers).
const SANITIZE_OPTIONS = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'font']),
  allowedAttributes: {
    '*': ['class', 'style', 'dir', 'contenteditable', 'data-*', 'aria-*', 'title'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
    font: ['color', 'face', 'size']
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowProtocolRelative: false
};

/** The value without active content; the same string when it has none, and non-strings are returned as they are. */
function neutralizeActiveHtml(value) {
  if (typeof value !== 'string' || !hasActiveContent(value)) return value;
  return sanitizeHtml(value, SANITIZE_OPTIONS);
}

/** Checklist items as stored: an array of objects (or its JSON text) whose `data` is HTML. */
function neutralizeChecklist(value) {
  if (Array.isArray(value)) {
    return value.map(item => (item && typeof item === 'object' && typeof item.data === 'string' && hasActiveContent(item.data)
      ? { ...item, data: neutralizeActiveHtml(item.data) }
      : item));
  }
  if (typeof value === 'string' && hasActiveContent(value)) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return JSON.stringify(neutralizeChecklist(parsed));
    } catch { /* not JSON: nothing to parse, leave it for the caller to reject */ }
  }
  return value;
}

module.exports = { neutralizeActiveHtml, neutralizeChecklist, hasActiveContent };
