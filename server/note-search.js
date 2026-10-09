// Search query parsing and the SQL predicates for it. Pure: callers run the queries.

function searchTextFromQuery(query) {
  return String(query || '')
    .split(/\s+/)
    .filter(token => token &&
      !/^!i(?:m(?:a(?:g(?:e)?)?)?)?$/i.test(token) &&
      !/^!l(?:a(?:b(?:e(?:l(?::[a-z0-9_-]+)?)?)?)?)?$/i.test(token) &&
      !/^!label:[a-z0-9_-]+$/i.test(token) &&
      !/^!d(?:r(?:a(?:w(?:ing)?)?)?)?$/i.test(token) &&
      !/^!t(?:o(?:d(?:o)?)?)?$/i.test(token) &&
      !/^!a(?:t(?:t(?:a(?:c(?:h(?:m(?:e(?:n(?:t)?)?)?)?)?)?)?)?)?$/i.test(token) &&
      !/^!url?$/i.test(token)
    )
    .join(' ')
    .trim();
}

function searchTokensFromQuery(query) {
  return searchTextFromQuery(query)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s/:\-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function searchOperatorsFromQuery(query) {
  const operators = {
    hasImage: false,
    hasCheckbox: false,
    hasDrawing: false,
    hasAnyLabel: false,
    hasUrl: false,
    hasAttachment: false,
    labels: []
  };
  for (const token of String(query || '').toLowerCase().split(/\s+/).filter(Boolean)) {
    if (/^!i(?:m(?:a(?:g(?:e)?)?)?)?$/.test(token)) operators.hasImage = true;
    else if (/^!t(?:o(?:d(?:o)?)?)?$/.test(token)) operators.hasCheckbox = true;
    else if (/^!d(?:r(?:a(?:w(?:ing)?)?)?)?$/.test(token)) operators.hasDrawing = true;
    else if (/^!url?$/.test(token)) operators.hasUrl = true;
    else if (/^!a(?:t(?:t(?:a(?:c(?:h(?:m(?:e(?:n(?:t)?)?)?)?)?)?)?)?)?$/.test(token)) operators.hasAttachment = true;
    else if (/^!label:[a-z0-9_-]+$/.test(token)) operators.labels.push(token.slice('!label:'.length));
    else if (/^!l(?:a(?:b(?:e(?:l)?)?)?)?$/.test(token)) operators.hasAnyLabel = true;
  }
  return operators;
}

function noteOperatorWhere(operators) {
  const clauses = [];
  const params = [];
  if (operators.hasImage) {
    clauses.push(`(
      COALESCE(bgImage, '') <> ''
      OR LOWER(COALESCE(noteBody, '')) LIKE '%<img%'
      OR (COALESCE(images, '') <> '' AND COALESCE(images, '') <> '[]' AND LOWER(COALESCE(images, '')) NOT LIKE '%"id":"drawing"%')
    )`);
  }
  if (operators.hasCheckbox) clauses.push(`(isCbox = 1 OR (COALESCE(checkBoxes, '') <> '' AND COALESCE(checkBoxes, '') <> '[]'))`);
  if (operators.hasDrawing) clauses.push(`LOWER(COALESCE(images, '')) LIKE '%"id":"drawing"%'`);
  if (operators.hasAnyLabel) clauses.push(`COALESCE(labels, '') <> '' AND COALESCE(labels, '') <> '[]'`);
  if (operators.hasUrl) {
    clauses.push(`(
      LOWER(COALESCE(noteTitle, '')) LIKE '%http://%'
      OR LOWER(COALESCE(noteTitle, '')) LIKE '%https://%'
      OR LOWER(COALESCE(noteBody, '')) LIKE '%http://%'
      OR LOWER(COALESCE(noteBody, '')) LIKE '%https://%'
    )`);
  }
  if (operators.hasAttachment) clauses.push(`attachmentCount > 0`);
  for (const label of operators.labels) {
    clauses.push(`LOWER(REPLACE(COALESCE(labels, ''), ' ', '-')) LIKE ?`);
    params.push(`%${label}%`);
  }
  return { clauses, params };
}

function noteSearchWhere(tokens, options = {}) {
  const params = [];
  const conditions = tokens.map(token => {
    const like = `%${token}%`;
    if (options.protectLockedContent) {
      params.push(like, like, like, like, like, like, like, like);
      return `(
        (locked = 1 AND (
          LOWER(COALESCE(noteTitle, '')) LIKE ?
          OR LOWER(COALESCE(labels, '')) LIKE ?
          OR LOWER(COALESCE(binder, '')) LIKE ?
        ))
        OR (locked = 0 AND (
          LOWER(COALESCE(noteTitle, '')) LIKE ?
          OR LOWER(COALESCE(noteBody, '')) LIKE ?
          OR LOWER(COALESCE(checkBoxes, '')) LIKE ?
          OR LOWER(COALESCE(labels, '')) LIKE ?
          OR LOWER(COALESCE(attachmentNames, '')) LIKE ?
        ))
      )`;
    }
    params.push(like, like, like, like, like);
    return `(LOWER(COALESCE(noteTitle, '')) LIKE ?
      OR LOWER(COALESCE(noteBody, '')) LIKE ?
      OR LOWER(COALESCE(checkBoxes, '')) LIKE ?
      OR LOWER(COALESCE(labels, '')) LIKE ?
      OR LOWER(COALESCE(attachmentNames, '')) LIKE ?)`;
  });
  return { clause: conditions.join(' AND '), params };
}

module.exports = { searchTextFromQuery, searchTokensFromQuery, searchOperatorsFromQuery, noteOperatorWhere, noteSearchWhere };
