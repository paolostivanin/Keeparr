// Text helpers shared by note, card, reminder and search code.

function plainText(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
