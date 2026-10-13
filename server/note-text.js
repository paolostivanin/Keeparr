// Text helpers shared by note, card, reminder and search code.

function plainText(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    // Decode once, so an escaped literal reference such as &amp;#232; remains &#232;.
    .replace(/&(?:nbsp|amp|lt|gt|quot|#(?:x[0-9a-f]{1,6}|\d{1,7}));/gi, decodeHtmlEntity)
    .replace(/\s+/g, ' ')
    .trim();
}

// The supported named references and numeric references are decoded in one pass.
function decodeHtmlEntity(match) {
  const named = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' };
  if (named[match.toLowerCase()]) return named[match.toLowerCase()];
  const numeric = match.slice(2, -1);
  const codePoint = numeric[0].toLowerCase() === 'x'
    ? parseInt(numeric.slice(1), 16)
    : parseInt(numeric, 10);
  if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return match;
  return String.fromCodePoint(codePoint);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function notePreviewText(row) {
  const bodyText = plainText(row.noteBody || '');
  const checkBoxes = parseJson(row.checkBoxes || '[]', []);
  const checklistText = Array.isArray(checkBoxes)
    ? checkBoxes.map(item => plainText(item?.data || '')).filter(Boolean).join(' ')
    : '';
  return (bodyText || checklistText || '').slice(0, 280);
}

function noteLinkCount(row) {
  const urls = new Set();
  const addUrls = (value) => {
    for (const match of String(value || '').matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
      const url = match[0].replace(/[),.;:!?]+$/, '');
      if (url) urls.add(url);
    }
  };
  addUrls(row.noteBody || '');
  const checkBoxes = parseJson(row.checkBoxes || '[]', []);
  if (Array.isArray(checkBoxes)) checkBoxes.forEach(item => addUrls(item?.data || ''));
  return urls.size;
}

module.exports = { plainText, parseJson, escapeHtml, notePreviewText, noteLinkCount };
