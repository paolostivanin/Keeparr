// Reading notes: row to API and card shapes, summaries and cursors, access checks, collaborators and recipients.
const { all, get } = require('./db');
const { canonicalizeNoteHtmlImages, canonicalizeNoteImages } = require('./files');
const { escapeHtml, noteLinkCount, notePreviewText, parseJson, plainText } = require('./note-text');
const { neutralizeActiveHtml, neutralizeChecklist } = require('./html-safety');
const { noteSearchWhere, searchGroupsFromQuery } = require('./note-search');
const { publicCollaborator } = require('./users');
const { realtimeClients } = require('./realtime');

function appliedNoteLabels(labels) {
  const normalized = [];
  const seen = new Set();
  for (const label of Array.isArray(labels) ? labels : []) {
    const name = String(label?.name || '').trim();
    if (!name || label?.added !== true) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ id: label.id, name, added: true });
  }
  return normalized;
}

const KNOWN_NOTE_FIELDS = new Set([
  'id', 'syncId', 'revision', 'ownerUserId', 'noteTitle', 'noteBody', 'pinned', 'bgColor', 'bgImage',
  'checkBoxes', 'images', 'attachments', 'isCbox', 'labels', 'binder', 'locked', 'lockSalt', 'lockHash',
  'completedChecklistCollapsed', 'archived', 'trashed', 'trashedAt', 'sortOrder', 'createdAt', 'updatedAt',
  'lwwPhysicalMs', 'lwwLogical', 'lwwDeviceId', 'lwwOperationId', 'collaborators', 'ownerDisplayName',
  'ownerUsername', 'ownerAvatarDataUrl', 'ownerAvatarPreset', 'lastEditorUserId', 'lastEditorDisplayName',
  'isDemo', 'extraFields'
]);

function noteExtraFields(payload) {
  return Object.fromEntries(Object.entries(payload || {}).filter(([key]) => !KNOWN_NOTE_FIELDS.has(key)));
}

function canonicalizeNotePayload(payload) {
  const locked = !!payload.locked && !!payload.lockSalt && !!payload.lockHash;
  return {
    ...payload,
    extraFields: noteExtraFields(payload),
    ...(payload.noteTitle !== undefined ? { noteTitle: neutralizeActiveHtml(payload.noteTitle) } : {}),
    ...(payload.checkBoxes !== undefined ? { checkBoxes: neutralizeChecklist(payload.checkBoxes) } : {}),
    noteBody: canonicalizeNoteHtmlImages(neutralizeActiveHtml(payload.noteBody || '')),
    images: canonicalizeNoteImages(payload.images || []),
    labels: appliedNoteLabels(payload.labels || []),
    binder: String(payload.binder || '').trim().slice(0, 80),
    locked,
    lockSalt: locked ? String(payload.lockSalt || '').slice(0, 256) : '',
    lockHash: locked ? String(payload.lockHash || '').slice(0, 512) : ''
  };
}

function dbNoteToApi(row) {
  const pinned = row.userPinned !== undefined ? row.userPinned : row.pinned;
  return {
    ...parseJson(row.extraFields || '{}', {}),
    id: row.id,
    syncId: row.syncId,
    revision: Number(row.revision || 1),
    ownerUserId: row.ownerUserId,
    noteTitle: row.noteTitle,
    noteBody: row.noteBody || '',
    pinned: Boolean(pinned),
    bgColor: row.bgColor || '',
    bgImage: row.bgImage || '',
    checkBoxes: parseJson(row.checkBoxes, []),
    images: parseJson(row.images || '[]', []),
    isCbox: Boolean(row.isCbox),
    labels: appliedNoteLabels(parseJson(row.labels, [])),
    binder: row.binder || '',
    locked: Boolean(row.locked),
    lockSalt: row.lockSalt || '',
    lockHash: row.lockHash || '',
    completedChecklistCollapsed: Boolean(row.completedChecklistCollapsed),
    archived: Boolean(row.archived),
    trashed: Boolean(row.trashed),
    trashedAt: row.trashedAt || '',
    sortOrder: Number(row.effectiveSortOrder || row.sortOrder || row.id || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lwwPhysicalMs: Number(row.lwwPhysicalMs || 0),
    lwwLogical: Number(row.lwwLogical || 0),
    lwwDeviceId: row.lwwDeviceId || 'server',
    lwwOperationId: row.lwwOperationId || '',
    collaborators: parseJson(row.collaborators || '[]', []),
    ownerDisplayName: row.ownerDisplayName || undefined,
    ownerUsername: row.ownerUsername || undefined,
    ownerAvatarDataUrl: row.ownerAvatarDataUrl || undefined,
    ownerAvatarPreset: row.ownerAvatarPreset || undefined,
    lastEditorUserId: row.lastEditorUserId || undefined,
    lastEditorDisplayName: row.lastEditorDisplayName || undefined,
    isDemo: Boolean(row.isDemo)
  };
}

function cardNoteBody(row, previewText) {
  const body = row.noteBody || '';
  if (/<img\b/i.test(body)) return body;
  if (row.isCbox && !plainText(body).trim()) return '';
  if (body.length <= 12000) return body;
  return escapeHtml(previewText);
}

function cardSearchText(row) {
  if (row.locked) return [row.noteTitle || '', row.labels || '', row.binder || ''].join(' ');
  return [
    row.noteTitle || '',
    row.noteBody || '',
    row.checkBoxes || '',
    row.labels || '',
    row.binder || '',
    row.attachmentNames || ''
  ].join(' ');
}

function dbNoteToCard(row, options = {}) {
  const includeSearchText = !!options.includeSearchText;
  const locked = Boolean(row.locked);
  const pinned = row.userPinned !== undefined ? row.userPinned : row.pinned;
  const labels = appliedNoteLabels(parseJson(row.labels || '[]', []));
  const checkBoxes = parseJson(row.checkBoxes || '[]', []);
  const parsedImages = parseJson(row.images || '[]', []);
  const images = Array.isArray(parsedImages) ? parsedImages.filter(Boolean) : [];
  const previewText = locked ? '' : notePreviewText(row);
  return {
    id: row.id,
    syncId: row.syncId,
    ownerUserId: row.ownerUserId,
    noteTitle: row.noteTitle,
    noteBody: locked ? '' : cardNoteBody(row, previewText),
    searchText: includeSearchText ? cardSearchText(row) : undefined,
    previewText,
    linkCount: locked ? 0 : noteLinkCount(row),
    pinned: Boolean(pinned),
    bgColor: row.bgColor || '',
    bgImage: row.bgImage || '',
    checkBoxes: locked ? [] : (Array.isArray(checkBoxes) ? checkBoxes.slice(0, 8) : []),
    images: locked ? [] : images,
    hasMoreImages: false,
    isCbox: Boolean(row.isCbox),
    labels,
    binder: row.binder || '',
    locked,
    lockSalt: row.lockSalt || '',
    lockHash: row.lockHash || '',
    completedChecklistCollapsed: Boolean(row.completedChecklistCollapsed),
    archived: Boolean(row.archived),
    trashed: Boolean(row.trashed),
    trashedAt: row.trashedAt || '',
    sortOrder: Number(row.effectiveSortOrder || row.sortOrder || row.id || 0),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lwwPhysicalMs: Number(row.lwwPhysicalMs || 0),
    lwwLogical: Number(row.lwwLogical || 0),
    lwwDeviceId: row.lwwDeviceId || 'server',
    lwwOperationId: row.lwwOperationId || '',
    attachments: [],
    hasAttachments: Number(row.attachmentCount || 0) > 0,
    attachmentCount: Number(row.attachmentCount || 0),
    collaborators: parseJson(row.collaborators || '[]', []),
    ownerDisplayName: row.ownerDisplayName || undefined,
    ownerUsername: row.ownerUsername || undefined,
    ownerAvatarDataUrl: row.ownerAvatarDataUrl || undefined,
    ownerAvatarPreset: row.ownerAvatarPreset || undefined,
    lastEditorUserId: row.lastEditorUserId || undefined,
    lastEditorDisplayName: row.lastEditorDisplayName || undefined,
    isDemo: Boolean(row.isDemo),
    isCardPreview: true
  };
}

function noteSummaryFromRow(row) {
  const locked = Boolean(row.locked);
  const checkBoxes = parseJson(row.checkBoxes || '[]', []);
  const labels = appliedNoteLabels(parseJson(row.labels || '[]', []));
  const collaboratorIds = row.collaboratorIds
    ? String(row.collaboratorIds).split(',').map(Number).filter(Boolean)
    : [];
  const hasChecklist = Array.isArray(checkBoxes) && checkBoxes.length > 0;
  const hasDrawing = String(row.images || '').includes('"id":"drawing"') || String(row.images || '').includes('"id": "drawing"');
  return {
    id: row.id,
    title: row.noteTitle || '',
    bodyPreview: locked ? '' : notePreviewText(row),
    type: hasDrawing ? 'drawing' : (row.isCbox || hasChecklist ? 'todo' : 'text'),
    labels,
    binder: row.binder || '',
    locked: Boolean(row.locked),
    lockSalt: row.lockSalt || '',
    lockHash: row.lockHash || '',
    checklistPreview: !locked && hasChecklist ? checkBoxes.slice(0, 6).map(item => ({
      id: item.id,
      data: plainText(item.data || ''),
      done: !!item.done
    })) : [],
    updatedAt: row.updatedAt,
    ownerUserId: row.ownerUserId,
    collaboratorUserIds: collaboratorIds
  };
}

async function accessibleNoteSummaryRows(userId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 20, 1), 50);
  const query = String(options.query || '').trim();
  const noteId = Number(options.noteId || 0);
  const searchTokens = searchGroupsFromQuery(query);
  const searchWhere = noteSearchWhere(searchTokens, { protectLockedContent: !!options.protectLockedContent });
  const whereClauses = [];
  const params = [userId, userId, userId, userId];

  if (noteId) {
    whereClauses.push('id = ?');
    params.push(noteId);
  }
  if (searchWhere.clause) {
    whereClauses.push(searchWhere.clause);
    params.push(...searchWhere.params);
  }
  const extraWhere = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

  return await all(
    `WITH accessible_notes AS (
      SELECT notes.*,
             COALESCE(pos.sortOrder, notes.sortOrder, notes.id) AS effectiveSortOrder,
             CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
             (SELECT GROUP_CONCAT(nc.userId) FROM note_collaborators nc WHERE nc.noteId = notes.id) AS collaboratorIds,
             (SELECT GROUP_CONCAT(na.originalName, ' ') FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentNames
      FROM notes
      LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
      LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
      LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
      WHERE notes.ownerUserId = ? OR access.userId IS NOT NULL
    )
    SELECT * FROM accessible_notes
    ${extraWhere}
    ORDER BY updatedAt DESC, id DESC
    LIMIT ?`,
    [...params, limit]
  );
}

async function accessibleNoteSummaries(userId, options = {}) {
  const rows = await accessibleNoteSummaryRows(userId, options);
  return rows.map(noteSummaryFromRow);
}

function encodeNotesCursor(row) {
  if (!row) return null;
  const pinned = row.userPinned !== undefined ? row.userPinned : row.pinned;
  return Buffer.from(JSON.stringify({
    pinned: Number(pinned || 0),
    sortOrder: Number(row.effectiveSortOrder || row.sortOrder || row.id || 0),
    id: Number(row.id)
  })).toString('base64url');
}

function decodeNotesCursor(cursor) {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const pinned = Number(parsed.pinned || 0);
    const sortOrder = Number(parsed.sortOrder);
    const id = Number(parsed.id);
    if (!Number.isFinite(pinned) || !Number.isFinite(sortOrder) || !Number.isFinite(id)) return null;
    return { pinned, sortOrder, id };
  } catch {
    return null;
  }
}

function nextTrashedAt(previous, next) {
  if (!next.trashed) return null;
  return previous?.trashed ? (previous.trashedAt || new Date().toISOString()) : new Date().toISOString();
}

async function getAccessibleNote(noteId, userId) {
  return await get(
    `SELECT notes.*,
     COALESCE(pos.sortOrder, notes.sortOrder, notes.id) AS effectiveSortOrder,
     CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
     COALESCE(view_state.completedChecklistCollapsed, 0) AS completedChecklistCollapsed,
     lastEditor.displayName AS lastEditorDisplayName FROM notes
     LEFT JOIN note_collaborators ON note_collaborators.noteId = notes.id AND note_collaborators.userId = ?
     LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
     LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
     LEFT JOIN user_note_view_states view_state ON view_state.noteId = notes.id AND view_state.userId = ?
     LEFT JOIN users lastEditor ON lastEditor.id = notes.lastEditorUserId
     WHERE notes.id = ? AND (notes.ownerUserId = ? OR note_collaborators.userId IS NOT NULL)`,
    [userId, userId, userId, userId, noteId, userId]
  );
}

async function getOwnedNote(noteId, userId) {
  return await get('SELECT * FROM notes WHERE id = ? AND ownerUserId = ?', [noteId, userId]);
}

async function getCollaboratorsForNote(noteId) {
  const rows = await all(
    `SELECT users.id, users.username, users.displayName, users.avatarDataUrl, users.avatarPreset
     FROM note_collaborators
     JOIN users ON users.id = note_collaborators.userId
     WHERE note_collaborators.noteId = ?
     ORDER BY users.displayName, users.username`,
    [noteId]
  );
  return rows.map(u => ({
    ...publicCollaborator(u),
    online: realtimeClients.has(u.id)
  }));
}

async function hydrateNoteUserFields(rows, requesterUserId) {
  const userIds = new Set();
  for (const row of rows || []) {
    if (row.ownerUserId) userIds.add(row.ownerUserId);
    if (row.collaboratorIds) {
      for (const id of String(row.collaboratorIds).split(',')) {
        const n = Number(id);
        if (n) userIds.add(n);
      }
    }
  }
  if (!userIds.size) return rows || [];

  const ids = Array.from(userIds);
  const placeholders = ids.map(() => '?').join(',');
  const userRows = await all(
    `SELECT id, username, displayName, avatarDataUrl, avatarPreset FROM users WHERE id IN (${placeholders})`,
    ids
  );
  const userMap = new Map(userRows.map(user => [user.id, user]));
  const me = Number(requesterUserId);

  for (const row of rows || []) {
    const owner = userMap.get(row.ownerUserId);
    if (owner) {
      row.ownerDisplayName = owner.displayName;
      row.ownerUsername = owner.username;
      row.ownerAvatarPreset = owner.avatarPreset || 'cat';
      row.ownerAvatarDataUrl = owner.id === me ? '' : (owner.avatarDataUrl || '');
    }

    const collabIds = row.collaboratorIds
      ? String(row.collaboratorIds).split(',').map(Number).filter(Boolean)
      : [];
    row.collaborators = JSON.stringify(collabIds.map(id => {
      const user = userMap.get(id);
      if (!user) return null;
      return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        avatarDataUrl: user.id === me ? '' : (user.avatarDataUrl || ''),
        avatarPreset: user.avatarPreset || 'cat',
        online: realtimeClients.has(user.id)
      };
    }).filter(Boolean));
  }

  return rows || [];
}

async function getNoteRecipientIds(noteId) {
  const rows = await all(
    `SELECT ownerUserId AS userId FROM notes WHERE id = ?
     UNION
     SELECT userId FROM note_collaborators WHERE noteId = ?`,
    [noteId, noteId]
  );
  return rows.map(row => row.userId).filter(Boolean);
}

// Attachments of every note the user can access, selected through the access rule itself. An id list of all the user's
// notes would exceed SQLite's bound-variable limit for large accounts and make bootstrap/export fail.
function accessibleAttachmentRows(userId) {
  return all(
    `SELECT id, syncId, noteId, originalName, fileSize, mimeType, uploadedAt,
            lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId
     FROM note_attachments
     WHERE noteId IN (SELECT id FROM notes WHERE ownerUserId = ? UNION SELECT noteId FROM note_collaborators WHERE userId = ?)
     ORDER BY uploadedAt DESC`,
    [userId, userId]
  );
}

module.exports = {
  accessibleAttachmentRows, accessibleNoteSummaries, accessibleNoteSummaryRows, canonicalizeNotePayload, dbNoteToApi, dbNoteToCard, decodeNotesCursor, encodeNotesCursor, getAccessibleNote, getCollaboratorsForNote, getNoteRecipientIds, getOwnedNote, hydrateNoteUserFields, nextTrashedAt, noteExtraFields, noteSummaryFromRow
};
