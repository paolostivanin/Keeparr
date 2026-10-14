const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const express = require('express');
const multer = require('multer');
const webPush = require('web-push');
const { occurrenceId } = require('./native-client');
const { nextRepeatDueAt, isRepeatOccurrence } = require('./reminder-recurrence');
const {
  trustProxySetting, port, dataDir, uploadDir, attachmentDir, dbPath, vapidPath, staticDir, KEEPARR_VERSION, vapidKeys
} = require('./config');
const {
  run, get, all, withDatabaseTransaction, withDatabaseExclusive, afterDatabaseCommit, openDatabase, closeDatabase, databaseIdle
} = require('./db');
const { getAppSetting, setAppSetting } = require('./app-settings');
const {
  randomHex, mcpTokenHash, verifyTotpToken, asyncRoute, registerLimiter, setupLimiter, oauthRegistrationLimiter,
  resolveSessionFromToken, requireAuth, requireAuthOrMediaTicket, requireAdmin,
  resetAuthStateAfterRestore
} = require('./auth');
const { mountAuthRoutes } = require('./routes/auth');
const { updateCheckCache, getCachedLatestRelease, refreshLatestReleaseInBackground } = require('./update-check');
const { mountLinkPreviewRoutes } = require('./link-preview');
const { mountTakeoutImportRoutes, cleanupStaleTakeoutUploads } = require('./takeout-import');
const { backupDirectory, startBackupScheduler, mountBackupRoutes } = require('./backup');
const { startHousekeeping } = require('./housekeeping');
const {
  realtimeClients, closeRealtimeClientsForUser, broadcastRealtime, setupRealtime,
  terminateRealtimeClients
} = require('./realtime');
const { initSchema } = require('./schema');
const { armTestFault, hitTestFault } = require('./test-faults');
const { mountOAuthAndMcpRoutes } = require('./oauth-mcp');
const { mountStaticAssets } = require('./static-assets');
const { mountClientCapabilities } = require('./client-capabilities');
const { mountSyncMutationRoute } = require('./sync-routes');
const { orderedAccessibleIds, parseOrderPositions } = require('./note-order');
const { plainText, parseJson, escapeHtml, notePreviewText, noteLinkCount } = require('./note-text');
const { searchTextFromQuery, searchTokensFromQuery, searchGroupsFromQuery, searchOperatorsFromQuery, noteOperatorWhere, noteSearchWhere } = require('./note-search');
const { compareVersion } = require('./version-compare');
const { neutralizeActiveHtml, neutralizeChecklist } = require('./html-safety');
const {
  firstDefined, normalizeLocationTrigger, normalizeRepeatRule, normalizeReminderDueAt, reminderScheduleDefinition,
  reminderScheduleDefinitionChanged, reminderScheduleChanged, parseRepeatRule, normalizeReminderPayload, reminderResponse
} = require('./reminder-model');
const { isPrivateOrLocalAddress, resolvePublicIp, integrationRequestOptions } = require('./public-network');
const {
  serverLwwStamp, normalizeLwwStamp, rowLwwStamp, compareLwwStamp, clampClientSortOrder, parseChangesQuery
} = require('./sync-protocol');

const app = express();
app.set('trust proxy', /^\d+$/.test(trustProxySetting) ? Number(trustProxySetting)
  : trustProxySetting === 'true' ? true : trustProxySetting === 'false' ? false : trustProxySetting);
app.disable('etag');
app.use(compression());
const server = http.createServer(app);
const backupArchive = require('./backup-archive');

const SAFE_IMAGE_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp']
]);

// Attachment MIME types and extensions - restricted to prevent execution/interpretation
const SAFE_ATTACHMENT_TYPES = new Map([
  // Documents
  ['application/pdf', '.pdf'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['application/msword', '.doc'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  // Text formats
  ['text/plain', '.txt'],
  ['text/csv', '.csv'],
  ['text/markdown', '.md'],
  ['application/json', '.json'],
  ['application/xml', '.xml'],
  // Archives
  ['application/zip', '.zip'],
  ['application/x-zip-compressed', '.zip'],
  ['multipart/x-zip', '.zip'],
  ['application/x-rar-compressed', '.rar'],
  ['application/vnd.rar', '.rar'],
  ['application/x-7z-compressed', '.7z'],
  ['application/gzip', '.gz'],
  ['application/x-gzip', '.gz'],
  ['application/x-tar', '.tar'],
  // Additional common formats
  ['application/vnd.oasis.opendocument.text', '.odt'],
  ['application/vnd.oasis.opendocument.spreadsheet', '.ods'],
  ['application/vnd.oasis.opendocument.presentation', '.odp']
]);

const SAFE_ATTACHMENT_EXTENSIONS = new Set(Array.from(SAFE_ATTACHMENT_TYPES.values()));


const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = SAFE_IMAGE_TYPES.get(String(file.mimetype || '').toLowerCase());
      if (!ext) return cb(new Error('Only PNG, JPG, GIF, and WEBP uploads are supported.'));
      cb(null, `${Date.now()}-${randomHex(12)}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!SAFE_IMAGE_TYPES.has(String(file.mimetype || '').toLowerCase())) {
      return cb(new Error('Only PNG, JPG, GIF, and WEBP uploads are supported.'));
    }
    cb(null, true);
  }
});

const uploadAttachment = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, attachmentDir),
    filename: (_req, file, cb) => {
      const ext = safeAttachmentExtension(file);
      if (!ext) return cb(new Error('This file type is not allowed. Supported formats: PDF, Office documents, text files, and archives.'));
      // Generate randomized filename to prevent direct file access guessing
      cb(null, `att-${Date.now()}-${randomHex(16)}${ext}`);
    }
  }),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
  fileFilter: (_req, file, cb) => {
    if (!safeAttachmentExtension(file)) {
      return cb(new Error('This file type is not allowed. Supported formats: PDF, Office documents, text files, and archives.'));
    }
    cb(null, true);
  }
});









let perfRequestSeq = 0;
function createPerfTrace(name, details = {}) {
  const id = ++perfRequestSeq;
  const start = process.hrtime.bigint();
  let last = start;
  const elapsed = (from = start) => Number(process.hrtime.bigint() - from) / 1e6;
  const detailText = Object.keys(details).length ? ` ${JSON.stringify(details)}` : '';
  console.log(`[KeeparrPerf:server] ${name}#${id} start${detailText}`);
  return {
    id,
    mark(label, extra = {}) {
      const now = process.hrtime.bigint();
      const delta = Number(now - last) / 1e6;
      last = now;
      const extraText = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
      console.log(`[KeeparrPerf:server] ${name}#${id} ${label} +${delta.toFixed(1)}ms total=${elapsed().toFixed(1)}ms${extraText}`);
    },
    end(extra = {}) {
      const extraText = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
      console.log(`[KeeparrPerf:server] ${name}#${id} end total=${elapsed().toFixed(1)}ms${extraText}`);
    }
  };
}

function sendJsonWithPerf(res, trace, payload) {
  const serializeStart = process.hrtime.bigint();
  const body = JSON.stringify(payload);
  const serializeMs = Number(process.hrtime.bigint() - serializeStart) / 1e6;
  trace.mark('serialize', { ms: Number(serializeMs.toFixed(1)), bytes: Buffer.byteLength(body) });
  res.type('application/json').send(body);
  trace.end({ bytes: Buffer.byteLength(body) });
}



// Runs at startup and after a backup restore.
const init = () => initSchema({ hashToken: mcpTokenHash, backfillImportedNoteLabels });

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    theme: user.theme || 'light',
    avatarDataUrl: user.avatarDataUrl || '',
    avatarPreset: user.avatarPreset || 'cat',
    showPastReminders: !!user.showPastReminders,
    totpEnabled: !!user.totpEnabled,
    hasBackupCodes: !!user.totpBackupCodes,
    email: user.email || '',
    enabled: user.enabled !== undefined ? !!user.enabled : true,
    createdAt: user.createdAt,
    demoNotesCreatedAt: user.demoNotesCreatedAt || null
  };
}

function publicCollaborator(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarDataUrl: user.avatarDataUrl || '',
    avatarPreset: user.avatarPreset || 'cat',
    shareCount: user.shareCount || 0
  };
}


function safeAttachmentExtension(file) {
  const mimeType = String(file?.mimetype || '').toLowerCase();
  const expectedExt = SAFE_ATTACHMENT_TYPES.get(mimeType);
  if (!expectedExt) return '';

  const originalExt = path.extname(String(file?.originalname || '')).toLowerCase();
  if (!originalExt || !SAFE_ATTACHMENT_EXTENSIONS.has(originalExt)) return '';
  if (mimeType !== 'text/plain' && originalExt !== expectedExt) return '';
  return originalExt;
}

function safeDownloadName(name) {
  const base = path.basename(String(name || 'attachment'));
  return base.replace(/[\r\n"]/g, '_') || 'attachment';
}

function attachmentPath(storedFilename) {
  const filename = path.basename(String(storedFilename || ''));
  const primary = path.join(attachmentDir, filename);
  if (fs.existsSync(primary)) return primary;
  return path.join(uploadDir, filename);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function deleteAttachmentFilesForNote(noteId) {
  const attachments = await all('SELECT syncId, storedFilename FROM note_attachments WHERE noteId = ?', [noteId]);
  for (const attachment of attachments) {
    if (attachment.syncId) await run(`UPDATE native_upload_receipts SET state = 'deleted', updatedAt = ?
      WHERE resourceType = 'attachment' AND resourceSyncId = ? AND state = 'active'`, [new Date().toISOString(), attachment.syncId]);
  }
  afterDatabaseCommit(() => {
    for (const attachment of attachments) {
      const filePath = attachmentPath(attachment.storedFilename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch {}
      }
    }
  });
}

function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push(randomHex(4).toUpperCase());
  return codes;
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}

function randomAvatarPreset() {
  const presets = ['cat', 'fox', 'bunny', 'bear', 'panda', 'guinea-pig', 'capybara'];
  return presets[Math.floor(Math.random() * presets.length)];
}

const SESSION_TTL_DAYS = Number(process.env.KEEPARR_SESSION_TTL_DAYS || 30);
async function createSession(user) {
  const token = randomHex(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await run(
    'INSERT INTO sessions (token, userId, createdAt, expiresAt, hashed) VALUES (?, ?, ?, ?, 1)',
    [mcpTokenHash(token), user.id, now.toISOString(), expiresAt]
  );
  return { token, user: publicUser(user) };
}

function validateEmail(email) {
  if (!email) return true; // optional for admin-created users
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).trim());
}


async function isOriginalAdminUser(userId) {
  const originalAdminUserId = Number(await getAppSetting('originalAdminUserId', '0'));
  return Number(userId) === originalAdminUserId;
}

async function deleteOwnedFilesForUser(userId) {
  const ownedNotes = await all('SELECT id FROM notes WHERE ownerUserId = ?', [userId]);
  for (const note of ownedNotes) {
    await deleteAttachmentFilesForNote(note.id);
    await deleteImageFilesForNote(note.id);
  }

  const unlinkedImages = await all('SELECT storedFilename FROM note_images WHERE ownerUserId = ? AND noteId IS NULL', [userId]);
  await run('DELETE FROM note_images WHERE ownerUserId = ? AND noteId IS NULL', [userId]);
  for (const row of unlinkedImages) {
    const filename = safeStoredImageFilename(row.storedFilename);
    if (!filename) continue;
    const stillUsed = await get('SELECT id FROM note_images WHERE storedFilename = ? LIMIT 1', [filename]);
    if (stillUsed) continue;
    await run(`UPDATE native_upload_receipts SET state = 'deleted', updatedAt = ?
      WHERE userId = ? AND resourceType = 'image' AND resourceSyncId = ? AND state = 'active'`, [new Date().toISOString(), userId, filename]);
    afterDatabaseCommit(() => { try { fs.unlinkSync(path.join(uploadDir, filename)); } catch {} });
  }
}

async function deleteUserAndOwnedData(userId) {
  await deleteOwnedFilesForUser(userId);
  await run('DELETE FROM users WHERE id = ?', [userId]);
}

async function createUser({ username, displayName, password, role, email, enabled, totpSecret, totpBackupCodes }) {
  const cleanUsername = normalizeUsername(username);
  const cleanDisplayName = String(displayName || '').trim() || cleanUsername;
  const cleanPassword = String(password || '');
  const cleanEmail = email ? String(email).trim() : null;

  if (cleanUsername.length < 3) {
    const error = new Error('Username must be at least 3 characters.');
    error.status = 400;
    throw error;
  }
  if (cleanPassword.length < 8) {
    const error = new Error('Password must be at least 8 characters.');
    error.status = 400;
    throw error;
  }
  if (cleanEmail && !validateEmail(cleanEmail)) {
    const error = new Error('Please enter a valid email address.');
    error.status = 400;
    throw error;
  }

  const passwordSalt = randomHex(16);
  const passwordHash = hashPassword(cleanPassword, passwordSalt);
  const createdAt = new Date().toISOString();
  const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

  const hasTotp = !!totpSecret;
  const result = await run(
    `INSERT INTO users (username, displayName, role, passwordHash, passwordSalt, theme, avatarPreset, email, enabled, totpSecret, totpEnabled, totpBackupCodes, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cleanUsername, cleanDisplayName, role, passwordHash, passwordSalt, 'light', randomAvatarPreset(), cleanEmail, isEnabled, totpSecret || null, hasTotp ? 1 : 0, totpBackupCodes || null, createdAt]
  );
  return await get('SELECT * FROM users WHERE id = ?', [result.id]);
}


const PRIVATE_IMAGE_PREFIX = '/api/uploads/images/';

function safeStoredImageFilename(filename) {
  const clean = String(filename || '').trim();
  if (!/^[0-9]+-[a-f0-9]{24}\.(png|jpe?g|gif|webp)$/i.test(clean)) return '';
  return clean;
}

function localImageFilenameFromUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('data:')) return '';
  let pathname = raw;
  try {
    pathname = new URL(raw, 'http://keeparr.local').pathname;
  } catch {}
  const match = pathname.match(/^(?:\/uploads\/|\/api\/uploads\/images\/)([^/?#]+)$/);
  if (!match) return '';
  try {
    return safeStoredImageFilename(decodeURIComponent(match[1]));
  } catch {
    return safeStoredImageFilename(match[1]);
  }
}

function canonicalImageUrl(value) {
  const filename = localImageFilenameFromUrl(value);
  return filename ? `${PRIVATE_IMAGE_PREFIX}${filename}` : value;
}

function canonicalizeNoteHtmlImages(html) {
  return String(html || '').replace(/(\bsrc=["'])([^"']+)(["'])/gi, (_match, before, src, after) => {
    return `${before}${canonicalImageUrl(src)}${after}`;
  });
}

function canonicalizeNoteImages(images) {
  return (Array.isArray(images) ? images : []).map(image => {
    if (!image || typeof image !== 'object') return image;
    return { ...image, dataUrl: canonicalImageUrl(image.dataUrl) };
  });
}

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

function imageMimeType(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function extractNoteImageFilenames(note) {
  const filenames = new Set();
  const body = String(note?.noteBody || '');
  for (const match of body.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
    const filename = localImageFilenameFromUrl(match[1]);
    if (filename) filenames.add(filename);
  }
  for (const image of Array.isArray(note?.images) ? note.images : []) {
    const filename = localImageFilenameFromUrl(image?.dataUrl);
    if (filename) filenames.add(filename);
  }
  return [...filenames];
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





async function appendSyncChange(userIds, resourceType, resourceSyncId, operation, payload, stamp) {
  const changedAt = new Date().toISOString();
  for (const userId of [...new Set((userIds || []).map(Number).filter(Boolean))]) {
    await run(
      `INSERT INTO sync_changes
       (userId, resourceType, resourceSyncId, operation, payload, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, changedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        resourceType,
        resourceSyncId,
        operation,
        payload == null ? null : JSON.stringify(payload),
        stamp.physicalMs,
        stamp.logical,
        stamp.deviceId,
        stamp.operationId,
        changedAt
      ]
    );
  }
}

async function noteSyncSnapshot(noteId, userId) {
  const row = await getAccessibleNote(noteId, userId);
  if (!row) return null;
  row.collaboratorIds = (await all('SELECT userId FROM note_collaborators WHERE noteId = ?', [noteId]))
    .map(item => item.userId)
    .filter(Boolean)
    .join(',');
  await hydrateNoteUserFields([row], userId);
  const note = dbNoteToApi(row);
  const attachments = await all(
    `SELECT id, syncId, originalName, fileSize, mimeType, uploadedAt,
            lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId
     FROM note_attachments WHERE noteId = ? ORDER BY uploadedAt DESC`,
    [noteId]
  );
  note.attachments = attachments;
  return note;
}

async function recordNoteSyncChange(noteId, operation, recipientIds, deletedSnapshot) {
  const recipients = recipientIds || await getNoteRecipientIds(noteId);
  if (operation === 'upsert') {
    for (const userId of recipients) {
      const payload = await noteSyncSnapshot(noteId, userId);
      if (!payload?.syncId) continue;
      await appendSyncChange([userId], 'note', payload.syncId, operation, payload, rowLwwStamp(payload));
    }
    return;
  }
  const payload = deletedSnapshot || null;
  const syncId = deletedSnapshot?.syncId;
  const stamp = deletedSnapshot ? rowLwwStamp(deletedSnapshot) : null;
  if (!syncId || !stamp) return;
  await appendSyncChange(recipients, 'note', syncId, operation, payload, stamp);
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

const SMART_ACTION_TYPES = new Set([
  'create_text_note',
  'create_todo_note',
  'append_to_note',
  'add_checklist_items',
  'add_labels',
  'set_reminder',
  'share_note',
  'archive_note',
  'trash_note'
]);

const NOTE_TARGET_ACTION_TYPES = new Set([
  'append_to_note',
  'add_checklist_items',
  'add_labels',
  'share_note',
  'archive_note',
  'trash_note'
]);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function actionNoteId(action) {
  return Number(action.noteId || action.targetNoteId || action.targetId || 0);
}

function resolveActionNoteId(action, state) {
  return action.noteId || state.lastCreatedNoteId || null;
}

function actionText(action) {
  return String(action.text ?? action.body ?? action.content ?? action.noteBody ?? '').trim();
}

function actionTitle(action) {
  return String(action.title ?? action.noteTitle ?? '').trim();
}

function actionChecklistItems(action) {
  return asArray(action.items ?? action.checklistItems ?? action.todos).map(item => {
    if (typeof item === 'string') return item.trim();
    return String(item?.data ?? item?.text ?? item?.title ?? '').trim();
  }).filter(Boolean);
}

function actionLabelNames(action) {
  return asArray(action.labels ?? action.labelNames ?? action.names).map(label => {
    if (typeof label === 'string') return label.trim();
    return String(label?.name ?? '').trim();
  }).filter(Boolean);
}

function actionUserIds(action) {
  return asArray(action.userIds ?? action.users ?? action.collaboratorUserIds ?? action.shareWithUserIds)
    .map(user => Number(typeof user === 'object' ? user?.id : user))
    .filter(Boolean);
}

function normalizeAction(action) {
  let type = String(action?.type || '').trim();
  if (['archive', 'archiveNote'].includes(type)) type = 'archive_note';
  if (['trash', 'trashNote'].includes(type)) type = 'trash_note';
  const normalized = { ...action, type };
  if (actionNoteId(action)) normalized.noteId = actionNoteId(action);
  const title = actionTitle(action);
  if (title) normalized.title = title;
  const text = actionText(action);
  if (text) normalized.text = text;
  const checklistItems = actionChecklistItems(action);
  if (checklistItems.length) normalized.items = checklistItems;
  const labelNames = actionLabelNames(action);
  if (labelNames.length) normalized.labels = labelNames;
  const userIds = actionUserIds(action);
  if (userIds.length) normalized.userIds = userIds;
  if (action.dueAtUtc || action.dueAt || action.datetime || action.dateTime) {
    normalized.dueAtUtc = String(action.dueAtUtc || action.dueAt || action.datetime || action.dateTime);
  }
  const location = action.location && typeof action.location === 'object' ? action.location : {};
  const locationName = firstDefined(action.locationName, action.location_name, action.triggerLocationName, location.displayName, location.name, location.address);
  const latitude = firstDefined(action.latitude, action.lat, location.latitude, location.lat);
  const longitude = firstDefined(action.longitude, action.lng, action.lon, location.longitude, location.lng, location.lon);
  const radiusMeters = firstDefined(action.radiusMeters, action.radius_meters, action.radius, location.radiusMeters, location.radius_meters, location.radius);
  const locationTrigger = firstDefined(action.locationTrigger, action.location_trigger, action.triggerType, location.locationTrigger, location.triggerType);
  if (locationName) normalized.locationName = String(locationName);
  if (latitude != null) normalized.latitude = Number(latitude);
  if (longitude != null) normalized.longitude = Number(longitude);
  if (radiusMeters != null) normalized.radiusMeters = Number(radiusMeters);
  if (locationTrigger) normalized.locationTrigger = normalizeLocationTrigger(locationTrigger);
  if (action.timezone) normalized.timezone = String(action.timezone);
  if (action.repeatRule) normalized.repeatRule = String(action.repeatRule);
  if (action.createMissingLabels !== undefined) normalized.createMissingLabels = !!action.createMissingLabels;
  return normalized;
}

function isLocationReminderAction(action) {
  return action?.latitude != null
    && action?.longitude != null
    && action?.locationName
    && action?.locationTrigger;
}

function reminderNoteTextFromTranscript(transcript) {
  return String(transcript || '')
    .replace(/\b(can you|please|could you)\b/gi, ' ')
    .replace(/\b(remind me|reminder|set a reminder|create a reminder)\b/gi, ' ')
    .replace(/\b(today|tomorrow|tonight|this evening|this morning|this afternoon)\b/gi, ' ')
    .replace(/\b(at|by|around)\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*to\s+/i, '')
    .trim();
}

function fallbackReminderNoteText(action, transcript) {
  return action.text || action.title || reminderNoteTextFromTranscript(transcript) || String(transcript || '').trim() || 'Reminder';
}

function normalizeActionPlan(actionPlan, transcript = '') {
  const input = actionPlan && typeof actionPlan === 'object' ? actionPlan : {};
  const rawActions = Array.isArray(input.actions) ? input.actions.map(normalizeAction) : [];
  const actions = [];
  let createdNoteAvailable = false;
  for (const action of rawActions) {
    if (action.type === 'set_reminder' && !action.noteId && !createdNoteAvailable) {
      const noteText = fallbackReminderNoteText(action, transcript);
      actions.push({
        type: 'create_text_note',
        title: action.title || noteText,
        text: action.text || noteText
      });
      createdNoteAvailable = true;
    }
    actions.push(action);
    if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
      createdNoteAvailable = true;
    }
  }
  const confidence = ['low', 'medium', 'high'].includes(input.confidence) ? input.confidence : 'medium';
  return {
    summary: String(input.summary || '').trim(),
    confidence,
    requiresConfirmation: !!input.requiresConfirmation,
    actions,
    unresolvedQuestions: asArray(input.unresolvedQuestions).map(String).filter(Boolean)
  };
}

function actionRequiresCreatedNote(action) {
  return !action.noteId && (
    NOTE_TARGET_ACTION_TYPES.has(action.type) ||
    action.type === 'set_reminder'
  );
}

function selectedActionsWithDependencies(actions, selected) {
  if (!selected) return actions;
  const expanded = new Set(selected);
  let latestCreateIndex = null;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (expanded.has(index) && actionRequiresCreatedNote(action) && latestCreateIndex !== null) {
      expanded.add(latestCreateIndex);
    }
    if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
      latestCreateIndex = index;
    }
  }
  return actions.filter((_action, index) => expanded.has(index));
}

async function findOrCreateLabelForUser(userId, rawName) {
  const name = String(rawName || '').trim();
  if (!name) {
    const error = new Error('Label name is required.');
    error.status = 400;
    throw error;
  }
  const existing = await get('SELECT id, name FROM labels WHERE userId = ? AND lower(name) = lower(?)', [userId, name]);
  if (existing) return { ...existing, created: false };
  const result = await run('INSERT INTO labels (name, userId) VALUES (?, ?)', [name, userId]);
  return { id: result.id, name, created: true };
}

async function normalizeLabelsForUser(userId, rawLabels) {
  const normalized = [];
  const seen = new Set();
  let changed = false;

  for (const rawLabel of rawLabels || []) {
    const rawName = String(rawLabel?.name || '').trim();
    if (!rawName) {
      changed = true;
      continue;
    }

    const key = rawName.toLowerCase();
    if (seen.has(key)) {
      changed = true;
      continue;
    }
    seen.add(key);

    const label = await findOrCreateLabelForUser(userId, rawName);
    const added = rawLabel?.added !== false;
    const nextLabel = { id: label.id, name: label.name, added };
    normalized.push(nextLabel);

    if (rawLabel?.id !== nextLabel.id || rawLabel?.name !== nextLabel.name || rawLabel?.added !== nextLabel.added) {
      changed = true;
    }
  }

  return { labels: normalized, changed };
}

async function backfillImportedNoteLabels() {
  const rows = await all(
    `SELECT id, ownerUserId, labels
     FROM notes
     WHERE ownerUserId IS NOT NULL
       AND labels IS NOT NULL
       AND labels <> ''
       AND labels <> '[]'`
  );

  for (const row of rows) {
    const rawLabels = parseJson(row.labels || '[]', []);
    if (!Array.isArray(rawLabels) || !rawLabels.length) continue;

    const { labels, changed } = await normalizeLabelsForUser(row.ownerUserId, rawLabels);
    if (!changed) continue;

    const lww = serverLwwStamp();
    await run(
      `UPDATE notes
       SET labels = ?, lastEditorUserId = COALESCE(lastEditorUserId, ownerUserId),
           lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?, lwwOperationId = ?
       WHERE id = ?`,
      [JSON.stringify(labels), lww.physicalMs, lww.logical, lww.deviceId, lww.operationId, row.id]
    );
    await recordNoteSyncChange(row.id, 'upsert', [row.ownerUserId]);
  }
}

async function findLabelForUser(userId, rawName) {
  const name = String(rawName || '').trim();
  if (!name) return null;
  return await get('SELECT id, name FROM labels WHERE userId = ? AND lower(name) = lower(?)', [userId, name]);
}

async function validateKeeparrActionPlan(userId, transcript, actionPlan) {
  const normalizedPlan = normalizeActionPlan(actionPlan, transcript);
  const errors = [];
  const warnings = [];
  const noteCache = new Map();
  let risky = normalizedPlan.requiresConfirmation || normalizedPlan.confidence === 'low' || normalizedPlan.actions.length > 1;

  if (!String(transcript || '').trim()) warnings.push('Transcript is empty.');
  if (!normalizedPlan.summary) warnings.push('Plan summary is empty.');
  if (!Array.isArray(actionPlan?.actions)) errors.push('actions must be an array.');
  if (!normalizedPlan.actions.length) errors.push('At least one action is required.');

  let createdNoteAvailable = false;
  for (let index = 0; index < normalizedPlan.actions.length; index += 1) {
    const action = normalizedPlan.actions[index];
    const label = `actions[${index}]`;
    if (!SMART_ACTION_TYPES.has(action.type)) {
      errors.push(`${label}.type is not supported.`);
      continue;
    }

    if (NOTE_TARGET_ACTION_TYPES.has(action.type) && !action.noteId && !createdNoteAvailable) {
      errors.push(`${label}.noteId is required unless a previous action creates a note.`);
    }
    if (action.type === 'set_reminder' && !action.noteId && !createdNoteAvailable) {
      errors.push(`${label}.noteId is required unless a previous action creates a note.`);
    }
    if (['append_to_note'].includes(action.type) && !action.text) errors.push(`${label}.text is required.`);
    if (action.type === 'create_text_note' && !action.title && !action.text) errors.push(`${label}.title or text is required.`);
    if (action.type === 'create_todo_note' && !action.items?.length) errors.push(`${label}.items are required.`);
    if (action.type === 'add_checklist_items' && !action.items?.length) errors.push(`${label}.items are required.`);
    if (action.type === 'add_labels' && !action.labels?.length) errors.push(`${label}.labels are required.`);
    if (action.type === 'set_reminder' && !action.dueAtUtc && !isLocationReminderAction(action)) {
      risky = true;
      warnings.push(`${label}.dueAtUtc is missing; ask for a reminder time before executing.`);
      if (!normalizedPlan.unresolvedQuestions.includes('When should Keeparr remind you?')) {
        normalizedPlan.unresolvedQuestions.push('When should Keeparr remind you?');
      }
    }
    if (action.type === 'share_note') {
      risky = true;
      if (!action.userIds?.length) errors.push(`${label}.userIds are required.`);
    }

    if (action.noteId && !noteCache.has(action.noteId)) {
      noteCache.set(action.noteId, await getAccessibleNote(action.noteId, userId));
    }
    let note = action.noteId ? noteCache.get(action.noteId) : null;
    if (action.type === 'share_note' && action.noteId && createdNoteAvailable && (!note || note.ownerUserId !== userId)) {
      warnings.push(`${label}.noteId was ignored because a previous action creates the note to share.`);
      delete action.noteId;
      note = null;
    }
    if (action.noteId && !note) errors.push(`${label}.noteId is not accessible.`);
    if (action.type === 'share_note' && note && note.ownerUserId !== userId) {
      errors.push(`${label}.noteId must be owned by you to share it.`);
    }
    if ((action.type === 'archive_note' || action.type === 'trash_note') && note && note.ownerUserId !== userId) {
      errors.push(`${label}.noteId must be owned by you to ${action.type === 'archive_note' ? 'archive' : 'trash'} it.`);
    }

    if (action.type === 'share_note') {
      for (const userIdTarget of action.userIds || []) {
        const user = await get('SELECT id FROM users WHERE id = ? AND enabled = 1', [userIdTarget]);
        if (!user) errors.push(`${label}.userIds contains an unknown user: ${userIdTarget}.`);
        if (userIdTarget === userId) warnings.push(`${label}.userIds includes the current user; it will be ignored.`);
      }
    }

    if (action.type === 'add_labels' && !action.createMissingLabels) {
      for (const labelName of action.labels || []) {
        const existingLabel = await findLabelForUser(userId, labelName);
        if (!existingLabel) errors.push(`${label}.labels contains an unknown label: ${labelName}.`);
      }
    }

    if (action.type === 'set_reminder' && action.dueAtUtc) {
      const due = new Date(action.dueAtUtc);
      if (Number.isNaN(due.getTime())) errors.push(`${label}.dueAtUtc must be a valid date.`);
      else action.dueAtUtc = due.toISOString();
    }
    if (action.type === 'set_reminder' && isLocationReminderAction(action)) {
      if (!Number.isFinite(Number(action.latitude))) errors.push(`${label}.latitude must be a valid number.`);
      if (!Number.isFinite(Number(action.longitude))) errors.push(`${label}.longitude must be a valid number.`);
      action.latitude = Number(action.latitude);
      action.longitude = Number(action.longitude);
      action.locationTrigger = action.locationTrigger === 'leave' ? 'leave' : 'arrive';
      if (action.radiusMeters != null) action.radiusMeters = Number(action.radiusMeters);
      if (action.radiusMeters != null && (!Number.isFinite(action.radiusMeters) || action.radiusMeters <= 0)) {
        errors.push(`${label}.radiusMeters must be a positive number.`);
      }
    }

    if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
      createdNoteAvailable = true;
    }
  }

  normalizedPlan.requiresConfirmation = risky;
  return {
    valid: errors.length === 0,
    ok: errors.length === 0,
    errors,
    warnings,
    normalizedPlan,
    requiresConfirmation: normalizedPlan.requiresConfirmation
  };
}

async function insertAiActionHistory(userId, transcript, proposedPlan, executedPlan, status) {
  await run(
    `INSERT INTO ai_action_history (userId, transcript, proposedPlanJson, executedPlanJson, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      String(transcript || ''),
      JSON.stringify(proposedPlan || null),
      executedPlan ? JSON.stringify(executedPlan) : null,
      status,
      new Date().toISOString()
    ]
  );
}

async function smartCreateNote(userId, action, options = {}) {
  const now = new Date().toISOString();
  const isTodo = action.type === 'create_todo_note';
  const labels = [];
  for (const name of action.labels || []) {
    const label = await findOrCreateLabelForUser(userId, name);
    labels.push({ id: label.id, name: label.name, added: true });
    if (label.created) options.createdLabelIds?.add(label.id);
  }
  const checkBoxes = isTodo
    ? (action.items || []).map((item, index) => ({ id: Date.now() + index, data: escapeHtml(item), done: false }))
    : [];
  const result = await run(
    `INSERT INTO notes
	     (ownerUserId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, binder, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, lastEditorUserId, isDemo)
	     VALUES (?, ?, ?, ?, '', ?, '[]', ?, ?, '', 0, 0, NULL, ?, ?, ?, ?, 0)`,
	    [
	      userId,
          escapeHtml(action.title || ''),
          escapeHtml(action.text || ''),
	      String(action.bgColor || ''),
	      JSON.stringify(checkBoxes),
      isTodo ? 1 : 0,
      JSON.stringify(labels),
      Date.now(),
      now,
      now,
      userId
    ]
  );
  return result.id;
}

async function smartAppendToNote(userId, noteId, text) {
  const note = await getAccessibleNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  const separator = note.noteBody && String(note.noteBody).trim() ? '<br>' : '';
  const nextBody = `${note.noteBody || ''}${separator}${escapeHtml(text)}`;
  await run('UPDATE notes SET noteBody = ?, updatedAt = ?, lastEditorUserId = ? WHERE id = ?', [
    nextBody,
    new Date().toISOString(),
    userId,
    noteId
  ]);
  await syncNoteImagesForNote(noteId, note.ownerUserId, { noteBody: nextBody, images: parseJson(note.images || '[]', []) });
}

async function smartAddChecklistItems(userId, noteId, items) {
  const note = await getAccessibleNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  const current = parseJson(note.checkBoxes || '[]', []);
  const base = Date.now();
  const next = [
    ...current,
    ...items.map((item, index) => ({ id: base + index, data: escapeHtml(item), done: false }))
  ];
  await run('UPDATE notes SET checkBoxes = ?, isCbox = 1, updatedAt = ?, lastEditorUserId = ? WHERE id = ?', [
    JSON.stringify(next),
    new Date().toISOString(),
    userId,
    noteId
  ]);
}

async function smartAddLabels(userId, noteId, labelNames, createdLabelIds, createMissingLabels = false) {
  const note = await getAccessibleNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  if (note.ownerUserId !== userId) throw new Error(`Only the note owner can change labels for note ${noteId}.`);
  const labels = parseJson(note.labels || '[]', []);
  const byName = new Map(labels.map(label => [String(label.name || '').toLowerCase(), label]));
  for (const name of labelNames) {
    const label = createMissingLabels
      ? await findOrCreateLabelForUser(userId, name)
      : await findLabelForUser(userId, name);
    if (!label) throw new Error(`Label does not exist: ${name}`);
    if (createMissingLabels && label.created) createdLabelIds.add(label.id);
    const key = label.name.toLowerCase();
    if (!byName.has(key)) {
      const entry = { id: label.id, name: label.name, added: true };
      labels.push(entry);
      byName.set(key, entry);
    }
  }
  await run('UPDATE notes SET labels = ?, updatedAt = ?, lastEditorUserId = ? WHERE id = ?', [
    JSON.stringify(labels),
    new Date().toISOString(),
    userId,
    noteId
  ]);
}

async function smartSetReminder(userId, action, fallbackNoteId) {
  const noteId = action.noteId || fallbackNoteId || null;
  if (noteId) {
    const note = await getAccessibleNote(Number(noteId), userId);
    if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  }
  const now = new Date().toISOString();
  const dueAtUtc = action.dueAtUtc ? new Date(action.dueAtUtc).toISOString() : null;
  const locationName = action.locationName ? String(action.locationName) : null;
  const latitude = action.latitude != null ? Number(action.latitude) : null;
  const longitude = action.longitude != null ? Number(action.longitude) : null;
  const radiusMeters = action.radiusMeters != null ? Number(action.radiusMeters) : (locationName ? 120 : null);
  const locationTrigger = action.locationTrigger === 'leave' ? 'leave' : 'arrive';
  const existing = noteId ? await get('SELECT * FROM reminders WHERE noteId = ? AND userId = ?', [noteId, userId]) : null;
  const timezone = action.timezone || 'UTC';
  const repeatRule = normalizeRepeatRule(action.repeatRule);
  const nextSchedule = { dueAtUtc, timezone, repeatRule };
  const scheduleChanged = existing ? reminderScheduleDefinitionChanged(existing, nextSchedule) : false;
  const scheduleVersion = existing ? Number(existing.scheduleVersion || 1) + (scheduleChanged ? 1 : 0) : 1;
  const scheduleAnchorAtUtc = scheduleChanged ? dueAtUtc : (existing?.scheduleAnchorAtUtc || existing?.dueAtUtc || dueAtUtc);
  const reminder = await get(
    `INSERT INTO reminders
       (noteId, userId, dueAtUtc, timezone, repeatRule, status, title, body, imageUrl, locationName, latitude, longitude, radiusMeters, locationTrigger, scheduleVersion, scheduleAnchorAtUtc, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(userId, noteId) DO UPDATE SET
       userId = excluded.userId,
       dueAtUtc = excluded.dueAtUtc,
       timezone = excluded.timezone,
       repeatRule = excluded.repeatRule,
       status = 'pending',
       title = excluded.title,
       body = excluded.body,
       imageUrl = excluded.imageUrl,
       locationName = excluded.locationName,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       radiusMeters = excluded.radiusMeters,
       locationTrigger = excluded.locationTrigger,
       scheduleAnchorAtUtc = CASE
         WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
         THEN excluded.scheduleAnchorAtUtc ELSE COALESCE(reminders.scheduleAnchorAtUtc, reminders.dueAtUtc) END,
       scheduleVersion = reminders.scheduleVersion + CASE
         WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
         THEN 1 ELSE 0 END,
       updatedAt = excluded.updatedAt
     RETURNING *`,
    [
      noteId || null,
      userId,
      dueAtUtc,
      timezone,
      repeatRule,
      plainText(action.title) || null,
      plainText(action.text) || null,
      String(action.imageUrl || '') || null,
      locationName,
      latitude,
      longitude,
      radiusMeters,
      locationTrigger,
      scheduleVersion,
      scheduleAnchorAtUtc,
      now,
      now
    ]
  );
  return reminder || await get('SELECT * FROM reminders WHERE id = ?', [existing?.id]);
}

async function smartShareNote(userId, noteId, userIds) {
  const note = await getOwnedNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not owned by you.`);
  const previousRecipients = await getNoteRecipientIds(noteId);
  for (const targetUserId of new Set(userIds.filter(id => id !== userId))) {
    const exists = await get('SELECT id FROM users WHERE id = ? AND enabled = 1', [targetUserId]);
    if (!exists) throw new Error(`User ${targetUserId} does not exist.`);
    await run(
      'INSERT OR IGNORE INTO note_collaborators (noteId, userId, createdAt) VALUES (?, ?, ?)',
      [noteId, targetUserId, new Date().toISOString()]
    );
  }
  return previousRecipients;
}

async function setOwnedNoteLifecycleState(userId, noteId, updates) {
  const note = await getOwnedNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not owned by you.`);
  const now = new Date().toISOString();
  const next = {
    archived: updates.archived === undefined ? !!note.archived : !!updates.archived,
    trashed: updates.trashed === undefined ? !!note.trashed : !!updates.trashed
  };
  const trashedAt = nextTrashedAt(note, next);
  await run(
    'UPDATE notes SET archived = ?, trashed = ?, trashedAt = ?, updatedAt = ?, lastEditorUserId = ? WHERE id = ?',
    [next.archived ? 1 : 0, next.trashed ? 1 : 0, trashedAt, now, userId, noteId]
  );
  return {
    noteId,
    archived: next.archived,
    trashed: next.trashed,
    trashedAt: trashedAt || '',
    updatedAt: now
  };
}

async function executeSmartAction(userId, action, state) {
  const result = { type: action.type, ok: true };
  if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
    const noteId = await smartCreateNote(userId, action, state);
    state.createdNoteIds.push(noteId);
    state.lastCreatedNoteId = noteId;
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'append_to_note') {
    const noteId = resolveActionNoteId(action, state);
    await smartAppendToNote(userId, noteId, action.text);
    state.updatedNoteIds.add(noteId);
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'add_checklist_items') {
    const noteId = resolveActionNoteId(action, state);
    await smartAddChecklistItems(userId, noteId, action.items || []);
    state.updatedNoteIds.add(noteId);
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'add_labels') {
    const noteId = resolveActionNoteId(action, state);
    await smartAddLabels(userId, noteId, action.labels || [], state.createdLabelIds, !!action.createMissingLabels);
    state.updatedNoteIds.add(noteId);
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'set_reminder') {
    const reminder = await smartSetReminder(userId, action, state.lastCreatedNoteId);
    state.reminderIds.push(reminder.id);
    state.remindersToSync.push(reminder);
    if (reminder.noteId) state.updatedNoteIds.add(reminder.noteId);
    result.reminderId = reminder.id;
    result.noteId = reminder.noteId || null;
    return result;
  }
  if (action.type === 'share_note') {
    const noteId = resolveActionNoteId(action, state);
    const previousRecipients = await smartShareNote(userId, noteId, action.userIds || []);
    state.updatedNoteIds.add(noteId);
    state.shareBroadcasts.push({ noteId, previousRecipients });
    result.noteId = noteId;
    result.userIds = (action.userIds || []).filter(id => id !== userId);
    return result;
  }
  if (action.type === 'archive_note') {
    const noteId = resolveActionNoteId(action, state);
    const status = await setOwnedNoteLifecycleState(userId, noteId, { archived: true, trashed: false });
    state.updatedNoteIds.add(noteId);
    return { ...result, ...status };
  }
  if (action.type === 'trash_note') {
    const noteId = resolveActionNoteId(action, state);
    const status = await setOwnedNoteLifecycleState(userId, noteId, { archived: false, trashed: true });
    state.updatedNoteIds.add(noteId);
    return { ...result, ...status };
  }
  throw new Error(`Unsupported action type: ${action.type}`);
}

async function syncSmartReminderIntegrations(userId, reminders) {
  if (!reminders.length) return;
  const enrichedReminders = await enrichReminderResponses(reminders);
  const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [userId]);
  for (const reminder of enrichedReminders) {
    if (caldav) pushReminderToCaldav(caldav, reminder).catch(err => console.error('CalDAV push failed:', err.message));
    gcalPushReminder(userId, reminder).catch(err => console.error('GCal push failed:', err.message));
  }
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

async function cleanupUnusedLabels(userId, candidateIds = []) {
  if (!Array.isArray(candidateIds) || !candidateIds.length) return;
  try {
    const notes = await all('SELECT labels FROM notes WHERE ownerUserId = ?', [userId]);
    const usedLabelNames = new Set();
    notes.forEach(note => {
      const labels = parseJson(note.labels, []);
      labels.forEach(l => {
        if (l.name) usedLabelNames.add(l.name);
      });
    });

    const allLabels = await all(
      `SELECT id, name FROM labels
       WHERE userId = ? AND id IN (${candidateIds.map(() => '?').join(',')})`,
      [userId, ...candidateIds]
    );
    for (const label of allLabels) {
      if (!usedLabelNames.has(label.name)) {
        await run('DELETE FROM labels WHERE id = ?', [label.id]);
      }
    }
  } catch (error) {
    console.error('Failed to cleanup labels:', error);
  }
}

async function updateNoteLabelReferencesForUser(userId, labelId, labelValue, options = {}) {
  const oldName = String(options.oldName || '').trim().toLowerCase();
  const rows = await all('SELECT id, labels FROM notes WHERE ownerUserId = ?', [userId]);
  const recipientIds = new Set([userId]);
  const changedNoteIds = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    let changed = false;
    let labels = parseJson(row.labels, []);
    if (!Array.isArray(labels)) labels = [];

    if (labelValue === '') {
      const nextLabels = labels.filter(label => {
        const sameId = Number(label?.id) === Number(labelId);
        const sameOldName = oldName && String(label?.name || '').trim().toLowerCase() === oldName;
        return !(sameId || sameOldName);
      });
      changed = nextLabels.length !== labels.length;
      labels = nextLabels;
    } else {
      labels = labels.map(label => {
        const sameId = Number(label?.id) === Number(labelId);
        const sameOldName = oldName && String(label?.name || '').trim().toLowerCase() === oldName;
        if (!sameId && !sameOldName) return label;
        changed = true;
        return { ...label, id: labelId, name: labelValue };
      });
    }

    if (!changed) continue;
    await run('UPDATE notes SET labels = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(labels), now, row.id]);
    changedNoteIds.push(row.id);
    const noteRecipients = await getNoteRecipientIds(row.id);
    noteRecipients.forEach(noteUserId => recipientIds.add(noteUserId));
    await recordNoteSyncChange(row.id, 'upsert', [...noteRecipients]);
  }

  return { recipientIds, changedNoteIds };
}

function noteToParams(note) {
  return [
    String(note.noteTitle || ''),
    String(note.noteBody || ''),
    note.pinned ? 1 : 0,
    String(note.bgColor || ''),
    String(note.bgImage || ''),
    JSON.stringify(note.checkBoxes || []),
    JSON.stringify(note.images || []),
    note.isCbox ? 1 : 0,
    JSON.stringify(note.labels || []),
    note.archived ? 1 : 0,
    note.trashed ? 1 : 0
  ];
}

function nextTrashedAt(previous, next) {
  if (!next.trashed) return null;
  return previous?.trashed ? (previous.trashedAt || new Date().toISOString()) : new Date().toISOString();
}

function trashExpirationCutoff() {
  return new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
}

async function purgeExpiredTrashedNotes() {
  const expired = await all('SELECT * FROM notes WHERE trashed = 1 AND trashedAt IS NOT NULL AND trashedAt <= ?', [trashExpirationCutoff()]);
  for (const note of expired) {
    const recipients = await getNoteRecipientIds(note.id);
    const stamp = serverLwwStamp();
    await recordDependentSyncDeletesForNote(note.id, recipients);
    await deleteAttachmentFilesForNote(note.id);
    await deleteImageFilesForNote(note.id);
    await run('DELETE FROM notes WHERE id = ?', [note.id]);
    await broadcastNoteChange(note.id, 'deleted', recipients, {
      deletedSnapshot: {
        syncId: note.syncId || `note-${crypto.randomUUID()}`,
        lwwPhysicalMs: stamp.physicalMs,
        lwwLogical: stamp.logical,
        lwwDeviceId: stamp.deviceId,
        lwwOperationId: stamp.operationId
      }
    });
  }
}

let trashPurgeRunning = false;
let lastTrashPurgeAt = 0;
function scheduleTrashPurgeIfStale() {
  const now = Date.now();
  if (trashPurgeRunning || now - lastTrashPurgeAt < 60 * 60 * 1000) return;
  trashPurgeRunning = true;
  lastTrashPurgeAt = now;
  setTimeout(() => {
    purgeExpiredTrashedNotes()
      .catch(error => console.error('[Trash purge] failed:', error))
      .finally(() => { trashPurgeRunning = false; });
  }, 10000).unref?.();
}

async function syncNoteImagesForNote(noteId, ownerUserId, note) {
  if (!noteId || !ownerUserId) return;
  const filenames = extractNoteImageFilenames(note);
  const wanted = new Set(filenames);
  const linked = await all('SELECT * FROM note_images WHERE noteId = ?', [noteId]);
  const linkedByFilename = new Map(linked.map(row => [row.storedFilename, row]));
  for (const row of linked) {
    if (wanted.has(row.storedFilename)) continue;
    await run('DELETE FROM note_images WHERE id = ?', [row.id]);
    const stillUsed = await get('SELECT id FROM note_images WHERE storedFilename = ? LIMIT 1', [row.storedFilename]);
    if (stillUsed) continue;
    await run(`UPDATE native_upload_receipts SET state = 'deleted', updatedAt = ?
      WHERE resourceType = 'image' AND resourceSyncId = ? AND state = 'active'`, [new Date().toISOString(), row.storedFilename]);
    const filename = safeStoredImageFilename(row.storedFilename);
    if (filename) afterDatabaseCommit(() => { try { fs.unlinkSync(path.join(uploadDir, filename)); } catch {} });
  }
  for (const filename of filenames) {
    const filePath = path.join(uploadDir, filename);
    let stats = null;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }
    const existingLinked = linkedByFilename.get(filename);
    if (existingLinked) {
      await run('UPDATE note_images SET fileSize = ?, mimeType = ? WHERE id = ?', [stats.size, imageMimeType(filename), existingLinked.id]);
      continue;
    }
    const existingUnlinked = await get(
      'SELECT id FROM note_images WHERE storedFilename = ? AND noteId IS NULL AND ownerUserId = ? ORDER BY id LIMIT 1',
      [filename, ownerUserId]
    );
    if (existingUnlinked) {
      await run(
        'UPDATE note_images SET noteId = ?, fileSize = ?, mimeType = ? WHERE id = ?',
        [noteId, stats.size, imageMimeType(filename), existingUnlinked.id]
      );
    } else {
      const receipt = await get(`SELECT operationId FROM native_upload_receipts
        WHERE userId = ? AND resourceType = 'image' AND resourceSyncId = ? AND state = 'active'`, [ownerUserId, filename]);
      await run(
        `INSERT OR IGNORE INTO note_images
         (noteId, ownerUserId, storedFilename, originalName, fileSize, mimeType, uploadedAt, uploadOperationId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [noteId, ownerUserId, filename, filename, stats.size, imageMimeType(filename), new Date().toISOString(), receipt?.operationId || null]
      );
    }
  }
}

async function deleteImageFilesForNote(noteId) {
  const rows = await all('SELECT storedFilename, ownerUserId FROM note_images WHERE noteId = ?', [noteId]);
  await run('DELETE FROM note_images WHERE noteId = ?', [noteId]);
  for (const row of rows) {
    const filename = safeStoredImageFilename(row.storedFilename);
    if (!filename) continue;
    const stillUsed = await get('SELECT id FROM note_images WHERE storedFilename = ? LIMIT 1', [filename]);
    if (stillUsed) continue;
    await run(`UPDATE native_upload_receipts SET state = 'deleted', updatedAt = ?
      WHERE userId = ? AND resourceType = 'image' AND resourceSyncId = ? AND state = 'active'`, [new Date().toISOString(), row.ownerUserId, filename]);
    afterDatabaseCommit(() => { try { fs.unlinkSync(path.join(uploadDir, filename)); } catch {} });
  }
}

async function backfillExistingNoteImages() {
  const rows = await all('SELECT id, ownerUserId, noteBody, images FROM notes WHERE ownerUserId IS NOT NULL');
  for (const row of rows) {
    const note = {
      noteBody: canonicalizeNoteHtmlImages(row.noteBody || ''),
      images: canonicalizeNoteImages(parseJson(row.images || '[]', []))
    };
    await syncNoteImagesForNote(row.id, row.ownerUserId, note);
    if (note.noteBody !== (row.noteBody || '') || JSON.stringify(note.images) !== (row.images || '[]')) {
      await run('UPDATE notes SET noteBody = ?, images = ? WHERE id = ?', [note.noteBody, JSON.stringify(note.images), row.id]);
    }
  }
}

async function runStartupMaintenance() {
  const imageBackfillCompleted = await getAppSetting('noteImagesBackfillCompleted', '');
  if (!imageBackfillCompleted) {
    await backfillExistingNoteImages();
    await setAppSetting('noteImagesBackfillCompleted', new Date().toISOString());
  }

  const now = new Date().toISOString();
  await run(
    `UPDATE notes
     SET trashedAt = COALESCE(updatedAt, createdAt, ?)
     WHERE trashed = 1 AND trashedAt IS NULL`,
    [now]
  );
  // Only rows that need it: any UPDATE fires the revision trigger, and a no-op bump makes every client's next save conflict.
  await run('UPDATE notes SET trashedAt = NULL WHERE trashed = 0 AND trashedAt IS NOT NULL');
  await purgeExpiredTrashedNotes();
}

function scheduleStartupMaintenance() {
  setTimeout(() => {
    runStartupMaintenance()
      .catch(error => console.error('[Startup maintenance] failed:', error));
  }, 5000).unref?.();
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

// Signs a user out of everything that could still act for them: sessions (optionally keeping one), the local MCP token and
// every OAuth grant with its tokens (unless `sessionsOnly`). Open sockets of the revoked sessions are closed.
async function revokeUserCredentials(userId, { exceptSessionHash = '', reason = 'Signed out.', sessionsOnly = false } = {}) {
  await withDatabaseTransaction(async () => {
    await run('DELETE FROM sessions WHERE userId = ? AND token != ?', [userId, exceptSessionHash]);
    if (sessionsOnly) return;
    await run(`DELETE FROM external_unlock_challenges WHERE userId = ? AND principalType IN ('mcp', 'oauth')`, [userId]);
    await run('DELETE FROM mcp_tokens WHERE userId = ?', [userId]);
    await run('DELETE FROM oauth_grants WHERE userId = ?', [userId]);
  });
  closeRealtimeClientsForUser(userId, reason, exceptSessionHash);
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

async function moveNoteToTopForUsers(noteId, userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter(Boolean))];
  if (!noteId || !ids.length) return;
  const base = Date.now();
  for (let index = 0; index < ids.length; index += 1) {
    await run(
      'INSERT OR REPLACE INTO user_note_positions (userId, noteId, sortOrder) VALUES (?, ?, ?)',
      [ids[index], noteId, base + ids.length - index]
    );
  }
}

// Stores the order a user chose. Clients that moved only part of the list send `positions` (the new stored position of each
// note that moved, computed with the same planner they apply locally), so only those notes are written and published. Older
// clients send just the whole ordered list; every listed note then gets a new position, as it always did. Returns how many
// notes were written.
async function applyNoteOrder(userId, { ids, syncIds, positions, by = syncIds ? 'syncId' : 'id' }) {
  const byKey = by;
  const requested = positions ? positions.map(position => position.key) : (syncIds || ids);
  const bounded = requested.length <= 500;
  const rows = await all(
    `SELECT notes.id, notes.syncId, COALESCE(pos.sortOrder, notes.sortOrder, notes.id) AS effectiveSortOrder
     FROM notes
     LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
     LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
     WHERE (notes.ownerUserId = ? OR access.userId IS NOT NULL)
       ${bounded ? `AND notes.${byKey} IN (${requested.map(() => '?').join(',')})` : ''}`,
    [userId, userId, userId, ...(bounded ? requested : [])]
  );
  const rowByKey = new Map(rows.map(row => [row[byKey], row]));
  let writes;
  if (positions) {
    writes = positions.filter(position => rowByKey.has(position.key) &&
      Number(rowByKey.get(position.key).effectiveSortOrder) !== position.sortOrder)
      .map(position => [rowByKey.get(position.key).id, position.sortOrder]);
  } else {
    const ordered = orderedAccessibleIds(requested, rowByKey).map(key => rowByKey.get(key).id);
    const base = Date.now();
    writes = ordered.map((id, index) => [id, base + (ordered.length - index)]);
  }
  for (const [noteId, sortOrder] of writes) {
    await run('INSERT OR REPLACE INTO user_note_positions (userId, noteId, sortOrder) VALUES (?, ?, ?)', [userId, noteId, sortOrder]);
    await recordNoteSyncChange(noteId, 'upsert', [userId]);
  }
  if (writes.length) broadcastRealtime([userId], { type: 'notes-changed', action: 'reordered' });
  return writes.length;
}

async function broadcastNoteChange(noteId, action, userIds, options = {}) {
  const recipients = userIds || await getNoteRecipientIds(noteId);
  if (action !== 'deleted' && !options.preserveStamp) {
    const stamp = serverLwwStamp();
    await run(
      `UPDATE notes
       SET syncId = CASE WHEN syncId IS NULL OR syncId = '' THEN ? ELSE syncId END,
           lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?, lwwOperationId = ?
       WHERE id = ?`,
      [`note-${crypto.randomUUID()}`, stamp.physicalMs, stamp.logical, stamp.deviceId, stamp.operationId, noteId]
    );
  }
  await recordNoteSyncChange(
    noteId,
    action === 'deleted' ? 'delete' : 'upsert',
    recipients,
    options.deletedSnapshot
  );
  const payload = { type: 'notes-changed', action, noteId };
  if (options.syncId) payload.syncId = options.syncId;
  afterDatabaseCommit(() => {
    broadcastRealtime(recipients, payload);
    if (action === 'created' || action === 'deleted' || action === 'collaborators-updated') {
      setTimeout(() => broadcastRealtime(recipients, { ...payload, followup: true }), 1200);
    }
  });
}

async function broadcastProfileUpdate(user) {
  const rows = await all(
    `SELECT ? AS userId
     UNION
     SELECT nc.userId
     FROM notes n
     JOIN note_collaborators nc ON nc.noteId = n.id
     WHERE n.ownerUserId = ?
     UNION
     SELECT n.ownerUserId
     FROM notes n
     JOIN note_collaborators nc ON nc.noteId = n.id
     WHERE nc.userId = ?
     UNION
     SELECT nc2.userId
     FROM note_collaborators nc
     JOIN note_collaborators nc2 ON nc2.noteId = nc.noteId
     WHERE nc.userId = ?`,
    [user.id, user.id, user.id, user.id]
  );
  broadcastRealtime(rows.map(row => row.userId), {
    type: 'profile-updated',
    user: publicCollaborator(user)
  });
}

// ─── CalDAV helpers ────────────────────────────────────────────────────────

function toIcalDate(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function buildVCalendar(reminder) {
  const esc = s => String(s || '').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
  const dtend = toIcalDate(new Date(new Date(reminder.dueAtUtc).getTime() + 30 * 60000).toISOString());
  const body = (reminder.body || '').trim();
  const attribution = '— Created by Keeparr ✨';
  const description = body ? `${body}\n\n\n${attribution}` : attribution;
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Keeparr//Keeparr//EN',
    'BEGIN:VEVENT',
    `UID:keeparr-reminder-${reminder.id}@keeparr`,
    `DTSTAMP:${toIcalDate(new Date().toISOString())}`,
    `DTSTART:${toIcalDate(reminder.dueAtUtc)}`,
    `DTEND:${dtend}`,
    `SUMMARY:${esc(reminder.title || 'Keeparr Reminder')}`,
    `DESCRIPTION:${esc(description)}`,
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
}

async function caldavRequest(settings, reminderId, method, body) {
  const https = require('https');
  const http = require('http');
  let base = settings.calendarUrl;
  if (!base.endsWith('/')) base += '/';
  const url = new URL(`${base}keeparr-reminder-${reminderId}.ics`);
  const proto = url.protocol === 'https:' ? https : http;
  const auth = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
  const bodyBuf = body ? Buffer.from(body, 'utf8') : null;
  // Resolved once and pinned, so a link-local address cannot be reached by rebinding the name after the check.
  const { lookup } = await integrationRequestOptions(url.href);
  return new Promise((resolve, reject) => {
    const req = proto.request({
      lookup,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        ...(bodyBuf ? { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Length': bodyBuf.length } : {})
      }
    }, res => {
      res.resume();
      if (res.statusCode < 500) resolve(res.statusCode);
      else reject(new Error(`CalDAV ${method} failed: HTTP ${res.statusCode}`));
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Connection timed out.')); });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function pushReminderToCaldav(settings, reminder) {
  await caldavRequest(settings, reminder.id, 'PUT', buildVCalendar(reminder));
}

async function deleteReminderFromCaldav(settings, reminderId) {
  await caldavRequest(settings, reminderId, 'DELETE', null);
}

function buildReminderPushPayload(reminder) {
  return JSON.stringify({
    type: 'reminder-fired',
    reminderId: reminder.id,
    noteId: reminder.noteId,
    title: plainText(reminder.title) || 'Reminder',
    body: plainText(reminder.body),
    imageUrl: reminder.imageUrl || null,
    icon: '/assets/images/keeparr-icon-192.png',
    deepLink: reminder.deepLink || (reminder.noteId ? `keeparr://note/${reminder.noteId}` : null),
    url: '/'
  });
}

async function sendReminderPush(reminder) {
  const subscriptions = await all(
    'SELECT id, subscription FROM push_subscriptions WHERE userId = ?',
    [reminder.userId]
  );
  const payload = buildReminderPushPayload(reminder);

  await Promise.all(subscriptions.map(async row => {
    try {
      await webPush.sendNotification(JSON.parse(row.subscription), payload);
    } catch (error) {
      const sub = JSON.parse(row.subscription);
      const endpoint = sub.endpoint || '';
      const isApple = endpoint.includes('web.push.apple.com');
      if (error.statusCode === 404 || error.statusCode === 410) {
        await run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
        console.warn(`Web Push: ${isApple ? '[Apple]' : ''} subscription gone (${error.statusCode}), removed.`);
      } else {
        console.error(
          `Web Push failed${isApple ? ' [Apple/iOS]' : ''}:`,
          'status=', error.statusCode,
          'body=', error.body,
          'msg=', error.message
        );
      }
    }
  }));
}

async function testCaldavConnection(settings) {
  const https = require('https');
  const http = require('http');
  const url = new URL(settings.calendarUrl);
  const proto = url.protocol === 'https:' ? https : http;
  const auth = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
  const { lookup } = await integrationRequestOptions(url.href);
  return new Promise((resolve, reject) => {
    const req = proto.request({
      lookup,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'PROPFIND',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/xml', 'Depth': '0' }
    }, res => {
      res.resume();
      if (res.statusCode < 500) resolve({ status: res.statusCode });
      else reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Connection timed out.')); });
    req.on('error', reject);
    req.end();
  });
}

// ─── ICS feed helpers ─────────────────────────────────────────────────────

function buildIcsFeed(reminders, calName = 'Keeparr Reminders') {
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const attribution = '— Created by Keeparr ✨';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Keeparr//Keeparr//EN',
    `X-WR-CALNAME:${esc(calName)}`,
    'X-WR-CALDESC:Reminders from Keeparr',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'
  ];
  for (const r of reminders) {
    const dtend = toIcalDate(new Date(new Date(r.dueAtUtc).getTime() + 30 * 60000).toISOString());
    const body = (r.body || '').trim();
    const description = body ? `${body}\n\n\n${attribution}` : attribution;
    lines.push('BEGIN:VEVENT',
      `UID:keeparr-reminder-${r.id}@keeparr`,
      `DTSTAMP:${toIcalDate(new Date().toISOString())}`,
      `DTSTART:${toIcalDate(r.dueAtUtc)}`,
      `DTEND:${dtend}`,
      `SUMMARY:${esc(r.title || 'Keeparr Reminder')}`,
      `DESCRIPTION:${esc(description)}`,
      r.status !== 'pending' ? 'STATUS:COMPLETED' : 'STATUS:CONFIRMED',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

async function getOrCreateIcsFeedToken(userId) {
  const user = await get('SELECT icsFeedToken FROM users WHERE id = ?', [userId]);
  if (user?.icsFeedToken) return user.icsFeedToken;
  const token = randomHex(20);
  await run('UPDATE users SET icsFeedToken = ? WHERE id = ?', [token, userId]);
  return token;
}

function parseIcsContent(icsContent) {
  const lines = icsContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT' && cur) { events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const key = line.slice(0, ci).replace(/;[^:]+/g, '').toUpperCase();
    const val = line.slice(ci + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    if (key === 'DTSTART') cur.dtstart = val;
    if (key === 'SUMMARY') cur.summary = val;
    if (key === 'DESCRIPTION') cur.description = val;
  }
  return events;
}

function parseIcalDate(dtstr) {
  const s = String(dtstr || '').replace(/[-:]/g, '');
  const isUtc = s.endsWith('Z');
  const clean = s.replace('T', '').replace('Z', '');
  const y = clean.slice(0, 4), mo = clean.slice(4, 6), da = clean.slice(6, 8);
  const hr = clean.slice(8, 10) || '00', mi = clean.slice(10, 12) || '00', sc = clean.slice(12, 14) || '00';
  return new Date(`${y}-${mo}-${da}T${hr}:${mi}:${sc}${isUtc ? 'Z' : 'Z'}`);
}

// ─── Google Calendar helpers ───────────────────────────────────────────────

const oauthStates = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of oauthStates) { if (v.createdAt < cutoff) oauthStates.delete(k); }
}, 5 * 60 * 1000);

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(String(body), 'utf8');
    const req = require('https').request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out.')); });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function httpsApiCall(method, path, accessToken, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const buf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;
    const headers = { 'Authorization': `Bearer ${accessToken}` };
    if (buf) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = buf.length; }
    const req = require('https').request(
      { hostname: 'www.googleapis.com', path, method, headers },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out.')); });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

async function exchangeGoogleCode(clientId, clientSecret, code, redirectUri) {
  const params = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const result = await httpsPost('oauth2.googleapis.com', '/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, params.toString());
  if (result.status !== 200) throw new Error(result.body?.error_description || 'Token exchange failed.');
  return result.body;
}

async function refreshGoogleAccessToken(clientId, clientSecret, refreshToken) {
  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const result = await httpsPost('oauth2.googleapis.com', '/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, params.toString());
  if (result.status !== 200) throw new Error('Token refresh failed.');
  return result.body;
}

async function getValidGoogleToken(userId) {
  const row = await get('SELECT * FROM google_calendar_tokens WHERE userId = ? AND enabled = 1 AND accessToken IS NOT NULL', [userId]);
  if (!row) return null;
  const expiry = row.tokenExpiry ? new Date(row.tokenExpiry) : null;
  if (!expiry || expiry <= new Date(Date.now() + 60000)) {
    if (!row.refreshToken) return null;
    try {
      const refreshed = await refreshGoogleAccessToken(row.clientId, row.clientSecret, row.refreshToken);
      const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
      await run('UPDATE google_calendar_tokens SET accessToken = ?, tokenExpiry = ?, updatedAt = ? WHERE userId = ?',
        [refreshed.access_token, newExpiry, new Date().toISOString(), userId]);
      return refreshed.access_token;
    } catch { return null; }
  }
  return row.accessToken;
}

function buildGCalEvent(reminder) {
  const end = new Date(new Date(reminder.dueAtUtc).getTime() + 30 * 60000).toISOString();
  const body = reminder.body || '';
  const attribution = '— Created by Keeparr ✨';
  const description = body ? `${body}\n\n${attribution}` : attribution;
  return {
    summary: reminder.title || 'Keeparr Reminder',
    description,
    start: { dateTime: reminder.dueAtUtc, timeZone: reminder.timezone || 'UTC' },
    end: { dateTime: end, timeZone: reminder.timezone || 'UTC' },
    colorId: '6',
    extendedProperties: { private: { keptReminderId: String(reminder.id) } }
  };
}

async function gcalCreateAndStore(userId, reminder, token) {
  const result = await httpsApiCall('POST', '/calendar/v3/calendars/primary/events', token, buildGCalEvent(reminder));
  if ((result.status === 200 || result.status === 201) && result.body?.id) {
    await run('UPDATE reminders SET gcalEventId = ? WHERE id = ?', [result.body.id, reminder.id]);
  }
}

async function gcalPushReminder(userId, reminder) {
  const token = await getValidGoogleToken(userId);
  if (!token) return;
  if (reminder.gcalEventId) {
    const result = await httpsApiCall('PUT', `/calendar/v3/calendars/primary/events/${encodeURIComponent(reminder.gcalEventId)}`, token, buildGCalEvent(reminder));
    if (result.status === 404) await gcalCreateAndStore(userId, reminder, token);
  } else {
    await gcalCreateAndStore(userId, reminder, token);
  }
}

async function gcalDeleteReminder(userId, reminder) {
  if (!reminder.gcalEventId) return;
  const token = await getValidGoogleToken(userId);
  if (!token) return;
  await httpsApiCall('DELETE', `/calendar/v3/calendars/primary/events/${encodeURIComponent(reminder.gcalEventId)}`, token, null);
}

// ─── Reminder scheduler ────────────────────────────────────────────────────

async function processDueReminders(nowDate = new Date()) {
    try {
      const now = nowDate.toISOString();
      const due = await all(
        `SELECT reminders.* FROM reminders
         ${visibleReminderJoin}
         WHERE reminders.status = 'pending'
         AND reminders.dueAtUtc <= ?
         AND ${visibleReminderWhere}`,
        [now]
      );
      const enrichedDue = await enrichReminderResponses(due);
      let processed = 0;
      for (const reminder of enrichedDue) {
        if (!(await reminderIsVisibleToUser(reminder, reminder.userId))) continue;
        const repeat = parseRepeatRule(reminder.repeatRule);
        const nextDueAtUtc = repeat ? nextRepeatDueAt(reminder.dueAtUtc, repeat, reminder.timezone, nowDate.getTime(), reminder.scheduleAnchorAtUtc || reminder.dueAtUtc) : null;
        const stamp = serverLwwStamp();
        const updatedReminder = await withDatabaseTransaction(async () => {
          const updated = await get(
            `UPDATE reminders SET
               status = ?, dueAtUtc = ?, updatedAt = ?,
               lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?, lwwOperationId = ?
             WHERE id = ? AND userId = ? AND status = 'pending' AND dueAtUtc = ? AND scheduleVersion = ?
             RETURNING *`,
            [repeat && nextDueAtUtc ? 'pending' : 'fired', repeat && nextDueAtUtc ? nextDueAtUtc : reminder.dueAtUtc,
              now, stamp.physicalMs, stamp.logical, stamp.deviceId, stamp.operationId, reminder.id, reminder.userId,
              reminder.dueAtUtc, Number(reminder.scheduleVersion || 1)]
          );
          if (!updated) return null;
          await persistReminderOccurrence(reminder);
          if (repeat?.moveToTopOnTrigger) await floatReminderNoteToTop(reminder.userId, reminder.noteId);
          await recordReminderSyncChange(updated, 'upsert');
          return updated;
        });
        if (!updatedReminder) continue;
        processed += 1;
        if (!(await reminderIsVisibleToUser(updatedReminder, reminder.userId))) continue;
        broadcastRealtime([reminder.userId], {
          type: 'reminder-fired',
          reminderId: reminder.id,
          noteId: reminder.noteId,
          title: reminder.title,
          body: reminder.body,
          imageUrl: reminder.imageUrl
        });
        sendReminderPush(reminder).catch(err => console.error('Reminder push failed:', err.message));
      }
      return { dueCount: processed };
    } catch (err) {
      console.error('Reminder scheduler error:', err.message);
      throw err;
    }
}

function startReminderScheduler() {
  setInterval(() => { processDueReminders().catch(() => {}); }, 15_000);
}

// CORS configuration.
//
// By default the SPA is served same-origin so no CORS headers are needed.
// Two opt-in modes for cross-origin deployments:
//
//   KEEPARR_CORS_ALLOW_ALL=1
//     Send `Access-Control-Allow-Origin: *` to every request, no credential
//     mode. Fine for personal/family self-hosted instances where you don't
//     want to fight allowlist syntax. Authenticated calls still need a valid
//     Bearer token (Keeparr doesn't use cookies), so an attacker site can't
//     read user data — but it does expose the unauth endpoints (login,
//     register, setup status) to direct browser fetch from anywhere. See
//     docker-compose.yml for the full security tradeoff.
//
//   KEEPARR_CORS_ORIGINS=https://app.example.com,https://keeparr.example.com
//     Comma-separated allowlist. Keeparr also allows exact native-shell origins
//     so the iOS/Android apps can connect while browser access stays pinned
//     to your configured domains. Required if you ever switch Keeparr to
//     cookie-based sessions.
//
// If both are set, the explicit allowlist wins.
const corsAllowlist = String(process.env.KEEPARR_CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const nativeShellOrigins = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost'
]);
if (corsAllowlist.length) {
  const allowedOrigins = new Set([...corsAllowlist, ...nativeShellOrigins]);
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl
      cb(null, allowedOrigins.has(origin));
    },
    credentials: true
  }));
} else if (process.env.KEEPARR_CORS_ALLOW_ALL === '1') {
  app.use(cors({ origin: '*' }));
}
app.use('/api', (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
  next();
});
app.use(express.json({ limit: '25mb' }));

mountOAuthAndMcpRoutes(app, {
  get, all, run, withDatabaseTransaction, asyncRoute, requireAuth, resolveSessionFromToken, createSession,
  oauthRegistrationLimiter, internalBaseUrl: `http://127.0.0.1:${port}`
});

// Optional operator secret for the first-admin form, so whoever reaches a fresh instance first cannot claim it.
function setupTokenMatches(supplied) {
  const expected = String(process.env.KEEPARR_SETUP_TOKEN || '');
  if (!expected) return true;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/api/setup/status', asyncRoute(async (_req, res) => {
  const row = await get('SELECT COUNT(*) AS count FROM users');
  res.json({ hasUsers: row.count > 0, setupTokenRequired: row.count === 0 && !!process.env.KEEPARR_SETUP_TOKEN });
}));

// Setup is checked and applied as one step, so two simultaneous requests cannot both create an administrator.
let setupAdminInProgress = false;
app.post('/api/setup/admin', setupLimiter, asyncRoute(async (req, res) => {
  if (setupAdminInProgress) return res.status(409).json({ error: 'Initial setup is already in progress.' });
  setupAdminInProgress = true;
  try {
  const row = await get('SELECT COUNT(*) AS count FROM users');
  if (row.count > 0) return res.status(409).json({ error: 'Initial setup is already complete.' });
  if (!setupTokenMatches(req.body?.setupToken)) return res.status(403).json({ error: 'The setup token is missing or incorrect.' });

  const { totpSecret, totpToken, setupToken: _setupToken, ...userData } = req.body;
  let backupCodes = null;

  if (totpSecret) {
    if (!totpToken) return res.status(400).json({ error: 'A 2FA code is required to enable 2FA.' });
    const isValid = verifyTotpToken(totpToken, totpSecret);
    if (!isValid) return res.status(400).json({ error: 'Invalid 2FA code.' });
    backupCodes = generateBackupCodes();
  }

  const user = await createUser({ ...userData, role: 'admin', totpSecret: totpSecret || null, totpBackupCodes: backupCodes ? JSON.stringify(backupCodes) : null });
  await setAppSetting('originalAdminUserId', String(user.id));
  res.status(201).json({ user: publicUser(user), backupCodes });
  } finally {
    setupAdminInProgress = false;
  }
}));

// Refuse before multer writes anything: restore is only possible when the operator enabled it and no user exists yet.
const restoreUpload = multer({ dest: path.join(dataDir, 'backups'), limits: { fileSize: Number(process.env.KEEPARR_RESTORE_MAX_BYTES) || 2 * 1024 * 1024 * 1024, files: 1 } });
app.post('/api/setup/restore', setupLimiter, asyncRoute(async (req, res, next) => {
  // Guard: even if all users are deleted, restore must be explicitly enabled
  // by the operator via KEEPARR_ALLOW_RESTORE=1. Otherwise an attacker who can
  // wipe the DB could swap in an arbitrary SQLite to take over.
  if (process.env.KEEPARR_ALLOW_RESTORE !== '1') {
    return res.status(403).json({ error: 'Restore is disabled. Set KEEPARR_ALLOW_RESTORE=1 on the server to enable.' });
  }
  const row = await get('SELECT COUNT(*) AS count FROM users');
  if (row.count > 0) return res.status(403).json({ error: 'Initial setup already complete.' });
  next();
}), restoreUpload.single('backup'), asyncRoute(async (req, res) => {

  if (!req.file) return res.status(400).json({ error: 'Backup file is required.' });

  const tempPath = req.file.path;
  const stagingDir = path.join(backupDirectory(), `.restore-${randomHex(8)}`);
  const cleanup = () => {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  };

  // Everything is unpacked and checked in a staging directory first; live data is not touched until it all passes.
  let staged;
  try {
    const fd = fs.openSync(tempPath, 'r');
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
      fs.mkdirSync(stagingDir, { recursive: true });
      staged = await backupArchive.extractBackupArchive(tempPath, stagingDir);
    } else if (header.toString('utf8', 0, 16) === 'SQLite format 3\0') {
      staged = { dbPath: tempPath, uploads: [], attachments: [], vapidPath: '' }; // legacy database-only backup
    } else {
      cleanup();
      return res.status(400).json({ error: 'File is not a Keeparr backup (.zip or .sqlite).' });
    }
    await backupArchive.validateBackupDatabase(staged.dbPath);
  } catch (e) {
    cleanup();
    return res.status(400).json({ error: e.message || 'Could not read backup file.' });
  }

  const rollbackPath = `${dbPath}.pre-restore`;
  const copiedFiles = [];
  const removeSqliteSidecars = () => { for (const suffix of ['-wal', '-shm']) { try { fs.rmSync(dbPath + suffix, { force: true }); } catch {} } };
  try {
    await withDatabaseExclusive(async setConnection => {
      await closeDatabase();
      removeSqliteSidecars();
      const hadDatabase = fs.existsSync(dbPath);
      if (hadDatabase) fs.renameSync(dbPath, rollbackPath);
      try {
        fs.copyFileSync(staged.dbPath, dbPath);
        for (const [directory, names, prefix] of [[uploadDir, staged.uploads, 'uploads'], [attachmentDir, staged.attachments, 'attachments']]) {
          for (const name of names) {
            const target = path.join(directory, name);
            try {
              fs.copyFileSync(path.join(stagingDir, prefix, name), target, fs.constants.COPYFILE_EXCL);
              copiedFiles.push(target);
            } catch (error) { if (error.code !== 'EEXIST') throw error; }
          }
        }
        if (staged.vapidPath) fs.copyFileSync(staged.vapidPath, vapidPath);
        setConnection(openDatabase());
        await init();
        resetAuthStateAfterRestore();
      } catch (error) {
        // Put the previous database back and reopen it, so a failed restore leaves the instance as it was.
        await closeDatabase().catch(() => {});
        removeSqliteSidecars();
        for (const file of copiedFiles) { try { fs.unlinkSync(file); } catch {} }
        try { fs.rmSync(dbPath, { force: true }); } catch {}
        if (hadDatabase) fs.renameSync(rollbackPath, dbPath);
        setConnection(openDatabase());
        throw error;
      }
      try { fs.rmSync(rollbackPath, { force: true }); } catch {}
    });
    cleanup();
    res.json({ success: true, files: (staged.uploads?.length || 0) + (staged.attachments?.length || 0) });
  } catch (e) {
    cleanup();
    res.status(500).json({ error: 'Restore failed: ' + e.message });
  }
}));


mountAuthRoutes(app, { normalizeUsername, hashPassword, createSession, generateBackupCodes, revokeUserCredentials });

app.get('/api/users/me/preferences', requireAuth, asyncRoute(async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json(publicUser(user));
}));

app.patch('/api/users/me/preferences', requireAuth, asyncRoute(async (req, res) => {
  const assignments = [];
  const params = [];
  if (req.body.theme !== undefined) {
    if (!['light', 'dark'].includes(req.body.theme)) return res.status(400).json({ error: 'Invalid theme.' });
    assignments.push('theme = ?');
    params.push(req.body.theme);
  }
  if (req.body.showPastReminders !== undefined) {
    if (typeof req.body.showPastReminders !== 'boolean') {
      return res.status(400).json({ error: 'showPastReminders must be a boolean.' });
    }
    assignments.push('showPastReminders = ?');
    params.push(req.body.showPastReminders ? 1 : 0);
  }
  if (assignments.length) {
    params.push(req.user.id);
    await run(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
  }
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json(publicUser(user));
}));

function mcpAccessResponse(user, tokenRow) {
  return {
    enabled: !!user.mcpEnabled,
    allowLockedNotes: !!user.mcpAllowLockedNotes,
    allowPermanentDelete: !!user.mcpAllowPermanentDelete,
    token: tokenRow ? {
      prefix: tokenRow.tokenPrefix,
      createdAt: tokenRow.createdAt,
      lastUsedAt: tokenRow.lastUsedAt || null
    } : null
  };
}

function externalCapabilitiesResponse(user) {
  return {
    allowLockedNotes: !!user.mcpAllowLockedNotes,
    allowPermanentDelete: !!user.mcpAllowPermanentDelete
  };
}

function oauthAccessResponse(user, grants) {
  return {
    enabled: !!user.oauthEnabled,
    ...externalCapabilitiesResponse(user),
    connections: grants.map(grant => ({
      id: grant.id,
      clientId: grant.clientId,
      clientName: grant.clientName,
      resource: grant.resource,
      scopes: String(grant.scope || '').split(/\s+/).filter(Boolean),
      authorizedAt: grant.authorizedAt,
      lastUsedAt: grant.lastUsedAt || null
    }))
  };
}

async function oauthGrantsForUser(userId) {
  return await all(
    `SELECT id, clientId, clientName, resource, scope, authorizedAt, lastUsedAt
     FROM oauth_grants WHERE userId = ? ORDER BY authorizedAt DESC`,
    [userId]
  );
}

app.get('/api/users/me/mcp-access', requireAuth, asyncRoute(async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const token = await get('SELECT tokenPrefix, createdAt, lastUsedAt FROM mcp_tokens WHERE userId = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
  res.json(mcpAccessResponse(user, token));
}));

app.post('/api/users/me/mcp-access/enable', requireAuth, asyncRoute(async (req, res) => {
  const rawToken = `keeparr_mcp_${randomHex(32)}`;
  const now = new Date().toISOString();
  await withDatabaseTransaction(async () => {
    await run(
      `DELETE FROM external_unlock_challenges
       WHERE principalType = 'mcp' AND principalId IN (SELECT id FROM mcp_tokens WHERE userId = ?)`,
      [req.user.id]
    );
    await run('DELETE FROM mcp_tokens WHERE userId = ?', [req.user.id]);
    await run(
      'INSERT INTO mcp_tokens (userId, tokenHash, tokenPrefix, createdAt) VALUES (?, ?, ?, ?)',
      [req.user.id, mcpTokenHash(rawToken), `${rawToken.slice(0, 17)}…`, now]
    );
    await run('UPDATE users SET mcpEnabled = 1 WHERE id = ?', [req.user.id]);
  });
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const token = await get('SELECT tokenPrefix, createdAt, lastUsedAt FROM mcp_tokens WHERE userId = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
  res.status(201).json({ ...mcpAccessResponse(user, token), accessToken: rawToken });
}));

app.patch('/api/users/me/mcp-access', requireAuth, asyncRoute(async (req, res) => {
  const assignments = [];
  const params = [];
  for (const [field, column] of [
    ['allowLockedNotes', 'mcpAllowLockedNotes'],
    ['allowPermanentDelete', 'mcpAllowPermanentDelete']
  ]) {
    if (req.body?.[field] === undefined) continue;
    if (typeof req.body[field] !== 'boolean') return res.status(400).json({ error: `${field} must be a boolean.` });
    assignments.push(`${column} = ?`);
    params.push(req.body[field] ? 1 : 0);
  }
  if (assignments.length) {
    params.push(req.user.id);
    await run(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
  }
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const token = await get('SELECT tokenPrefix, createdAt, lastUsedAt FROM mcp_tokens WHERE userId = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
  res.json(mcpAccessResponse(user, token));
}));

app.patch('/api/users/me/external-access/capabilities', requireAuth, asyncRoute(async (req, res) => {
  const assignments = [];
  const params = [];
  for (const [field, column] of [
    ['allowLockedNotes', 'mcpAllowLockedNotes'],
    ['allowPermanentDelete', 'mcpAllowPermanentDelete']
  ]) {
    if (req.body?.[field] === undefined) continue;
    if (typeof req.body[field] !== 'boolean') return res.status(400).json({ error: `${field} must be a boolean.` });
    assignments.push(`${column} = ?`);
    params.push(req.body[field] ? 1 : 0);
  }
  if (assignments.length) {
    params.push(req.user.id);
    await run(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
  }
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json(externalCapabilitiesResponse(user));
}));

app.delete('/api/users/me/mcp-access', requireAuth, asyncRoute(async (req, res) => {
  await withDatabaseTransaction(async () => {
    await run(
      `DELETE FROM external_unlock_challenges
       WHERE principalType = 'mcp' AND principalId IN (SELECT id FROM mcp_tokens WHERE userId = ?)`,
      [req.user.id]
    );
    await run('DELETE FROM mcp_tokens WHERE userId = ?', [req.user.id]);
    await run('UPDATE users SET mcpEnabled = 0 WHERE id = ?', [req.user.id]);
  });
  res.status(204).end();
}));

app.get('/api/users/me/oauth-access', requireAuth, asyncRoute(async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json(oauthAccessResponse(user, await oauthGrantsForUser(req.user.id)));
}));

app.post('/api/users/me/oauth-access/enable', requireAuth, asyncRoute(async (req, res) => {
  await run('UPDATE users SET oauthEnabled = 1 WHERE id = ?', [req.user.id]);
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json(oauthAccessResponse(user, await oauthGrantsForUser(req.user.id)));
}));

app.delete('/api/users/me/oauth-access/connections/:grantId', requireAuth, asyncRoute(async (req, res) => {
  const grantId = Number(req.params.grantId);
  if (!Number.isInteger(grantId) || grantId <= 0) return res.status(400).json({ error: 'Invalid OAuth connection.' });
  const grant = await get('SELECT id FROM oauth_grants WHERE id = ? AND userId = ?', [grantId, req.user.id]);
  if (!grant) return res.status(404).json({ error: 'OAuth connection not found.' });
  await withDatabaseTransaction(async () => {
    await run("DELETE FROM external_unlock_challenges WHERE principalType = 'oauth' AND principalId = ?", [grantId]);
    await run('DELETE FROM oauth_grants WHERE id = ? AND userId = ?', [grantId, req.user.id]);
  });
  res.status(204).end();
}));

app.delete('/api/users/me/oauth-access', requireAuth, asyncRoute(async (req, res) => {
  await withDatabaseTransaction(async () => {
    await run(
      `DELETE FROM external_unlock_challenges
       WHERE principalType = 'oauth' AND principalId IN (SELECT id FROM oauth_grants WHERE userId = ?)`,
      [req.user.id]
    );
    await run('DELETE FROM oauth_grants WHERE userId = ?', [req.user.id]);
    await run('UPDATE users SET oauthEnabled = 0 WHERE id = ?', [req.user.id]);
  });
  res.status(204).end();
}));

// Marks the user as having had their starter/demo notes created. Idempotent —
// only sets the timestamp the first time. The client uses this server-side
// flag (instead of localStorage) so demos appear once across all devices and
// reliably even when first login goes through the 2FA path.
app.post('/api/users/me/mark-demo-notes-created', requireAuth, asyncRoute(async (req, res) => {
  if (!req.user.demoNotesCreatedAt) {
    await run('UPDATE users SET demoNotesCreatedAt = ? WHERE id = ?', [new Date().toISOString(), req.user.id]);
  }
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json(publicUser(user));
}));

app.patch('/api/users/me/profile', requireAuth, asyncRoute(async (req, res) => {
  const displayName = String(req.body.displayName || req.user.displayName).trim() || req.user.username;
  const avatarDataUrl = String(req.body.avatarDataUrl || '');
  const avatarPreset = req.body.avatarPreset ? String(req.body.avatarPreset) : req.user.avatarPreset;

  if (avatarDataUrl) {
    // Restrict to raster image data URLs. SVG can carry <script> and is
    // rendered to many places (sharing list, collaborator chips, navbar).
    if (!/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarDataUrl)) {
      return res.status(400).json({ error: 'Avatar must be a PNG, JPEG, GIF, or WEBP data URL.' });
    }
  }
  if (avatarDataUrl.length > 5000000) {
    return res.status(400).json({ error: 'Avatar image is too large.' });
  }

  await run('UPDATE users SET displayName = ?, avatarDataUrl = ?, avatarPreset = ? WHERE id = ?', [displayName, avatarDataUrl, avatarPreset, req.user.id]);
  const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  await broadcastProfileUpdate(user);
  res.json(publicUser(user));
}));

app.delete('/api/users/me', requireAuth, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const confirmation = String(req.body.confirmation || '');
  if (confirmation !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm account deletion.' });
  }
  if (hashPassword(currentPassword, req.user.passwordSalt) !== req.user.passwordHash) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }

  if (req.user.role === 'admin') {
    const admins = await get(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
    if (admins.count <= 1) return res.status(400).json({ error: 'At least one administrator account is required. Promote another user first.' });
  }

  const deletedUserId = req.user.id;
  await deleteUserAndOwnedData(deletedUserId);
  broadcastRealtime([deletedUserId], { type: 'account-deleted' });
  res.status(204).end();
}));

app.get('/api/users', requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
  const users = await all('SELECT * FROM users ORDER BY username');
  res.json(users.map(publicUser));
}));

app.post('/api/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const user = await createUser({ ...req.body, role });
  res.status(201).json(publicUser(user));
}));

app.delete('/api/users/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  if (req.user.id === userId) return res.status(400).json({ error: 'You cannot delete your own account while signed in.' });

  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (await isOriginalAdminUser(userId)) {
    return res.status(403).json({ error: 'The original administrator account cannot be deleted.' });
  }

  if (user.role === 'admin') {
    const admins = await get(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
    if (admins.count <= 1) return res.status(400).json({ error: 'At least one administrator account is required.' });
  }

  await deleteUserAndOwnedData(userId);
  res.status(204).end();
}));

app.patch('/api/users/me/password', requireAuth, asyncRoute(async (req, res) => {
  const currentPassword = String(req.body.currentPassword || '');
  const newPassword = String(req.body.newPassword || '');

  if (hashPassword(currentPassword, req.user.passwordSalt) !== req.user.passwordHash) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }

  const newSalt = randomHex(16);
  const newHash = hashPassword(newPassword, newSalt);
  await run('UPDATE users SET passwordHash = ?, passwordSalt = ? WHERE id = ?', [newHash, newSalt, req.user.id]);
  // Every other device, the MCP token and all OAuth apps must authenticate again; this device stays signed in.
  await revokeUserCredentials(req.user.id, { exceptSessionHash: req.tokenHash, reason: 'Password was changed.' });
  res.json({ success: true });
}));

app.patch('/api/users/:id/reset-password', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  const newPassword = String(req.body.newPassword || '');

  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const newSalt = randomHex(16);
  const newHash = hashPassword(newPassword, newSalt);
  await run('UPDATE users SET passwordHash = ?, passwordSalt = ? WHERE id = ?', [newHash, newSalt, userId]);
  // Force the target user to re-authenticate everywhere, including MCP and OAuth access.
  await revokeUserCredentials(userId, { reason: 'Password was reset.' });
  res.json({ success: true });
}));

app.patch('/api/users/:id/toggle-enabled', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = Number(req.params.id);
  const enabled = req.body.enabled ? 1 : 0;

  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (req.user.id === userId) return res.status(400).json({ error: 'You cannot disable your own account.' });

  await run('UPDATE users SET enabled = ? WHERE id = ?', [enabled, userId]);
  if (!enabled) await revokeUserCredentials(userId, { reason: 'Account disabled.' });
  const updated = await get('SELECT * FROM users WHERE id = ?', [userId]);
  res.json(publicUser(updated));
}));

app.get('/api/settings/registration', asyncRoute(async (_req, res) => {
  const selfRegistrationEnabled = await getAppSetting('selfRegistrationEnabled', 'false');
  const requireApproval = await getAppSetting('requireApproval', 'true');
  res.json({
    selfRegistrationEnabled: selfRegistrationEnabled === 'true',
    requireApproval: requireApproval === 'true'
  });
}));

app.patch('/api/settings/registration', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  if (req.body.selfRegistrationEnabled !== undefined) {
    await setAppSetting('selfRegistrationEnabled', String(!!req.body.selfRegistrationEnabled));
  }
  if (req.body.requireApproval !== undefined) {
    await setAppSetting('requireApproval', String(!!req.body.requireApproval));
  }
  const selfRegistrationEnabled = await getAppSetting('selfRegistrationEnabled', 'false');
  const requireApproval = await getAppSetting('requireApproval', 'true');
  res.json({
    selfRegistrationEnabled: selfRegistrationEnabled === 'true',
    requireApproval: requireApproval === 'true'
  });
}));

mountBackupRoutes(app);

app.post('/api/admin/users/:id/disable-2fa', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const userId = parseInt(req.params.id);
  const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  await run('UPDATE users SET totpSecret = NULL, totpBackupCodes = NULL, totpEnabled = 0 WHERE id = ?', [userId]);
  await revokeUserCredentials(userId, { reason: 'Two-factor authentication was disabled by an administrator.', sessionsOnly: true });
  res.json({ success: true, message: '2FA disabled for user.' });
}));

app.get('/api/admin/update-status', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const trace = createPerfTrace('admin-update-status');
  const latest = getCachedLatestRelease();
  refreshLatestReleaseInBackground();
  trace.mark('cache');

  // Fetch any dismissals this admin has set for the current latest version.
  // A "forever" dismissal silences this version permanently for them; a
  // regular dismissal silences for 30 days.
  let dismissedUntil = null;
  let dismissedForever = false;
  if (latest?.version) {
    const dismissal = await get(
      'SELECT dismissedAt, forever FROM update_dismissals WHERE userId = ? AND version = ?',
      [req.user.id, latest.version]
    );
    trace.mark('dismissal-query', { latest: latest.version, hasDismissal: !!dismissal });
    if (dismissal) {
      dismissedForever = !!dismissal.forever;
      if (!dismissedForever && dismissal.dismissedAt) {
        const until = new Date(new Date(dismissal.dismissedAt).getTime() + 30 * 24 * 60 * 60 * 1000);
        dismissedUntil = until.toISOString();
      }
    }
  } else {
    trace.mark('dismissal-query-skipped');
  }

  const isOutdated = latest?.version ? compareVersion(latest.version, KEEPARR_VERSION) > 0 : false;
  const now = new Date();
  const suppressed =
    dismissedForever ||
    (dismissedUntil && new Date(dismissedUntil) > now);

  sendJsonWithPerf(res, trace, {
    current: KEEPARR_VERSION,
    latest: latest?.version || null,
    releaseUrl: latest?.url || null,
    releaseNotes: latest?.notes || null,
    publishedAt: latest?.publishedAt || null,
    isOutdated,
    suppressed: !!suppressed,
    dismissedForever,
    dismissedUntil,
    checkedAt: updateCheckCache.fetchedAt ? new Date(updateCheckCache.fetchedAt).toISOString() : null,
    checkError: updateCheckCache.error
  });
}));

app.post('/api/admin/update-status/dismiss', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
  const version = String(req.body.version || '').trim().replace(/^v/i, '');
  if (!version) return res.status(400).json({ error: 'version is required.' });
  const forever = !!req.body.forever;
  await run(
    `INSERT INTO update_dismissals (userId, version, dismissedAt, forever)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(userId, version) DO UPDATE SET dismissedAt = excluded.dismissedAt, forever = excluded.forever`,
    [req.user.id, version, new Date().toISOString(), forever ? 1 : 0]
  );
  res.status(204).end();
}));




app.post('/api/auth/register', registerLimiter, asyncRoute(async (req, res) => {
  const regEnabled = await getAppSetting('selfRegistrationEnabled', 'false');
  if (regEnabled !== 'true') {
    return res.status(403).json({ error: 'Self-registration is not enabled.' });
  }

  const { username, displayName, email, password } = req.body;
  if (!email || !validateEmail(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  const requireApproval = await getAppSetting('requireApproval', 'true');
  const needsApproval = requireApproval === 'true';

  try {
    const user = await createUser({
      username,
      displayName,
      password,
      email,
      role: 'user',
      enabled: !needsApproval
    });
    res.status(201).json({
      success: true,
      needsApproval,
      message: needsApproval
        ? 'Account created. An administrator must approve your account before you can sign in.'
        : 'Account created successfully. You can now sign in.'
    });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    return res.status(e.status || 500).json({ error: e.message || 'Could not create account.' });
  }
}));

app.get('/api/sharing/users', requireAuth, asyncRoute(async (req, res) => {
  const users = await all(
    `SELECT users.id, users.username, users.displayName, users.avatarDataUrl, users.avatarPreset,
            COUNT(notes.id) AS shareCount
     FROM users
     LEFT JOIN note_collaborators ON note_collaborators.userId = users.id
     LEFT JOIN notes ON notes.id = note_collaborators.noteId AND notes.ownerUserId = ?
     WHERE users.id != ?
     GROUP BY users.id
     ORDER BY shareCount DESC, users.displayName COLLATE NOCASE, users.username COLLATE NOCASE`,
    [req.user.id, req.user.id]
  );
  res.json(users.map(u => ({
    ...publicCollaborator(u),
    online: realtimeClients.has(u.id)
  })));
}));

function notePasscodeHash(passcode, salt, algorithm = 'pbkdf2') {
  if (algorithm === 'sha256') {
    return crypto.createHash('sha256').update(`${salt}:${passcode}`).digest('base64url');
  }
  return crypto.pbkdf2Sync(String(passcode), String(salt), 150000, 32, 'sha256').toString('base64url');
}

function verifyNotePasscode(note, passcode) {
  const stored = String(note?.lockHash || '');
  const [algorithm, expected] = stored.split(':', 2);
  if (!expected || !['pbkdf2', 'sha256'].includes(algorithm)) return false;
  const actual = notePasscodeHash(passcode, note.lockSalt || '', algorithm);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function mcpNoteIsUnlocked(req, noteId) {
  if (!req.mcpToken) return true;
  if (!req.mcpCapabilities?.allowLockedNotes) return false;
  const row = await get(
    `SELECT token FROM external_unlock_challenges
     WHERE principalType = ? AND principalId = ? AND noteId = ? AND approved = 1 AND expiresAt > ?
     ORDER BY createdAt DESC LIMIT 1`,
    [req.mcpToken.type, req.mcpToken.id, noteId, new Date().toISOString()]
  );
  return !!row;
}

function mcpNoteResponse(note, includeLockedContent) {
  const result = { ...note };
  delete result.lockSalt;
  delete result.lockHash;
  delete result.ownerAvatarDataUrl;
  delete result.lwwPhysicalMs;
  delete result.lwwLogical;
  delete result.lwwDeviceId;
  delete result.lwwOperationId;
  if (result.locked && !includeLockedContent) {
    result.noteBody = '';
    result.checkBoxes = [];
    result.images = [];
    result.attachments = [];
    result.extraFields = {};
    result.hasAttachments = false;
    result.lockedContentAvailable = false;
  } else if (result.locked) {
    result.lockedContentAvailable = true;
  }
  return result;
}

app.get('/api/oauth/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    displayName: req.user.displayName,
    email: req.user.email || '',
    role: req.user.role
  });
});

app.get('/api/mcp/status', requireAuth, (req, res) => {
  res.json({
    enabled: true,
    userId: req.user.id,
    allowLockedNotes: !!req.mcpCapabilities?.allowLockedNotes,
    allowPermanentDelete: !!req.mcpCapabilities?.allowPermanentDelete
  });
});

app.post('/api/mcp/locked-notes/:noteId/unlock', requireAuth, asyncRoute(async (req, res) => {
  if (!req.mcpCapabilities?.allowLockedNotes) {
    return res.status(403).json({ error: 'Locked-note access is disabled in Keeparr settings.' });
  }
  const noteId = Number(req.params.noteId);
  const note = await getAccessibleNote(noteId, req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  if (!note.locked) return res.json({ unlocked: true, expiresAt: null });
  if (await mcpNoteIsUnlocked(req, noteId)) return res.json({ unlocked: true, expiresAt: null });

  const challenge = randomHex(32);
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000).toISOString();
  await run(
    `INSERT INTO external_unlock_challenges
     (token, principalType, principalId, userId, noteId, approved, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
    [challenge, req.mcpToken.type, req.mcpToken.id, req.user.id, noteId, createdAt.toISOString(), expiresAt]
  );
  const publicOrigin = String(process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  res.status(201).json({
    unlocked: false,
    unlockUrl: `${publicOrigin}/api/mcp/unlock/${challenge}`,
    expiresAt
  });
}));

app.get('/api/mcp/locked-notes/:noteId/unlock', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.noteId);
  res.json({ unlocked: await mcpNoteIsUnlocked(req, noteId) });
}));

app.get('/api/mcp/unlock/:challenge', asyncRoute(async (req, res) => {
  const challenge = await get(
    `SELECT c.*, n.noteTitle FROM external_unlock_challenges c
     JOIN notes n ON n.id = c.noteId
     WHERE c.token = ? AND c.expiresAt > ?`,
    [String(req.params.challenge || ''), new Date().toISOString()]
  );
  if (!challenge) return res.status(404).send('This unlock request is invalid or has expired.');
  if (challenge.approved) return res.send('This note is already unlocked for external access. You can close this page.');
  const safeTitle = escapeHtml(plainText(challenge.noteTitle || '') || 'Locked note');
  res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlock Keeparr note</title><style>body{background:#202124;color:#e8eaed;font:16px system-ui;margin:0;padding:32px}main{max-width:420px;margin:10vh auto}input,button{box-sizing:border-box;font:inherit;width:100%;padding:12px;margin-top:12px}button{background:#fbbc04;border:0;color:#202124;font-weight:700;cursor:pointer}.hint{color:#9aa0a6;font-size:13px}</style></head><body><main><h1>Unlock ${safeTitle}</h1><p>Enter this note's Keeparr passcode. It is sent directly to your Keeparr server and is not shared with the connected client or model.</p><form method="post"><input type="password" name="passcode" autocomplete="current-password" required autofocus><button type="submit">Unlock for 5 minutes</button></form><p class="hint">This only unlocks this note for the requesting connection.</p></main></body></html>`);
}));

app.post('/api/mcp/unlock/:challenge', express.urlencoded({ extended: false, limit: '8kb' }), asyncRoute(async (req, res) => {
  const challenge = await get(
    `SELECT c.*, n.locked, n.lockSalt, n.lockHash FROM external_unlock_challenges c
     JOIN notes n ON n.id = c.noteId
     JOIN users u ON u.id = c.userId
     WHERE c.token = ? AND c.expiresAt > ? AND u.mcpAllowLockedNotes = 1
       AND ((c.principalType = 'mcp' AND u.mcpEnabled = 1)
         OR (c.principalType = 'oauth' AND u.oauthEnabled = 1))`,
    [String(req.params.challenge || ''), new Date().toISOString()]
  );
  if (!challenge) return res.status(404).send('This unlock request is invalid or has expired.');
  if (Number(challenge.failedAttempts || 0) >= 5) {
    return res.status(429).send('Too many incorrect attempts. Request a new unlock link from the agent.');
  }
  if (!verifyNotePasscode(challenge, String(req.body?.passcode || ''))) {
    await run('UPDATE external_unlock_challenges SET failedAttempts = failedAttempts + 1 WHERE token = ?', [challenge.token]);
    return res.status(401).send('Incorrect passcode. Go back and try again.');
  }
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  await run('UPDATE external_unlock_challenges SET approved = 1, expiresAt = ? WHERE token = ?', [expiresAt, challenge.token]);
  res.send('Note unlocked for external access for five minutes. You can close this page.');
}));

app.get('/api/users/search', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  const like = `%${q.toLowerCase()}%`;
  const users = await all(
    `SELECT id, username, displayName, avatarDataUrl, avatarPreset
     FROM users
     WHERE id != ? AND enabled = 1
       AND (lower(username) LIKE ? OR lower(displayName) LIKE ? OR lower(COALESCE(email, '')) LIKE ?)
     ORDER BY displayName COLLATE NOCASE, username COLLATE NOCASE
     LIMIT 20`,
    [req.user.id, like, like, like]
  );
  res.json(users.map(publicCollaborator));
}));

app.get('/api/labels', requireAuth, asyncRoute(async (req, res) => {
  res.json(await all('SELECT id, name FROM labels WHERE userId = ? ORDER BY name COLLATE NOCASE, id', [req.user.id]));
}));

app.post('/api/labels/find-or-create', requireAuth, asyncRoute(async (req, res) => {
  const label = await findOrCreateLabelForUser(req.user.id, req.body.name);
  res.status(200).json(label);
}));

app.post('/api/labels', requireAuth, asyncRoute(async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Label name is required.' });
  const result = await run('INSERT INTO labels (name, userId) VALUES (?, ?)', [name, req.user.id]);
  res.status(201).json({ id: result.id, name });
}));

app.patch('/api/labels/:id', requireAuth, asyncRoute(async (req, res) => {
  const labelId = Number(req.params.id);
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Label name is required.' });
  const label = await get('SELECT id, name FROM labels WHERE id = ? AND userId = ?', [labelId, req.user.id]);
  if (!label) return res.status(404).json({ error: 'Label not found.' });
  const duplicate = await get(
    'SELECT id FROM labels WHERE userId = ? AND lower(name) = lower(?) AND id <> ?',
    [req.user.id, name, labelId]
  );
  if (duplicate) return res.status(409).json({ error: 'Label already exists.' });
  await run('UPDATE labels SET name = ? WHERE id = ? AND userId = ?', [name, labelId, req.user.id]);
  const { recipientIds } = await updateNoteLabelReferencesForUser(req.user.id, labelId, name, { oldName: label.name });
  broadcastRealtime([...recipientIds], { type: 'notes-changed', action: 'labels-updated' });
  res.json({ id: labelId, name });
}));

app.delete('/api/labels/:id', requireAuth, asyncRoute(async (req, res) => {
  const labelId = Number(req.params.id);
  const label = await get('SELECT id, name FROM labels WHERE id = ? AND userId = ?', [labelId, req.user.id]);
  if (!label) return res.status(404).json({ error: 'Label not found.' });
  await run('DELETE FROM labels WHERE id = ? AND userId = ?', [labelId, req.user.id]);
  const { recipientIds } = await updateNoteLabelReferencesForUser(req.user.id, labelId, '', { oldName: label.name });
  broadcastRealtime([...recipientIds], { type: 'notes-changed', action: 'labels-updated' });
  res.status(204).end();
}));

app.post('/api/uploads/images', requireAuth, upload.single('image'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Image file is required.' });
  const uploadOperationId = String(req.body?.operationId || '').trim();
  if (uploadOperationId && (uploadOperationId.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(uploadOperationId))) {
    fs.unlink(req.file.path, () => undefined);
    return res.status(400).json({ error: 'Invalid image upload operation ID.' });
  }
  const now = new Date().toISOString();
  const contentHash = sha256File(req.file.path);
  const response = {
    url: `${PRIVATE_IMAGE_PREFIX}${req.file.filename}`,
    name: req.file.originalname || req.file.filename,
    size: req.file.size,
    type: req.file.mimetype
  };
  try {
    const result = uploadOperationId ? await withDatabaseTransaction(async () => {
      const receipt = await get(`SELECT * FROM native_upload_receipts
        WHERE userId = ? AND operationId = ? AND resourceType = 'image'`, [req.user.id, uploadOperationId]);
      if (receipt) {
        if (receipt.contentHash !== contentHash) return { status: 409, error: 'Image operation ID was reused with different content.' };
        const filename = safeStoredImageFilename(receipt.resourceSyncId);
        if (receipt.state !== 'active' || !filename || !fs.existsSync(path.join(uploadDir, filename))) {
          return { status: 410, error: 'This image upload was already deleted.' };
        }
        return { status: 200, payload: JSON.parse(receipt.payload) };
      }

      // Backfill receipts created by the earlier operationId-on-note_images implementation.
      const legacy = await get('SELECT * FROM note_images WHERE ownerUserId = ? AND uploadOperationId = ?', [req.user.id, uploadOperationId]);
      if (legacy) {
        const legacyPath = path.join(uploadDir, safeStoredImageFilename(legacy.storedFilename));
        if (!fs.existsSync(legacyPath)) return { status: 410, error: 'This image upload was already deleted.' };
        const legacyHash = sha256File(legacyPath);
        if (legacyHash !== contentHash) return { status: 409, error: 'Image operation ID was reused with different content.' };
        const legacyPayload = { url: `${PRIVATE_IMAGE_PREFIX}${legacy.storedFilename}`, name: legacy.originalName,
          size: legacy.fileSize, type: legacy.mimeType };
        await run(`INSERT INTO native_upload_receipts
          (userId, operationId, resourceType, resourceSyncId, noteId, contentHash, payload, state, createdAt, updatedAt)
          VALUES (?, ?, 'image', ?, ?, ?, ?, 'active', ?, ?)`,
        [req.user.id, uploadOperationId, legacy.storedFilename, legacy.noteId, legacyHash, JSON.stringify(legacyPayload), now, now]);
        return { status: 200, payload: legacyPayload };
      }

      await run(`INSERT INTO note_images (noteId, ownerUserId, storedFilename, originalName, fileSize, mimeType, uploadedAt, uploadOperationId)
        VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, req.file.filename, response.name, req.file.size, req.file.mimetype, now, uploadOperationId]);
      await run(`INSERT INTO native_upload_receipts
        (userId, operationId, resourceType, resourceSyncId, noteId, contentHash, payload, state, createdAt, updatedAt)
        VALUES (?, ?, 'image', ?, NULL, ?, ?, 'active', ?, ?)`,
      [req.user.id, uploadOperationId, req.file.filename, contentHash, JSON.stringify(response), now, now]);
      return { status: 201, payload: response };
    }) : null;

    if (!uploadOperationId) {
      await run(`INSERT INTO note_images (noteId, ownerUserId, storedFilename, originalName, fileSize, mimeType, uploadedAt, uploadOperationId)
        VALUES (NULL, ?, ?, ?, ?, ?, ?, NULL)`,
      [req.user.id, req.file.filename, response.name, req.file.size, req.file.mimetype, now]);
      return res.status(201).json(response);
    }
    if (result.error) {
      fs.unlink(req.file.path, () => undefined);
      return res.status(result.status).json({ error: result.error });
    }
    if (result.status !== 201) fs.unlink(req.file.path, () => undefined);
    res.status(result.status).json(result.payload);
  } catch (error) {
    fs.unlink(req.file.path, () => undefined);
    throw error;
  }
}));

app.get('/api/uploads/images/:filename', requireAuthOrMediaTicket, asyncRoute(async (req, res) => {
  const filename = safeStoredImageFilename(req.params.filename);
  if (!filename) return res.status(400).send('Invalid image filename.');

  const image = await get(
    `SELECT ni.*, n.locked
     FROM note_images ni
     LEFT JOIN notes n ON n.id = ni.noteId
     LEFT JOIN note_collaborators nc ON nc.noteId = n.id AND nc.userId = ?
     WHERE ni.storedFilename = ?
       AND (
         (ni.noteId IS NULL AND ni.ownerUserId = ?)
         OR n.ownerUserId = ?
         OR nc.userId IS NOT NULL
       )
     LIMIT 1`,
    [req.user.id, filename, req.user.id, req.user.id]
  );
  if (!image) return res.status(404).send('Image not found.');
  if (req.mcpToken && image.locked && image.noteId && !await mcpNoteIsUnlocked(req, image.noteId)) {
    return res.status(423).json({ error: 'Unlock this note before reading its images through MCP.' });
  }

  const filePath = path.join(uploadDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('Image file not found.');

  res.setHeader('Content-Type', image.mimeType || imageMimeType(filename));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
}));

// ─── Attachment Endpoints ──────────────────────────────────────────────────

app.post('/api/notes/:noteId/attachments', requireAuth, uploadAttachment.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'File is required.' });

  const noteId = Number(req.params.noteId);
  const syncId = String(req.body?.syncId || req.query?.syncId || `attachment-${crypto.randomUUID()}`).trim();
  const operationId = String(req.body?.operationId || req.query?.operationId || syncId).trim();
  if (!syncId || syncId.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(syncId) || !operationId || operationId.length > 160 || !/^[a-zA-Z0-9._:-]+$/.test(operationId)) {
    fs.unlink(req.file.path, () => undefined);
    return res.status(400).json({ error: 'Invalid attachment operation or sync ID.' });
  }
  const now = new Date().toISOString();
  const contentHash = sha256File(req.file.path);
  let result;
  try {
    result = await withDatabaseTransaction(async () => {
      const note = await getAccessibleNote(noteId, req.user.id);
      if (!note) return { status: 404, error: 'Note not found.' };
      if (req.mcpToken && note.locked && !await mcpNoteIsUnlocked(req, noteId)) {
        return { status: 423, error: 'Unlock this note before adding attachments through MCP.' };
      }
      const receipt = await get(`SELECT * FROM native_upload_receipts
        WHERE userId = ? AND operationId = ? AND resourceType = 'attachment'`, [req.user.id, operationId]);
      if (receipt) {
        if (receipt.contentHash !== contentHash || receipt.resourceSyncId !== syncId || Number(receipt.noteId) !== noteId) {
          return { status: 409, error: 'Attachment operation ID was reused with different content or destination.' };
        }
        if (receipt.state !== 'active') return { status: 410, error: 'This attachment upload was already deleted.' };
        const existingAttachment = await get('SELECT * FROM note_attachments WHERE syncId = ? AND noteId = ?', [syncId, noteId]);
        if (!existingAttachment || !fs.existsSync(attachmentPath(existingAttachment.storedFilename))) {
          return { status: 410, error: 'This attachment upload is no longer available.' };
        }
        return { status: 200, payload: attachmentResponse(existingAttachment), fileRetained: true };
      }

      const existing = await get(
        `SELECT na.* FROM note_attachments na
         JOIN notes n ON n.id = na.noteId
         LEFT JOIN note_collaborators nc ON nc.noteId = n.id AND nc.userId = ?
         WHERE na.syncId = ? AND (n.ownerUserId = ? OR nc.userId IS NOT NULL)`,
        [req.user.id, syncId, req.user.id]
      );
      if (existing) {
        if (existing.noteId !== noteId) return { status: 409, error: 'Attachment sync ID belongs to a different note.' };
        const existingPath = attachmentPath(existing.storedFilename);
        if (!fs.existsSync(existingPath) || sha256File(existingPath) !== contentHash) {
          return { status: 409, error: 'Attachment sync ID was reused with different content.' };
        }
        const existingNote = await get('SELECT revision FROM notes WHERE id = ?', [noteId]);
        const existingPayload = { ...attachmentResponse(existing), noteRevision: Number(existingNote?.revision || 1) };
        await run(`INSERT INTO native_upload_receipts
          (userId, operationId, resourceType, resourceSyncId, noteId, contentHash, payload, state, createdAt, updatedAt)
          VALUES (?, ?, 'attachment', ?, ?, ?, ?, 'active', ?, ?)`,
        [req.user.id, operationId, syncId, noteId, contentHash, JSON.stringify(existingPayload), now, now]);
        return { status: 200, payload: existingPayload, fileRetained: true };
      }

      const stamp = serverLwwStamp();
      const inserted = await run(
        `INSERT INTO note_attachments
           (noteId, syncId, originalName, storedFilename, fileSize, mimeType, uploadedAt, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [noteId, syncId, safeDownloadName(req.file.originalname || req.file.filename), req.file.filename, req.file.size,
          req.file.mimetype, now, stamp.physicalMs, stamp.logical, stamp.deviceId, stamp.operationId]
      );
      const attachment = await get('SELECT * FROM note_attachments WHERE id = ?', [inserted.id]);
      const payload = attachmentResponse(attachment);
      await recordAttachmentSyncChange(attachment, 'upsert');
      await broadcastNoteChange(noteId, 'updated');
      const noteAfterUpload = await get('SELECT revision FROM notes WHERE id = ?', [noteId]);
      const receiptPayload = { ...payload, noteRevision: Number(noteAfterUpload?.revision || 1) };
      await run(`INSERT INTO native_upload_receipts
        (userId, operationId, resourceType, resourceSyncId, noteId, contentHash, payload, state, createdAt, updatedAt)
        VALUES (?, ?, 'attachment', ?, ?, ?, ?, 'active', ?, ?)`,
      [req.user.id, operationId, syncId, noteId, contentHash, JSON.stringify(receiptPayload), now, now]);
      return { status: 201, payload: receiptPayload, fileRetained: true };
    });
  } catch (error) {
    fs.unlink(req.file.path, () => undefined);
    throw error;
  }
  if (!result.fileRetained) fs.unlink(req.file.path, () => undefined);
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(result.status).json(result.payload);
}));

app.get('/api/attachments/:attachmentId', requireAuth, asyncRoute(async (req, res) => {
  const attachmentId = Number(req.params.attachmentId);
  const attachment = await get(
    `SELECT na.*, n.ownerUserId, n.locked FROM note_attachments na
     JOIN notes n ON n.id = na.noteId
     LEFT JOIN note_collaborators nc ON nc.noteId = n.id AND nc.userId = ?
     WHERE na.id = ? AND (n.ownerUserId = ? OR nc.userId IS NOT NULL)`,
    [req.user.id, attachmentId, req.user.id]
  );

  if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });
  if (req.mcpToken && attachment.locked && !await mcpNoteIsUnlocked(req, attachment.noteId)) {
    return res.status(423).json({ error: 'Unlock this note before reading its attachments through MCP.' });
  }

  const filePath = attachmentPath(attachment.storedFilename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });

  // Serve with Content-Disposition to force download and show original filename
  res.setHeader('Content-Disposition', `attachment; filename="${safeDownloadName(attachment.originalName)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
}));

app.delete('/api/notes/:noteId/attachments/:attachmentId', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.noteId);
  const attachmentId = Number(req.params.attachmentId);

  const note = await getAccessibleNote(noteId, req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  if (req.mcpToken && note.locked && !await mcpNoteIsUnlocked(req, noteId)) {
    return res.status(423).json({ error: 'Unlock this note before deleting attachments through MCP.' });
  }

  const attachment = await get(
    `SELECT na.* FROM note_attachments na
     WHERE na.id = ? AND na.noteId = ?`,
    [attachmentId, noteId]
  );

  if (!attachment) return res.status(404).json({ error: 'Attachment not found.' });

  // Only the note owner can delete attachments
  if (note.ownerUserId !== req.user.id) {
    return res.status(403).json({ error: 'Only the note owner can delete attachments.' });
  }

  const filePath = attachmentPath(attachment.storedFilename);
  const recipients = await getNoteRecipientIds(noteId);
  const stamp = serverLwwStamp();
  attachment.syncId = attachment.syncId || `attachment-${crypto.randomUUID()}`;
  attachment.lwwPhysicalMs = stamp.physicalMs;
  attachment.lwwLogical = stamp.logical;
  attachment.lwwDeviceId = stamp.deviceId;
  attachment.lwwOperationId = stamp.operationId;
  const deleted = await withDatabaseTransaction(async () => {
    const current = await get('SELECT * FROM note_attachments WHERE id = ? AND noteId = ?', [attachmentId, noteId]);
    if (!current) return false;
    await run(`UPDATE native_upload_receipts SET state = 'deleted', updatedAt = ?
      WHERE userId = ? AND resourceType = 'attachment' AND resourceSyncId = ? AND state = 'active'`,
    [new Date().toISOString(), req.user.id, current.syncId || attachment.syncId]);
    await run('DELETE FROM note_attachments WHERE id = ?', [attachmentId]);
    await recordAttachmentSyncChange({ ...current, ...attachment }, 'delete', recipients);
    await broadcastNoteChange(noteId, 'updated');
    return true;
  });
  if (!deleted) return res.status(404).json({ error: 'Attachment not found.' });
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  res.status(204).end();
}));


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

async function syncSnapshotForUser(userId) {
  // One queue lease covers all reads and the cursor, so no committed change can
  // land between the document snapshot and its acknowledged feed position.
  return withDatabaseExclusive(async () => {
  const notes = await all(
    `SELECT notes.*,
            COALESCE(pos.sortOrder, notes.sortOrder) AS effectiveSortOrder,
            CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
            COALESCE(view_state.completedChecklistCollapsed, 0) AS completedChecklistCollapsed,
            lastEditor.displayName AS lastEditorDisplayName,
            (SELECT GROUP_CONCAT(nc.userId) FROM note_collaborators nc WHERE nc.noteId = notes.id) AS collaboratorIds
     FROM notes
     LEFT JOIN users lastEditor ON lastEditor.id = notes.lastEditorUserId
     LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
     LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
     LEFT JOIN user_note_view_states view_state ON view_state.noteId = notes.id AND view_state.userId = ?
     LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
     WHERE notes.ownerUserId = ? OR access.userId IS NOT NULL
     ORDER BY userPinned DESC, effectiveSortOrder DESC, notes.id DESC`,
    [userId, userId, userId, userId, userId]
  );
  await hitTestFault('after-bootstrap-notes-read');
  await hydrateNoteUserFields(notes, userId);
  const attachmentsByNoteId = new Map();
  if (notes.length) {
    for (const attachment of await accessibleAttachmentRows(userId)) {
      if (!attachmentsByNoteId.has(attachment.noteId)) attachmentsByNoteId.set(attachment.noteId, []);
      attachmentsByNoteId.get(attachment.noteId).push(attachmentResponse(attachment));
    }
  }
  const reminders = await all(`SELECT reminders.* FROM reminders
    WHERE reminders.userId = ? AND ${visibleReminderWhere}`, [userId]);
  const cursor = await syncCursorForUser(userId);
  return {
    notes: notes.map(row => {
      const note = dbNoteToApi(row);
      note.attachments = attachmentsByNoteId.get(row.id) || [];
      return note;
    }),
    reminders: await enrichReminderResponses(reminders),
    occurrences: await nativeOccurrencesForUser(userId),
    attachments: Array.from(attachmentsByNoteId.values()).flat(),
    cursor,
    serverTime: Date.now()
  };
  });
}

async function syncCursorForUser(userId) {
  const cursorRow = await get('SELECT COALESCE(MAX(sequence), 0) AS cursor FROM sync_changes WHERE userId = ?', [userId]);
  return Number(cursorRow?.cursor || 0);
}

app.get('/api/sync/bootstrap', requireAuth, asyncRoute(async (req, res) => {
  res.json(await syncSnapshotForUser(req.user.id));
}));

app.get('/api/sync/changes', requireAuth, asyncRoute(async (req, res) => {
  const { since, limit } = parseChangesQuery(req.query);
  const rows = await all(
    `SELECT * FROM sync_changes
     WHERE userId = ? AND sequence > ?
     ORDER BY sequence ASC
     LIMIT ?`,
    [req.user.id, since, limit]
  );
  const cursorRow = await get('SELECT COALESCE(MAX(sequence), 0) AS cursor FROM sync_changes WHERE userId = ?', [req.user.id]);
  const changes = [];
  for (const row of rows) {
    const change = {
      sequence: row.sequence,
      resourceType: row.resourceType,
      resourceSyncId: row.resourceSyncId,
      operation: row.operation,
      payload: parseJson(row.payload || 'null', null),
      lww: {
        physicalMs: Number(row.lwwPhysicalMs || 0),
        logical: Number(row.lwwLogical || 0),
        deviceId: row.lwwDeviceId || '',
        operationId: row.lwwOperationId || ''
      },
      changedAt: row.changedAt
    };
    if (change.resourceType === 'reminder' && change.operation !== 'delete') {
      const reminder = await get('SELECT * FROM reminders WHERE syncId = ? AND userId = ?', [change.resourceSyncId, req.user.id]);
      if (!reminder || !(await reminderIsVisibleToUser(reminder, req.user.id))) {
        change.operation = 'delete';
        change.payload = null;
      }
    }
    changes.push(change);
  }
  res.json({
    changes,
    cursor: rows.length ? Number(rows[rows.length - 1].sequence) : since,
    hasMore: rows.length === limit && Number(rows[rows.length - 1].sequence) < Number(cursorRow?.cursor || 0),
    serverCursor: Number(cursorRow?.cursor || 0),
    serverTime: Date.now()
  });
}));

async function applySyncNoteMutation(userId, mutation) {
  const type = String(mutation.type || '');
  const payload = mutation.payload || {};
  if (type === 'note.merge') return applySyncNoteMergeMutation(userId, mutation);
  if (type === 'note.patch') return applySyncNotePatchMutation(userId, mutation);
  if (type === 'note.view-state') {
    const syncId = String(mutation.syncId || payload.syncId || '');
    const row = await get('SELECT id FROM notes WHERE syncId = ? OR id = ?', [syncId, Number(payload.noteId || mutation.id || 0)]);
    if (!row) return { ok: false, status: 404, error: 'Note not found.', syncId };
    const note = await getAccessibleNote(row.id, userId);
    if (!note) return { ok: false, status: 404, error: 'Note not accessible.', syncId };
    const collapsed = payload.completedChecklistCollapsed === true ? 1 : 0;
    const now = new Date().toISOString();
    await run(`INSERT INTO user_note_view_states (userId, noteId, completedChecklistCollapsed, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(userId, noteId) DO UPDATE SET
        completedChecklistCollapsed = excluded.completedChecklistCollapsed, updatedAt = excluded.updatedAt`,
    [userId, row.id, collapsed, now]);
    await recordNoteSyncChange(row.id, 'upsert', [userId]);
    broadcastRealtime([userId], { type: 'notes-changed', action: 'updated', noteId: row.id });
    return { ok: true, resourceType: 'note-view-state', syncId, id: row.id,
      payload: { syncId, completedChecklistCollapsed: Boolean(collapsed), updatedAt: now } };
  }
  if (type === 'note.reorder') {
    const syncIds = Array.isArray(payload.syncIds) ? payload.syncIds.map(String).filter(Boolean) : [];
    const positions = parseOrderPositions(payload.positions);
    if (positions === false) return { ok: false, status: 400, error: 'Invalid note positions.', resourceType: 'note-order' };
    if (!syncIds.length && !positions?.length) return { ok: true, skipped: true, resourceType: 'note-order' };
    const updated = await applyNoteOrder(userId, positions ? { positions, by: 'syncId' } : { syncIds });
    return { ok: true, resourceType: 'note-order', updated };
  }
  // Only these types reach the upsert/delete path; an unknown `note.*` type from a newer client must not create a note.
  if (type !== 'note.upsert' && type !== 'note.delete') return { ok: false, status: 400, error: 'Unsupported mutation type.', type };
  const syncId = String(mutation.syncId || payload.syncId || payload.clientId || `note-${crypto.randomUUID()}`);
  const guarded = Object.prototype.hasOwnProperty.call(mutation, 'baseRevision');
  const incomingStamp = guarded ? serverLwwStamp() : normalizeLwwStamp(mutation.lww || payload);
  const existing = await get('SELECT * FROM notes WHERE syncId = ? OR id = ?', [syncId, Number(payload.id || mutation.id || 0)]);
  if (guarded && (!Number.isSafeInteger(mutation.baseRevision) || mutation.baseRevision < 0)) {
    return { ok: false, status: 400, error: 'A non-negative integer baseRevision is required.', syncId };
  }
  if (existing && !(await getAccessibleNote(existing.id, userId))) return { ok: false, status: 403, error: 'Note not accessible.', syncId };
  if (guarded && (existing ? existing.revision !== mutation.baseRevision : mutation.baseRevision !== 0)) {
    return noteRevisionConflict(userId, existing?.id, syncId);
  }
  if (!guarded && existing && compareLwwStamp(incomingStamp, rowLwwStamp(existing)) < 0) {
    return { ok: true, skipped: true, resourceType: 'note', syncId, id: existing.id };
  }
  if (type === 'note.delete') {
    const note = existing ? await getAccessibleNote(existing.id, userId) : null;
    if (!note) return { ok: true, skipped: true, resourceType: 'note', syncId };
    if (note.ownerUserId !== userId) return { ok: false, status: 403, error: 'Only the owner can delete a note.', syncId };
    if (guarded) return { ok: false, status: 400, error: 'Use an archived or trashed note update before permanent deletion.', syncId };
    const recipients = await getNoteRecipientIds(note.id);
    await recordDependentSyncDeletesForNote(note.id, recipients);
    await deleteAttachmentFilesForNote(note.id);
    await deleteImageFilesForNote(note.id);
    await run('DELETE FROM notes WHERE id = ?', [note.id]);
    await recordNoteSyncChange(note.id, 'delete', recipients, {
      syncId,
      lwwPhysicalMs: incomingStamp.physicalMs,
      lwwLogical: incomingStamp.logical,
      lwwDeviceId: incomingStamp.deviceId,
      lwwOperationId: incomingStamp.operationId
    });
    broadcastRealtime(recipients, { type: 'notes-changed', action: 'deleted', noteId: note.id });
    return { ok: true, resourceType: 'note', syncId, id: note.id, deleted: true };
  }

  const noteData = canonicalizeNotePayload(payload);
  const now = new Date().toISOString();
  if (!existing) {
    const result = await run(
      `INSERT INTO notes
       (ownerUserId, syncId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, binder, extraFields, locked, lockSalt, lockHash, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, lastEditorUserId, isDemo,
        lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        syncId,
        String(noteData.noteTitle || ''),
        noteData.noteBody || '',
        noteData.bgColor || '',
        noteData.bgImage || '',
        JSON.stringify(noteData.checkBoxes || []),
        JSON.stringify(noteData.images || []),
         noteData.isCbox ? 1 : 0,
         JSON.stringify(noteData.labels || []),
         noteData.binder || '',
         JSON.stringify(noteData.extraFields || {}),
         noteData.locked ? 1 : 0,
        noteData.lockSalt || '',
        noteData.lockHash || '',
        noteData.archived ? 1 : 0,
        noteData.trashed ? 1 : 0,
        noteData.trashed ? now : null,
        clampClientSortOrder(payload.sortOrder),
        payload.createdAt || now,
        now,
        userId,
        noteData.isDemo ? 1 : 0,
        incomingStamp.physicalMs,
        incomingStamp.logical,
        incomingStamp.deviceId,
        incomingStamp.operationId
      ]
    );
    if (noteData.pinned) await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [userId, result.id]);
    await syncNoteImagesForNote(result.id, userId, noteData);
    await recordNoteSyncChange(result.id, 'upsert', [userId]);
    broadcastRealtime([userId], { type: 'notes-changed', action: 'created', noteId: result.id, syncId });
    return { ok: true, resourceType: 'note', syncId, id: result.id, payload: dbNoteToApi(await getAccessibleNote(result.id, userId)) };
  }

  const note = await getAccessibleNote(existing.id, userId);
  if (!note) return { ok: false, status: 403, error: 'Note not accessible.', syncId };
  const isOwner = note.ownerUserId === userId;
  const shouldPinForUser = Object.prototype.hasOwnProperty.call(payload, 'pinned')
    ? !!payload.pinned
    : !!note.userPinned;
  if (!Object.prototype.hasOwnProperty.call(payload, 'binder')) {
    noteData.binder = note.binder || '';
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'locked')) {
    noteData.locked = Boolean(note.locked);
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'lockSalt')) {
    noteData.lockSalt = note.lockSalt || '';
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'lockHash')) {
    noteData.lockHash = note.lockHash || '';
  }
  if (!isOwner) {
    noteData.bgColor = note.bgColor || '';
    noteData.bgImage = note.bgImage || '';
    noteData.labels = parseJson(note.labels, []);
    noteData.binder = note.binder || '';
    noteData.archived = Boolean(note.archived);
    noteData.trashed = Boolean(note.trashed);
    // Preserve the owner/global note value; the requester's pin state lives in user_pins.
    noteData.pinned = Boolean(note.pinned);
    noteData.locked = Boolean(note.locked);
    noteData.lockSalt = note.lockSalt || '';
    noteData.lockHash = note.lockHash || '';
  }
  const storedExtraFields = parseJson(note.extraFields || '{}', {});
  noteData.extraFields = isOwner
    ? { ...storedExtraFields, ...noteData.extraFields }
    : storedExtraFields;
  const trashedAt = nextTrashedAt(note, noteData);
  const updated = await run(
    `UPDATE notes SET
      noteTitle = ?, noteBody = ?, bgColor = ?, bgImage = ?,
      checkBoxes = ?, images = ?, isCbox = ?, labels = ?, binder = ?, extraFields = ?, locked = ?, lockSalt = ?, lockHash = ?, archived = ?, trashed = ?, trashedAt = ?, updatedAt = ?, lastEditorUserId = ?, isDemo = ?,
      lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?, lwwOperationId = ?
     WHERE id = ?${guarded ? ' AND revision = ?' : ''}`,
    [
      String(noteData.noteTitle || ''),
      noteData.noteBody || '',
      noteData.bgColor || '',
      noteData.bgImage || '',
      JSON.stringify(noteData.checkBoxes || []),
      JSON.stringify(noteData.images || []),
      noteData.isCbox ? 1 : 0,
      JSON.stringify(noteData.labels || []),
      noteData.binder || '',
      JSON.stringify(noteData.extraFields || {}),
      noteData.locked ? 1 : 0,
      noteData.lockSalt || '',
      noteData.lockHash || '',
      noteData.archived ? 1 : 0,
      noteData.trashed ? 1 : 0,
      trashedAt,
      now,
      userId,
      noteData.isDemo ? 1 : 0,
      incomingStamp.physicalMs,
      incomingStamp.logical,
      incomingStamp.deviceId,
      incomingStamp.operationId,
      note.id,
      ...(guarded ? [mutation.baseRevision] : [])
    ]
  );
  if (!updated.changes) return noteRevisionConflict(userId, note.id, syncId);
  if (shouldPinForUser) await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [userId, note.id]);
  else await run('DELETE FROM user_pins WHERE userId = ? AND noteId = ?', [userId, note.id]);
  await syncNoteImagesForNote(note.id, note.ownerUserId, noteData);
  await cleanupUnusedLabels(userId);
  await broadcastNoteChange(note.id, 'updated', undefined, { preserveStamp: true });
  return { ok: true, resourceType: 'note', syncId, id: note.id, payload: dbNoteToApi(await getAccessibleNote(note.id, userId)) };
}

async function applySyncNotePatchMutation(userId, mutation) {
  const payload = mutation.payload || {};
  const syncId = String(mutation.syncId || payload.syncId || '');
  const patch = payload.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, status: 400, error: 'A note patch object is required.', syncId };
  }
  const patchableFields = new Set([
    'noteTitle', 'noteBody', 'bgColor', 'bgImage', 'checkBoxes', 'images', 'isCbox', 'labels',
    'binder', 'locked', 'lockSalt', 'lockHash', 'archived', 'trashed', 'pinned', 'isDemo'
  ]);
  const keys = Object.keys(patch);
  if (keys.some(key => !patchableFields.has(key))) {
    return { ok: false, status: 400, error: 'The patch contains an unsupported note field.', syncId };
  }
  const row = await get('SELECT id FROM notes WHERE syncId = ? OR id = ?', [syncId, Number(payload.id || mutation.id || 0)]);
  if (!row) return { ok: false, status: 404, error: 'Note not found.', syncId };
  const existing = await getAccessibleNote(row.id, userId);
  if (!existing) return { ok: false, status: 404, error: 'Note not accessible.', syncId };
  if (!keys.length) {
    return { ok: true, skipped: true, resourceType: 'note', syncId: existing.syncId, id: existing.id };
  }

  const isOwner = existing.ownerUserId === userId;
  const next = canonicalizeNotePayload({ ...dbNoteToApi(existing), ...patch });
  const shouldPinForUser = Object.prototype.hasOwnProperty.call(patch, 'pinned')
    ? !!patch.pinned
    : !!existing.userPinned;
  if (!isOwner) {
    next.bgColor = existing.bgColor || '';
    next.bgImage = existing.bgImage || '';
    next.labels = parseJson(existing.labels, []);
    next.binder = existing.binder || '';
    next.archived = Boolean(existing.archived);
    next.trashed = Boolean(existing.trashed);
    next.pinned = Boolean(existing.pinned);
    next.locked = Boolean(existing.locked);
    next.lockSalt = existing.lockSalt || '';
    next.lockHash = existing.lockHash || '';
  }
  const trashedAt = nextTrashedAt(existing, next);
  await run(
    `UPDATE notes SET
      noteTitle = ?, noteBody = ?, bgColor = ?, bgImage = ?, checkBoxes = ?, images = ?, isCbox = ?,
      labels = ?, binder = ?, extraFields = ?, locked = ?, lockSalt = ?, lockHash = ?, archived = ?, trashed = ?,
      trashedAt = ?, updatedAt = ?, lastEditorUserId = ?, isDemo = ?
     WHERE id = ?`,
    [
      String(next.noteTitle || ''),
      next.noteBody || '',
      next.bgColor || '',
      next.bgImage || '',
      JSON.stringify(next.checkBoxes || []),
      JSON.stringify(next.images || []),
      next.isCbox ? 1 : 0,
      JSON.stringify(next.labels || []),
      next.binder || '',
      JSON.stringify(noteExtraFields(next)),
      next.locked ? 1 : 0,
      next.lockSalt || '',
      next.lockHash || '',
      next.archived ? 1 : 0,
      next.trashed ? 1 : 0,
      trashedAt,
      new Date().toISOString(),
      userId,
      next.isDemo ? 1 : 0,
      existing.id
    ]
  );
  if (shouldPinForUser) {
    await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [userId, existing.id]);
  } else {
    await run('DELETE FROM user_pins WHERE userId = ? AND noteId = ?', [userId, existing.id]);
  }
  if (keys.some(key => ['noteBody', 'images', 'bgImage'].includes(key))) {
    await syncNoteImagesForNote(existing.id, existing.ownerUserId, next);
  }
  await broadcastNoteChange(existing.id, 'updated');
  await cleanupUnusedLabels(userId);
  // The acknowledged revision lets a client chain a guarded save behind this patch.
  const patched = await get('SELECT revision FROM notes WHERE id = ?', [existing.id]);
  return {
    ok: true,
    resourceType: 'note',
    syncId: existing.syncId || syncId,
    id: existing.id,
    revision: Number(patched?.revision || 1)
  };
}

async function applySyncNoteMergeMutation(userId, mutation) {
  const payload = mutation.payload || {};
  const mergeSyncId = String(payload.mergeSyncId || mutation.syncId || '');
  const sourceSyncIds = Array.isArray(payload.orderedSourceSyncIds)
    ? payload.orderedSourceSyncIds.map(value => String(value || '')).filter(Boolean)
    : [];
  if (!mergeSyncId || mergeSyncId.length > 160 || sourceSyncIds.length < 2
      || new Set(sourceSyncIds).size !== sourceSyncIds.length) {
    return { ok: false, status: 400, error: 'A merge identity and at least two unique source note identities are required.' };
  }

  let existingMerge = await get('SELECT * FROM notes WHERE syncId = ?', [mergeSyncId]);
  if (existingMerge && existingMerge.ownerUserId !== userId) {
    return { ok: false, status: 403, error: 'The merged note identity is not available to this user.', syncId: mergeSyncId };
  }
  const sourcePlaceholders = sourceSyncIds.map(() => '?').join(',');
  const sourceRows = await all(
    `SELECT * FROM notes WHERE syncId IN (${sourcePlaceholders}) AND ownerUserId = ?`,
    [...sourceSyncIds, userId]
  );
  if (sourceRows.length !== sourceSyncIds.length) {
    return { ok: false, status: 403, error: 'You can only merge notes you own.', syncId: mergeSyncId };
  }
  const sourcesBySyncId = new Map(sourceRows.map(row => [row.syncId, row]));
  const sourceNotes = sourceSyncIds.map(syncId => sourcesBySyncId.get(syncId));
  if (sourceNotes.some(note => !note)) {
    return { ok: false, status: 404, error: 'One or more source notes were not found.', syncId: mergeSyncId };
  }
  const sourceIds = sourceNotes.map(note => note.id);
  const sourceIdPlaceholders = sourceIds.map(() => '?').join(',');
  const apiNotes = sourceNotes.map(dbNoteToApi);
  const sourceRecipients = new Set([userId]);
  for (const sourceId of sourceIds) {
    (await getNoteRecipientIds(sourceId)).forEach(recipient => sourceRecipients.add(recipient));
  }

  // A client may have queued a normal upsert for the optimistic merged note
  // before the merge command is sent. Reuse that identity and still perform
  // the source/resource transaction exactly once.
  const alreadyMaterialized = !!existingMerge;
  if (!existingMerge) {
    const mergedTitle = apiNotes.find(note => note.noteTitle && note.noteTitle.trim())?.noteTitle || '';
    const mergedBgColor = apiNotes.find(note => note.bgColor)?.bgColor || '';
    const hasRealBgImage = value => !!value && value !== 'url("")' && value !== 'url()';
    const mergedBgImage = apiNotes.find(note => hasRealBgImage(note.bgImage))?.bgImage || '';
    const bodyParts = [];
    const mergedCheckBoxes = [];
    const mergedImages = [];
    const labelMap = new Map();
    for (const note of apiNotes) {
      if (note.noteBody && note.noteBody.trim()) bodyParts.push(note.noteBody);
      for (const checkbox of note.checkBoxes || []) mergedCheckBoxes.push(checkbox);
      for (const image of note.images || []) {
        const flattened = image.id === 'drawing'
          ? { ...image, id: `drawing-flat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: (image.name || '').replace(/^Drawing\|/, '') }
          : image;
        mergedImages.push(flattened);
      }
      for (const label of note.labels || []) {
        if (label.id && !labelMap.has(label.id)) labelMap.set(label.id, label);
      }
    }
    const mergedBody = bodyParts.join('<br><br>');
    const mergedLabels = Array.from(labelMap.values());
    const mergedBinder = apiNotes.find(note => note.binder)?.binder || '';
    const mergedLock = apiNotes.find(note => note.locked && note.lockSalt && note.lockHash);
    const mergedExtraFields = Object.assign({}, ...apiNotes.slice().reverse().map(noteExtraFields));
    const mergedIsCbox = mergedCheckBoxes.length > 0 ? 1 : 0;
    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO notes
       (ownerUserId, syncId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, binder, extraFields,
        locked, lockSalt, lockHash, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, lastEditorUserId, isDemo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?, 0)`,
      [
        userId,
        mergeSyncId,
        String(mergedTitle || ''),
        mergedBody,
        mergedBgColor,
        mergedBgImage,
        JSON.stringify(mergedCheckBoxes),
        JSON.stringify(mergedImages),
        mergedIsCbox,
        JSON.stringify(mergedLabels),
        mergedBinder,
        JSON.stringify(mergedExtraFields),
        mergedLock ? 1 : 0,
        mergedLock?.lockSalt || '',
        mergedLock?.lockHash || '',
        Date.now(),
        now,
        now,
        userId
      ]
    );
    existingMerge = await get('SELECT * FROM notes WHERE id = ?', [result.id]);
    await syncNoteImagesForNote(result.id, userId, { noteBody: mergedBody, images: mergedImages });
  }

  const mergedNoteId = existingMerge.id;
  const sourceAttachments = await all(`SELECT * FROM note_attachments WHERE noteId IN (${sourceIdPlaceholders})`, sourceIds);
  await run(
    `UPDATE note_attachments SET noteId = ? WHERE noteId IN (${sourceIdPlaceholders})`,
    [mergedNoteId, ...sourceIds]
  );
  for (const attachment of sourceAttachments) {
    await recordAttachmentSyncChange({ ...attachment, noteId: mergedNoteId }, 'upsert', [userId]);
    for (const recipient of sourceRecipients) {
      if (recipient !== userId) await recordAttachmentSyncChange(attachment, 'delete', [recipient]);
    }
  }

  const pendingReminders = await all(
    `SELECT id, dueAtUtc FROM reminders
     WHERE userId = ? AND status = 'pending' AND noteId IN (${sourceIdPlaceholders})
     ORDER BY dueAtUtc ASC`,
    [userId, ...sourceIds]
  );
  if (pendingReminders.length > 0) {
    const keepId = pendingReminders[0].id;
    await run('UPDATE reminders SET noteId = ?, updatedAt = ? WHERE id = ?', [mergedNoteId, new Date().toISOString(), keepId]);
    const kept = await get('SELECT * FROM reminders WHERE id = ?', [keepId]);
    await recordReminderSyncChange(kept);
    if (pendingReminders.length > 1) {
      const dropped = pendingReminders.slice(1);
      const droppedPlaceholders = dropped.map(() => '?').join(',');
      const droppedRows = await all(`SELECT * FROM reminders WHERE id IN (${droppedPlaceholders})`, dropped.map(row => row.id));
      await run(`DELETE FROM reminders WHERE id IN (${droppedPlaceholders})`, dropped.map(row => row.id));
      for (const reminder of droppedRows) await recordReminderSyncChange(reminder, 'delete');
      const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [userId]);
      afterDatabaseCommit(async () => {
        for (const reminder of droppedRows) {
          if (caldav) {
            deleteReminderFromCaldav(caldav, reminder.id).catch(error => console.error('CalDAV delete failed during merge:', error.message));
          }
          gcalDeleteReminder(userId, reminder).catch(error => console.error('GCal delete failed during merge:', error.message));
        }
      });
    }
  }

  const now = new Date().toISOString();
  await run(
    `UPDATE notes SET trashed = 1, trashedAt = ?, updatedAt = ?, lastEditorUserId = ? WHERE id IN (${sourceIdPlaceholders})`,
    [now, now, userId, ...sourceIds]
  );
  await run(`DELETE FROM user_pins WHERE userId = ? AND noteId IN (${sourceIdPlaceholders})`, [userId, ...sourceIds]);

  await broadcastNoteChange(mergedNoteId, alreadyMaterialized ? 'updated' : 'created', [userId], { syncId: mergeSyncId });
  for (const sourceId of sourceIds) {
    await broadcastNoteChange(sourceId, 'updated', Array.from(sourceRecipients));
  }
  return { ok: true, resourceType: 'note.merge', syncId: mergeSyncId, id: mergedNoteId };
}

async function applySyncReminderMutation(userId, mutation) {
  const type = String(mutation.type || '');
  const payload = mutation.payload || {};
  const syncId = String(mutation.syncId || payload.syncId || `reminder-${crypto.randomUUID()}`);
  const incomingStamp = normalizeLwwStamp(mutation.lww || payload);
  let existing = await get('SELECT * FROM reminders WHERE syncId = ? OR id = ?', [syncId, Number(payload.id || mutation.id || 0)]);
  if (existing && existing.userId !== userId) return { ok: false, status: 403, error: 'Reminder not accessible.', syncId };
  if (existing && type !== 'reminder.delete' && !(await reminderIsVisibleToUser(existing, userId))) {
    return { ok: false, status: 404, error: 'The linked note is no longer accessible.', syncId };
  }
  if (existing && mutation.baseScheduleVersion !== undefined && Number(existing.scheduleVersion || 1) !== Number(mutation.baseScheduleVersion)) {
    return { ok: false, status: 409, error: 'Reminder schedule changed.', syncId, latest: await enrichReminderResponse(existing) };
  }
  if (existing && compareLwwStamp(incomingStamp, rowLwwStamp(existing)) < 0) {
    return { ok: true, skipped: true, resourceType: 'reminder', syncId, id: existing.id };
  }
  if (type === 'reminder.delete') {
    if (!existing || existing.userId !== userId) return { ok: true, skipped: true, resourceType: 'reminder', syncId };
    await run('DELETE FROM reminders WHERE id = ?', [existing.id]);
    await recordReminderSyncChange({
      ...existing,
      syncId,
      lwwPhysicalMs: incomingStamp.physicalMs,
      lwwLogical: incomingStamp.logical,
      lwwDeviceId: incomingStamp.deviceId,
      lwwOperationId: incomingStamp.operationId
    }, 'delete');
    return { ok: true, resourceType: 'reminder', syncId, id: existing.id, deleted: true };
  }
  const normalized = normalizeReminderPayload(payload, existing || {});
  if ((!normalized.noteId || normalized.noteId < 0) && payload.noteSyncId) {
    const noteBySyncId = await get(
      `SELECT notes.id FROM notes
       LEFT JOIN note_collaborators nc ON nc.noteId = notes.id AND nc.userId = ?
       WHERE notes.syncId = ? AND (notes.ownerUserId = ? OR nc.userId IS NOT NULL)`,
      [userId, String(payload.noteSyncId), userId]
    );
    normalized.noteId = noteBySyncId?.id || null;
    if (!normalized.noteId) {
      return {
        ok: false,
        status: 409,
        retryable: true,
        error: 'The reminder is waiting for its note to synchronize.',
        syncId
      };
    }
  }
  if (!normalized.dueAtUtc && !normalized.locationName) return { ok: false, status: 400, error: 'Either dueAtUtc or locationName is required.', syncId };
  if (normalized.dueAtUtc && !Number.isFinite(Date.parse(normalized.dueAtUtc))) return { ok: false, status: 400, error: 'dueAtUtc must be a valid date.', syncId };
  if (normalized.locationName && (normalized.latitude == null || normalized.longitude == null)) return { ok: false, status: 400, error: 'Location reminders require latitude and longitude.', syncId };
  if (normalized.noteId) {
    const note = await getAccessibleNote(normalized.noteId, userId);
    if (!note) return { ok: false, status: 404, error: 'Note not found.', syncId };
  }
  if (!existing && normalized.noteId) {
    existing = await get('SELECT * FROM reminders WHERE userId = ? AND noteId = ?', [userId, normalized.noteId]);
    if (existing && mutation.baseScheduleVersion !== undefined && Number(existing.scheduleVersion || 1) !== Number(mutation.baseScheduleVersion)) {
      return { ok: false, status: 409, error: 'Reminder schedule changed.', syncId, latest: await enrichReminderResponse(existing) };
    }
    if (existing && compareLwwStamp(incomingStamp, rowLwwStamp(existing)) < 0) {
      return { ok: true, skipped: true, resourceType: 'reminder', syncId: existing.syncId, id: existing.id };
    }
  }
  const now = new Date().toISOString();
  let scheduleChanged = existing ? reminderScheduleChanged(existing, normalized) : false;
  if (existing && mutation.baseScheduleVersion !== undefined) {
    const currentVersion = Number(existing.scheduleVersion || 1);
    const requestedVersion = payload.scheduleVersion === undefined ? currentVersion : Number(payload.scheduleVersion);
    if (!Number.isSafeInteger(requestedVersion) || requestedVersion < currentVersion || requestedVersion > currentVersion + 1) {
      return { ok: false, status: 409, error: 'Reminder schedule version is invalid.', syncId, latest: await enrichReminderResponse(existing) };
    }
    scheduleChanged = requestedVersion === currentVersion + 1;
    if (!scheduleChanged) {
      normalized.dueAtUtc = existing.dueAtUtc;
      normalized.timezone = existing.timezone;
      normalized.repeatRule = existing.repeatRule;
    }
  }
  const scheduleVersion = existing
    ? Number(existing.scheduleVersion || 1) + (scheduleChanged ? 1 : 0)
    : 1;
  const scheduleAnchorAtUtc = scheduleChanged
    ? normalized.dueAtUtc
    : (existing?.scheduleAnchorAtUtc || existing?.dueAtUtc || normalized.dueAtUtc);
  let reminder;
  if (existing) {
    reminder = await get(
      `UPDATE reminders SET
         noteId = ?, userId = ?, dueAtUtc = ?, timezone = ?, repeatRule = ?, status = ?,
         title = ?, body = ?, imageUrl = ?, locationName = ?, latitude = ?, longitude = ?,
         radiusMeters = ?, locationTrigger = ?, scheduleVersion = ?, scheduleAnchorAtUtc = ?, updatedAt = ?,
         lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?, lwwOperationId = ?
       WHERE id = ? AND scheduleVersion = ?
       RETURNING *`,
      [
        normalized.noteId,
        userId,
        normalized.dueAtUtc,
        normalized.timezone,
        normalized.repeatRule,
        normalized.status || 'pending',
        normalized.title,
        normalized.body,
        normalized.imageUrl,
        normalized.locationName,
        normalized.latitude,
        normalized.longitude,
        normalized.radiusMeters,
        normalized.locationTrigger,
        scheduleVersion,
        scheduleAnchorAtUtc,
        now,
        incomingStamp.physicalMs,
        incomingStamp.logical,
        incomingStamp.deviceId,
        incomingStamp.operationId,
        existing.id,
        Number(existing.scheduleVersion || 1)
      ]
    );
    if (!reminder) return { ok: false, status: 409, error: 'Reminder schedule changed.', syncId,
      latest: await enrichReminderResponse(await get('SELECT * FROM reminders WHERE id = ?', [existing.id])) };
  } else {
    reminder = await get(
    `INSERT INTO reminders (noteId, userId, dueAtUtc, timezone, repeatRule, status, title, body, imageUrl, locationName, latitude, longitude, radiusMeters, locationTrigger, scheduleVersion, scheduleAnchorAtUtc, createdAt, updatedAt, syncId, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(userId, noteId) DO UPDATE SET
       userId = excluded.userId,
       dueAtUtc = excluded.dueAtUtc,
       timezone = excluded.timezone,
       repeatRule = excluded.repeatRule,
       status = excluded.status,
       title = excluded.title,
       body = excluded.body,
       imageUrl = excluded.imageUrl,
       locationName = excluded.locationName,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
        radiusMeters = excluded.radiusMeters,
        locationTrigger = excluded.locationTrigger,
        scheduleAnchorAtUtc = CASE
          WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
          THEN excluded.scheduleAnchorAtUtc ELSE COALESCE(reminders.scheduleAnchorAtUtc, reminders.dueAtUtc) END,
        scheduleVersion = reminders.scheduleVersion + CASE
          WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
          THEN 1 ELSE 0 END,
        updatedAt = excluded.updatedAt,
       syncId = COALESCE(reminders.syncId, excluded.syncId),
       lwwPhysicalMs = excluded.lwwPhysicalMs,
       lwwLogical = excluded.lwwLogical,
       lwwDeviceId = excluded.lwwDeviceId,
       lwwOperationId = excluded.lwwOperationId
     RETURNING *`,
    [
      normalized.noteId,
      userId,
      normalized.dueAtUtc,
      normalized.timezone,
      normalized.repeatRule,
      normalized.status || 'pending',
      normalized.title,
      normalized.body,
      normalized.imageUrl,
      normalized.locationName,
      normalized.latitude,
       normalized.longitude,
       normalized.radiusMeters,
       normalized.locationTrigger,
       scheduleVersion,
       scheduleAnchorAtUtc,
       payload.createdAt || now,
      now,
      syncId,
      incomingStamp.physicalMs,
      incomingStamp.logical,
      incomingStamp.deviceId,
      incomingStamp.operationId
    ]
  );
  }
  await recordReminderSyncChange(reminder, 'upsert');
  return { ok: true, resourceType: 'reminder', syncId: reminder.syncId, id: reminder.id, payload: await enrichReminderResponse(reminder) };
}

async function applySyncAttachmentMutation(userId, mutation) {
  const type = String(mutation.type || '');
  const payload = mutation.payload || {};
  const syncId = String(mutation.syncId || payload.syncId || '');
  if (type !== 'attachment.delete' || !syncId) return { ok: false, status: 400, error: 'Unsupported attachment mutation.', syncId };
  const attachment = await get(
    `SELECT na.* FROM note_attachments na
     JOIN notes n ON n.id = na.noteId
     WHERE na.syncId = ? AND n.ownerUserId = ?`,
    [syncId, userId]
  );
  if (!attachment) return { ok: true, skipped: true, resourceType: 'attachment', syncId };
  const incomingStamp = normalizeLwwStamp(mutation.lww || payload);
  if (compareLwwStamp(incomingStamp, rowLwwStamp(attachment)) < 0) {
    return { ok: true, skipped: true, resourceType: 'attachment', syncId, id: attachment.id };
  }
  const recipients = await getNoteRecipientIds(attachment.noteId);
  const filePath = attachmentPath(attachment.storedFilename);
  await run(`UPDATE native_upload_receipts SET state = 'deleted', updatedAt = ?
    WHERE userId = ? AND resourceType = 'attachment' AND resourceSyncId = ? AND state = 'active'`,
  [new Date().toISOString(), userId, syncId]);
  afterDatabaseCommit(() => { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); });
  await run('DELETE FROM note_attachments WHERE id = ?', [attachment.id]);
  await recordAttachmentSyncChange({
    ...attachment,
    lwwPhysicalMs: incomingStamp.physicalMs,
    lwwLogical: incomingStamp.logical,
    lwwDeviceId: incomingStamp.deviceId,
    lwwOperationId: incomingStamp.operationId
  }, 'delete', recipients);
  await broadcastNoteChange(attachment.noteId, 'updated');
  return { ok: true, resourceType: 'attachment', syncId, id: attachment.id, deleted: true };
}

async function noteRevisionConflict(userId, noteId, syncId) {
  const latest = noteId ? await getAccessibleNote(noteId, userId) : null;
  return { ok: false, status: 409, error: 'The note changed since this draft was opened.',
    resourceType: 'note', syncId, latest: latest ? dbNoteToApi(latest) : null };
}

// Serialize retries of the same operation, not independent note edits. Note edits
// themselves are guarded by an atomic SQL revision predicate.
const nativeOperationsInFlight = new Map();
async function executeSyncMutation(userId, mutation) {
  const operationId = mutation.operationId;
  if (operationId !== undefined && (typeof operationId !== 'string' || !operationId || operationId.length > 160)) {
    return { ok: false, status: 400, error: 'Invalid operationId.' };
  }
  const key = operationId ? `${userId}:${operationId}` : null;
  if (key && nativeOperationsInFlight.has(key)) {
    await nativeOperationsInFlight.get(key);
    return executeSyncMutation(userId, mutation);
  }
  let release;
  if (key) nativeOperationsInFlight.set(key, new Promise(resolve => { release = resolve; }));
  try {
    const result = await withDatabaseTransaction(async () => {
      await hitTestFault('before-mutation');
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(mutation)).digest('hex');
      if (key) {
        const stored = await get('SELECT * FROM native_mutation_results WHERE userId = ? AND operationId = ?', [userId, operationId]);
        if (stored) {
          if (stored.fingerprint !== fingerprint) return { ok: false, status: 409, error: 'operationId was already used for a different change.' };
          return replaySafeMutationResult(userId, JSON.parse(stored.result));
        }
      }
      const type = String(mutation.type || '');
      let result;
      if (type === 'reminder.action') result = await applyReminderOccurrenceAction(userId, mutation.payload || {});
      else if (type.startsWith('note.')) result = await applySyncNoteMutation(userId, mutation);
      else if (type === 'reminder.upsert' || type === 'reminder.delete') result = await applySyncReminderMutation(userId, mutation);
      else if (type.startsWith('attachment.')) result = await applySyncAttachmentMutation(userId, mutation);
      else result = { ok: false, status: 400, error: 'Unsupported mutation type.', type };
      await hitTestFault('after-mutation-before-receipt');
      if (key && result.ok) {
        await run('INSERT INTO native_mutation_results (userId, operationId, fingerprint, result, createdAt) VALUES (?, ?, ?, ?, ?)',
          [userId, operationId, fingerprint, JSON.stringify(result), new Date().toISOString()]);
      }
      return result;
    });
    await hitTestFault('after-receipt-before-response');
    return result;
  } finally {
    if (key) { nativeOperationsInFlight.delete(key); release(); }
  }
}

async function replaySafeMutationResult(userId, result) {
  if (result?.resourceType !== 'reminder' || !result.syncId) return result;
  const reminder = await get('SELECT * FROM reminders WHERE syncId = ? AND userId = ?', [result.syncId, userId]);
  if (!reminder || !(await reminderIsVisibleToUser(reminder, userId))) {
    const { payload, ...acknowledgement } = result;
    return { ...acknowledgement, ok: true, replayed: true };
  }
  return { ...result, payload: await enrichReminderResponse(reminder) };
}

async function persistReminderOccurrence(reminder) {
  if (!reminder.syncId || !reminder.dueAtUtc) return;
  const id = occurrenceId(reminder);
  const payload = { ...reminder, occurrenceId: id, scheduleVersion: Number(reminder.scheduleVersion || 1) };
  await run(`INSERT OR IGNORE INTO reminder_occurrences
    (occurrenceId, userId, reminderSyncId, dueAtUtc, payload, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, reminder.userId, reminder.syncId, reminder.dueAtUtc, JSON.stringify(payload), new Date().toISOString()]);
  await run("DELETE FROM reminder_occurrences WHERE createdAt < datetime('now', '-30 days')");
}

async function nativeOccurrencesForUser(userId) {
  const rows = await all(`SELECT o.* FROM reminder_occurrences o
    JOIN reminders r ON r.syncId = o.reminderSyncId AND r.userId = o.userId
    LEFT JOIN notes n ON n.id = r.noteId
    WHERE o.userId = ? AND (r.noteId IS NULL OR (n.id IS NOT NULL AND n.archived = 0 AND n.trashed = 0
      AND (n.ownerUserId = ? OR EXISTS (SELECT 1 FROM note_collaborators c WHERE c.noteId = n.id AND c.userId = ?))))
      AND r.status != 'dismissed'
    ORDER BY o.dueAtUtc DESC LIMIT 2000`, [userId, userId, userId]);
  return rows.map(row => ({ ...JSON.parse(row.payload), occurrenceId: row.occurrenceId,
    state: row.state, snoozeUntil: row.snoozeUntil }));
}

async function applyReminderOccurrenceAction(userId, payload) {
  if (!['dismissed', 'snoozed'].includes(payload.state)) return { ok: false, status: 400, error: 'Invalid reminder action.' };
  const occurrenceKey = String(payload.occurrenceId || '');
  const existingOccurrence = await get('SELECT * FROM reminder_occurrences WHERE occurrenceId = ? AND userId = ?', [occurrenceKey, userId]);
  const reminderSyncId = String(payload.reminderSyncId || existingOccurrence?.reminderSyncId || '');
  const reminder = await get('SELECT * FROM reminders WHERE syncId = ? AND userId = ?', [reminderSyncId, userId]);
  if (!reminder || reminder.status === 'dismissed') return { ok: false, status: 409, error: 'Reminder occurrence is no longer available.' };
  const scheduleVersion = Number(reminder.scheduleVersion || 1);
  if (payload.scheduleVersion !== undefined && Number(payload.scheduleVersion) !== scheduleVersion) {
    return { ok: false, status: 409, error: 'Reminder occurrence belongs to an older schedule.' };
  }
  const prefix = `${reminderSyncId}@`;
  const suffix = `#v${scheduleVersion}`;
  if (!occurrenceKey.startsWith(prefix) || !occurrenceKey.endsWith(suffix)) {
    return { ok: false, status: 409, error: 'Reminder occurrence identity is invalid.' };
  }
  const occurrenceDueAtUtc = normalizeReminderDueAt(occurrenceKey.slice(prefix.length, -suffix.length));
  if (!occurrenceDueAtUtc || !Number.isFinite(Date.parse(occurrenceDueAtUtc)) ||
      occurrenceId({ syncId: reminderSyncId, dueAtUtc: occurrenceDueAtUtc, scheduleVersion }) !== occurrenceKey ||
      Date.parse(occurrenceDueAtUtc) > Date.now() ||
      !isRepeatOccurrence(reminder.scheduleAnchorAtUtc || reminder.dueAtUtc, occurrenceDueAtUtc,
        parseRepeatRule(reminder.repeatRule), reminder.timezone || 'UTC')) {
    return { ok: false, status: 409, error: 'Reminder occurrence is no longer available.' };
  }
  if (reminder.noteId && !(await reminderIsVisibleToUser(reminder, userId))) return { ok: false, status: 403, error: 'Note not accessible.' };
  let row = existingOccurrence;
  if (!row) {
    const enriched = await enrichReminderResponse(reminder);
    await persistReminderOccurrence({ ...enriched, dueAtUtc: occurrenceDueAtUtc, occurrenceId: occurrenceKey, scheduleVersion });
    row = await get('SELECT * FROM reminder_occurrences WHERE occurrenceId = ? AND userId = ?', [occurrenceKey, userId]);
  }
  const storedOccurrence = parseJson(row.payload, {});
  if (Number(storedOccurrence.scheduleVersion || 1) !== scheduleVersion || storedOccurrence.dueAtUtc !== occurrenceDueAtUtc) {
    return { ok: false, status: 409, error: 'Reminder occurrence belongs to an older schedule.' };
  }
  const snoozeTime = Date.parse(payload.snoozeUntil);
  if (payload.state === 'snoozed' && !Number.isFinite(snoozeTime)) {
    return { ok: false, status: 400, error: 'Snooze time must be a valid date.' };
  }
  await run('UPDATE reminder_occurrences SET state = ?, snoozeUntil = ? WHERE occurrenceId = ? AND userId = ?',
    [payload.state, payload.state === 'snoozed' ? new Date(snoozeTime).toISOString() : null, row.occurrenceId, userId]);
  return { ok: true, resourceType: 'reminder-occurrence', syncId: row.occurrenceId };
}

mountClientCapabilities(app, requireAuth, KEEPARR_VERSION);
app.get('/api/native/reminders/occurrences', requireAuth, asyncRoute(async (req, res) => {
  res.json(await nativeOccurrencesForUser(req.user.id));
}));
if (process.env.KEEPARR_TEST_MODE === '1') {
  app.post('/api/test/failpoint', requireAuth, asyncRoute(async (req, res) => {
    try { armTestFault(String(req.body?.name || ''), String(req.body?.mode || 'throw'), req.body?.pauseMs); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    res.json({ ok: true });
  }));
  app.post('/api/test/reminders/tick', requireAuth, asyncRoute(async (req, res) => {
    const timestamp = Date.parse(String(req.body?.now || ''));
    if (!Number.isFinite(timestamp)) return res.status(400).json({ error: 'A valid deterministic tick time is required.' });
    const result = await processDueReminders(new Date(timestamp));
    res.json({ ok: true, now: timestamp, ...result });
  }));
}

mountSyncMutationRoute(app, {
  requireAuth,
  asyncRoute,
  executeSyncMutation,
  syncSnapshotForUser,
  syncCursorForUser,
  testMode: process.env.KEEPARR_TEST_MODE === '1'
});


app.get('/api/notes', requireAuth, asyncRoute(async (req, res) => {
  const trace = req.query.view === 'card' ? createPerfTrace('notes-card', {
    view: req.query.view || '',
    limit: req.query.limit || '',
    cursor: !!req.query.cursor,
    q: !!req.query.q
  }) : null;
  scheduleTrashPurgeIfStale();
  trace?.mark('scheduled-trash-purge');

  if (req.query.view === 'card') {
    const limit = Math.min(Math.max(Number(req.query.limit) || 80, 1), 200);
    const cursor = decodeNotesCursor(req.query.cursor);
    const searchTokens = searchGroupsFromQuery(req.query.q);
    const searchWhere = noteSearchWhere(searchTokens);
    const searchOperators = searchOperatorsFromQuery(req.query.q);
    const operatorWhere = noteOperatorWhere(searchOperators);
    const whereClauses = [];
    const queryParams = [req.user.id, req.user.id, req.user.id, req.user.id];
    if (cursor) {
      whereClauses.push(`(
        userPinned < ?
        OR (userPinned = ? AND effectiveSortOrder < ?)
        OR (userPinned = ? AND effectiveSortOrder = ? AND id < ?)
      )`);
      queryParams.push(cursor.pinned, cursor.pinned, cursor.sortOrder, cursor.pinned, cursor.sortOrder, cursor.id);
    }
    if (searchWhere.clause) {
      whereClauses.push(searchWhere.clause);
      queryParams.push(...searchWhere.params);
    }
    if (operatorWhere.clauses.length) {
      whereClauses.push(...operatorWhere.clauses);
      queryParams.push(...operatorWhere.params);
    }
    const pageWhere = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    let page;
    let hasMore;
    if (!searchTokens.length && !operatorWhere.clauses.length) {
      const keyRows = await all(
        `WITH accessible_notes AS (
          SELECT notes.id,
                 COALESCE(
                   pos.sortOrder,
                   notes.sortOrder,
                   notes.id
                 ) AS effectiveSortOrder,
                 CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned
          FROM notes
          LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
          LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
          LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
          WHERE notes.ownerUserId = ? OR access.userId IS NOT NULL
        )
        SELECT * FROM accessible_notes
        ${pageWhere}
        ORDER BY userPinned DESC, effectiveSortOrder DESC, id DESC
        LIMIT ?`,
        [...queryParams, limit + 1]
      );
      trace.mark('key-query', { rows: keyRows.length, limit });
      const pageKeys = keyRows.slice(0, limit);
      hasMore = keyRows.length > limit;
      if (!pageKeys.length) return sendJsonWithPerf(res, trace, { notes: [], nextCursor: null });

      const pageIds = pageKeys.map(row => row.id);
      const idPlaceholders = pageIds.map(() => '?').join(',');
      const rows = await all(
        `SELECT notes.*,
                COALESCE(pos.sortOrder, notes.sortOrder, notes.id) AS effectiveSortOrder,
                CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
                COALESCE(view_state.completedChecklistCollapsed, 0) AS completedChecklistCollapsed,
                owner.displayName AS ownerDisplayName,
                owner.username AS ownerUsername,
                owner.avatarPreset AS ownerAvatarPreset,
                (SELECT GROUP_CONCAT(nc.userId) FROM note_collaborators nc WHERE nc.noteId = notes.id) AS collaboratorIds,
                lastEditor.displayName AS lastEditorDisplayName,
                (SELECT COUNT(*) FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentCount,
                (SELECT GROUP_CONCAT(na.originalName, ' ') FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentNames
         FROM notes
         LEFT JOIN users owner ON owner.id = notes.ownerUserId
         LEFT JOIN users lastEditor ON lastEditor.id = notes.lastEditorUserId
         LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
         LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
         LEFT JOIN user_note_view_states view_state ON view_state.noteId = notes.id AND view_state.userId = ?
         WHERE notes.id IN (${idPlaceholders})`,
        [req.user.id, req.user.id, req.user.id, ...pageIds]
      );
      trace.mark('detail-query', { rows: rows.length });
      const order = new Map(pageKeys.map((row, index) => [row.id, index]));
      page = rows.sort((a, b) => order.get(a.id) - order.get(b.id));
      trace.mark('detail-sort');
    } else {
      const rows = await all(
        `WITH accessible_notes AS (
          SELECT notes.*,
                 COALESCE(
                   pos.sortOrder,
                   notes.sortOrder,
                   notes.id
                 ) AS effectiveSortOrder,
                 CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
                 COALESCE(view_state.completedChecklistCollapsed, 0) AS completedChecklistCollapsed,
                 owner.displayName AS ownerDisplayName,
                 owner.username AS ownerUsername,
                 owner.avatarPreset AS ownerAvatarPreset,
                 (SELECT GROUP_CONCAT(nc.userId) FROM note_collaborators nc WHERE nc.noteId = notes.id) AS collaboratorIds,
                 lastEditor.displayName AS lastEditorDisplayName,
                 (SELECT COUNT(*) FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentCount,
                 (SELECT GROUP_CONCAT(na.originalName, ' ') FROM note_attachments na WHERE na.noteId = notes.id) AS attachmentNames
          FROM notes
          LEFT JOIN users owner ON owner.id = notes.ownerUserId
          LEFT JOIN users lastEditor ON lastEditor.id = notes.lastEditorUserId
          LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
          LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
          LEFT JOIN user_note_view_states view_state ON view_state.noteId = notes.id AND view_state.userId = ?
          LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
          WHERE notes.ownerUserId = ? OR access.userId IS NOT NULL
        )
        SELECT * FROM accessible_notes
        ${pageWhere}
        ORDER BY userPinned DESC, effectiveSortOrder DESC, id DESC
        LIMIT ?`,
        [...queryParams.slice(0, 2), req.user.id, ...queryParams.slice(2), limit + 1]
      );
      trace.mark('search-query', { rows: rows.length, limit, tokens: searchTokens.length });
      page = rows.slice(0, limit);
      hasMore = rows.length > limit;
    }
    const me = req.user.id;
    const userIds = new Set();
    for (const row of page) {
      if (row.ownerUserId) userIds.add(row.ownerUserId);
      if (row.collaboratorIds) {
        for (const id of String(row.collaboratorIds).split(',')) {
          const n = Number(id);
          if (n) userIds.add(n);
        }
      }
    }
    let userMap = new Map();
    if (userIds.size) {
      const ids = Array.from(userIds);
      const placeholders = ids.map(() => '?').join(',');
      const userRows = await all(
        `SELECT id, username, displayName, avatarDataUrl, avatarPreset FROM users WHERE id IN (${placeholders})`,
        ids
      );
      userMap = new Map(userRows.map(u => [u.id, u]));
      trace.mark('user-query', { rows: userRows.length });
    } else {
      trace.mark('user-query-skipped');
    }
    const notes = page.map(row => {
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
        const u = userMap.get(id);
        if (!u) return null;
        return {
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          avatarDataUrl: u.id === me ? '' : (u.avatarDataUrl || ''),
          avatarPreset: u.avatarPreset || 'cat',
          online: realtimeClients.has(u.id)
        };
      }).filter(Boolean));
      const note = dbNoteToCard(row, { includeSearchText: !!searchTokens.length });
      note.ownerOnline = realtimeClients.has(note.ownerUserId);
      note.collaborators = (note.collaborators || []).filter(Boolean).map(c => ({
        ...c,
        online: realtimeClients.has(c.id)
      }));
      if (note.ownerUserId === me) {
        note.ownerDisplayName = undefined;
        note.ownerUsername = undefined;
      }
      return note;
    });
    trace.mark('map-cards', { notes: notes.length });
    const attachmentNoteIds = notes.filter(note => note.hasAttachments).map(note => note.id);
    if (attachmentNoteIds.length) {
      const placeholders = attachmentNoteIds.map(() => '?').join(',');
      const attachmentRows = await all(
        `SELECT id, syncId, noteId, originalName, fileSize, mimeType, uploadedAt,
                lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId
         FROM note_attachments
         WHERE noteId IN (${placeholders})
         ORDER BY uploadedAt DESC`,
        attachmentNoteIds
      );
      trace.mark('attachment-query', { rows: attachmentRows.length, notes: attachmentNoteIds.length });
      const attachmentsByNoteId = new Map();
      for (const attachment of attachmentRows) {
        if (!attachmentsByNoteId.has(attachment.noteId)) {
          attachmentsByNoteId.set(attachment.noteId, []);
        }
        attachmentsByNoteId.get(attachment.noteId).push({
          ...attachmentResponse(attachment)
        });
      }
      for (const note of notes) {
        const attachments = attachmentsByNoteId.get(note.id);
        if (!attachments) continue;
        note.attachments = attachments;
        note.hasAttachments = true;
        note.attachmentCount = attachments.length;
      }
    } else {
      trace.mark('attachment-query-skipped');
    }
    return sendJsonWithPerf(res, trace, { notes, nextCursor: hasMore ? encodeNotesCursor(page[page.length - 1]) : null });
  }

  // Avatars (data URLs) can be hundreds of KB each. Joining `owner.avatarDataUrl`
  // and per-collaborator avatars onto every note row produces a payload that
  // grows quadratically with note count × avatar size — easily 100 MB+ for a
  // user with hundreds of imported notes and a high-res avatar. Instead we
  // fetch avatars once per distinct user and let the client merge them in.
  const rows = await all(
    `SELECT notes.*,
            COALESCE(pos.sortOrder, notes.sortOrder) AS effectiveSortOrder,
            CASE WHEN user_pins.noteId IS NOT NULL THEN 1 ELSE 0 END AS userPinned,
            COALESCE(view_state.completedChecklistCollapsed, 0) AS completedChecklistCollapsed,
            owner.displayName AS ownerDisplayName,
            owner.username AS ownerUsername,
            owner.avatarPreset AS ownerAvatarPreset,
            (SELECT GROUP_CONCAT(nc.userId) FROM note_collaborators nc WHERE nc.noteId = notes.id) AS collaboratorIds,
            lastEditor.displayName AS lastEditorDisplayName
     FROM notes
     LEFT JOIN users owner ON owner.id = notes.ownerUserId
     LEFT JOIN users lastEditor ON lastEditor.id = notes.lastEditorUserId
     LEFT JOIN user_pins ON user_pins.noteId = notes.id AND user_pins.userId = ?
     LEFT JOIN user_note_positions pos ON pos.noteId = notes.id AND pos.userId = ?
     LEFT JOIN user_note_view_states view_state ON view_state.noteId = notes.id AND view_state.userId = ?
     LEFT JOIN note_collaborators access ON access.noteId = notes.id AND access.userId = ?
     WHERE notes.ownerUserId = ? OR access.userId IS NOT NULL
     ORDER BY effectiveSortOrder DESC, notes.id DESC`,
    [req.user.id, req.user.id, req.user.id, req.user.id, req.user.id]
  );

  // Collect every userId we'll need to resolve (owners + collaborators)
  // and fetch each user record once. This caps the avatar payload at
  // (number of distinct users) × (avatar size), independent of note count.
  const userIds = new Set();
  for (const row of rows) {
    if (row.ownerUserId) userIds.add(row.ownerUserId);
    if (row.collaboratorIds) {
      for (const id of String(row.collaboratorIds).split(',')) {
        const n = Number(id);
        if (n) userIds.add(n);
      }
    }
  }
  let userMap = new Map();
  if (userIds.size) {
    const ids = Array.from(userIds);
    const placeholders = ids.map(() => '?').join(',');
    const userRows = await all(
      `SELECT id, username, displayName, avatarDataUrl, avatarPreset FROM users WHERE id IN (${placeholders})`,
      ids
    );
    userMap = new Map(userRows.map(u => [u.id, u]));
  }

  // Avatars are big (data-URL PNGs can be 600KB+). The previous version
  // duplicated the requesting user's own avatar onto every owned note,
  // exploding the response to 200MB+. The client already has its own
  // session avatar, so we only need to ship avatars for OTHER users
  // (shared-note owners and collaborators that aren't the requester).
  const me = req.user.id;

  // Fetch attachments for all notes
  const attachmentsByNoteId = new Map();
  if (rows.length) {
    for (const att of await accessibleAttachmentRows(req.user.id)) {
      if (!attachmentsByNoteId.has(att.noteId)) {
        attachmentsByNoteId.set(att.noteId, []);
      }
      attachmentsByNoteId.get(att.noteId).push(attachmentResponse(att));
    }
  }

  const notes = await Promise.all(rows.map(async row => {
    const owner = userMap.get(row.ownerUserId);
    if (owner && owner.id !== me) {
      row.ownerAvatarDataUrl = owner.avatarDataUrl || '';
    } else {
      row.ownerAvatarDataUrl = '';
    }

    const collabIds = row.collaboratorIds
      ? String(row.collaboratorIds).split(',').map(Number).filter(Boolean)
      : [];
    row.collaborators = JSON.stringify(collabIds.map(id => {
      const u = userMap.get(id);
      if (!u) return null;
      return {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        // Skip the avatar payload for the requester themselves; the
        // client already has it from the session.
        avatarDataUrl: u.id === me ? '' : (u.avatarDataUrl || ''),
        avatarPreset: u.avatarPreset || 'cat'
      };
    }).filter(Boolean));

    const note = dbNoteToApi(row);
    note.attachments = attachmentsByNoteId.get(row.id) || [];
    note.ownerOnline = realtimeClients.has(note.ownerUserId);
    note.collaborators = note.collaborators.filter(Boolean).map(c => ({
      ...c,
      online: realtimeClients.has(c.id)
    }));
    if (!req.mcpToken) return note;
    const includeLockedContent = !note.locked || await mcpNoteIsUnlocked(req, note.id);
    return mcpNoteResponse(note, includeLockedContent);
  }));
  res.json(notes);
}));

app.get('/api/notes/search', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  const notes = await accessibleNoteSummaries(req.user.id, { query: q, limit: 20, protectLockedContent: !!req.mcpToken });
  if (!req.mcpToken) return res.json(notes);
  res.json(notes.map(note => mcpNoteResponse(note, false)));
}));

app.get('/api/ai/context', requireAuth, asyncRoute(async (req, res) => {
  const query = String(req.query.query || req.query.q || '').trim();
  const labels = await all('SELECT id, name FROM labels WHERE userId = ? ORDER BY name COLLATE NOCASE', [req.user.id]);
  const users = await all(
    `SELECT id, username, displayName, avatarDataUrl, avatarPreset
     FROM users
     WHERE id != ? AND enabled = 1
     ORDER BY displayName COLLATE NOCASE, username COLLATE NOCASE
     LIMIT 50`,
    [req.user.id]
  );
  const recentNotes = await accessibleNoteSummaries(req.user.id, { limit: 20 });
  let candidateNotes = query
    ? await accessibleNoteSummaries(req.user.id, { query, limit: 20 })
    : recentNotes;
  if (!candidateNotes.length) candidateNotes = recentNotes;

  let currentOpenNote = null;
  const currentOpenNoteId = Number(req.query.currentOpenNoteId || 0);
  if (currentOpenNoteId) {
    const rows = await accessibleNoteSummaryRows(req.user.id, { noteId: currentOpenNoteId, limit: 1 });
    currentOpenNote = rows[0] ? noteSummaryFromRow(rows[0]) : null;
  }

  res.json({
    currentUser: publicUser(req.user),
    labels,
    users: users.map(publicCollaborator),
    recentNotes,
    candidateNotes,
    currentOpenNote
  });
}));

app.post('/api/ai/action-plan/validate', requireAuth, asyncRoute(async (req, res) => {
  const transcript = String(req.body.transcript || '');
  const actionPlan = req.body.actionPlan;
  const validation = await validateKeeparrActionPlan(req.user.id, transcript, actionPlan);
  await insertAiActionHistory(
    req.user.id,
    transcript,
    actionPlan,
    validation.normalizedPlan,
    validation.valid ? 'validated' : 'failed'
  );
  res.json(validation);
}));

app.post('/api/ai/action-plan/execute', requireAuth, asyncRoute(async (req, res) => {
  const transcript = String(req.body.transcript || '');
  const actionPlan = req.body.actionPlan;
  const executeOptions = req.body.executeOptions || req.body.options || {};
  const validation = await validateKeeparrActionPlan(req.user.id, transcript, actionPlan);
  if (!validation.valid) {
    await insertAiActionHistory(req.user.id, transcript, actionPlan, validation.normalizedPlan, 'failed');
    return res.status(400).json({ ok: false, errors: validation.errors, validation });
  }
  if (validation.requiresConfirmation && executeOptions.confirmed !== true) {
    await insertAiActionHistory(req.user.id, transcript, actionPlan, validation.normalizedPlan, 'failed');
    return res.status(409).json({
      ok: false,
      errors: ['This action plan requires confirmation before execution.'],
      requiresConfirmation: true,
      normalizedPlan: validation.normalizedPlan
    });
  }

  const allowPartial = !!executeOptions.allowPartial;
  const selected = Array.isArray(executeOptions.selectedActionIndexes)
    ? new Set(executeOptions.selectedActionIndexes.map(Number).filter(Number.isInteger))
    : null;
  const actions = selectedActionsWithDependencies(validation.normalizedPlan.actions, selected);
  const state = {
    createdNoteIds: [],
    updatedNoteIds: new Set(),
    createdLabelIds: new Set(),
    reminderIds: [],
    remindersToSync: [],
    shareBroadcasts: [],
    lastCreatedNoteId: null
  };
  const executed = [];
  const failed = [];

  let transactionError = null;
  try {
    await withDatabaseTransaction(async () => {
      for (let index = 0; index < actions.length; index += 1) {
        const action = actions[index];
        try {
          const result = await executeSmartAction(req.user.id, action, state);
          executed.push({ index, ...result });
        } catch (error) {
          failed.push({ index, type: action.type, error: error.message || 'Action failed.' });
          if (!allowPartial) throw error;
        }
      }
      for (const noteId of state.createdNoteIds) await broadcastNoteChange(noteId, 'created', [req.user.id]);
      for (const noteId of state.updatedNoteIds) await broadcastNoteChange(noteId, 'updated');
      for (const share of state.shareBroadcasts) await broadcastNoteChange(share.noteId, 'collaborators-updated', share.previousRecipients);
      if (state.createdLabelIds.size) await cleanupUnusedLabels(req.user.id, Array.from(state.createdLabelIds));
      afterDatabaseCommit(() => syncSmartReminderIntegrations(req.user.id, state.remindersToSync));
    });
  } catch (error) {
    transactionError = error;
  }
  if (transactionError) {
    const error = transactionError;
    await insertAiActionHistory(req.user.id, transcript, actionPlan, { executed, failed }, 'failed');
    return res.status(400).json({
      ok: false,
      executed: [],
      failed: failed.length ? failed : [{ error: error.message || 'Execution failed.' }],
      createdNoteIds: [],
      updatedNoteIds: [],
      createdLabelIds: [],
      reminderIds: []
    });
  }

  const status = failed.length ? 'partial' : 'success';
  const response = {
    ok: failed.length === 0,
    executed,
    failed,
    createdNoteIds: state.createdNoteIds,
    updatedNoteIds: Array.from(state.updatedNoteIds),
    createdLabelIds: Array.from(state.createdLabelIds),
    reminderIds: state.reminderIds
  };
  await insertAiActionHistory(req.user.id, transcript, actionPlan, response, status);

  res.status(failed.length ? 207 : 200).json(response);
}));

app.post('/api/ai/notes/:id/archive', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  if (!noteId) return res.status(400).json({ error: 'noteId is required.' });
  try {
    const status = await setOwnedNoteLifecycleState(req.user.id, noteId, { archived: true, trashed: false });
    await broadcastNoteChange(noteId, 'updated');
    res.json({ ok: true, ...status });
  } catch (error) {
    if (/not owned by you/i.test(error.message || '')) return res.status(404).json({ error: 'Note not found.' });
    throw error;
  }
}));

app.post('/api/ai/notes/:id/trash', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  if (!noteId) return res.status(400).json({ error: 'noteId is required.' });
  try {
    const status = await setOwnedNoteLifecycleState(req.user.id, noteId, { archived: false, trashed: true });
    await broadcastNoteChange(noteId, 'updated');
    res.json({ ok: true, ...status });
  } catch (error) {
    if (/not owned by you/i.test(error.message || '')) return res.status(404).json({ error: 'Note not found.' });
    throw error;
  }
}));

app.get('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const row = await getAccessibleNote(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Note not found.' });
  const note = dbNoteToApi(row);

  // Fetch attachments for this note
  const attachments = await all(
    `SELECT id, originalName, fileSize, mimeType, uploadedAt FROM note_attachments WHERE noteId = ? ORDER BY uploadedAt DESC`,
    [note.id]
  );
  note.attachments = attachments.map(att => ({
    id: att.id,
    originalName: att.originalName,
    fileSize: att.fileSize,
    mimeType: att.mimeType,
    uploadedAt: att.uploadedAt
  }));
  note.hasAttachments = note.attachments.length > 0;
  note.attachmentCount = note.attachments.length;
  note.collaborators = await getCollaboratorsForNote(note.id);
  note.ownerOnline = realtimeClients.has(note.ownerUserId);

  if (req.mcpToken) {
    const includeLockedContent = !note.locked || await mcpNoteIsUnlocked(req, note.id);
    return res.json(mcpNoteResponse(note, includeLockedContent));
  }
  res.json(note);
}));

app.get('/api/notes/:id/collaborators', requireAuth, asyncRoute(async (req, res) => {
  const note = await getOwnedNote(Number(req.params.id), req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });
  res.json(await getCollaboratorsForNote(Number(req.params.id)));
}));

app.put('/api/notes/:id/collaborators', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  const outcome = await withDatabaseTransaction(async () => {
    const note = await getOwnedNote(noteId, req.user.id);
    if (!note) return { status: 404, error: 'Note not found.' };
    if (!note.syncId) {
      note.syncId = `note-${crypto.randomUUID()}`;
      await run('UPDATE notes SET syncId = ? WHERE id = ?', [note.syncId, noteId]);
    }
    const previousRecipients = await getNoteRecipientIds(noteId);
    const previousCollaborators = await all('SELECT userId FROM note_collaborators WHERE noteId = ?', [noteId]);
    const previousCollaboratorIds = new Set(previousCollaborators.map(row => Number(row.userId)).filter(Boolean));
    const userIds = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number).filter(Boolean) : [];
    const nextSet = new Set(userIds.filter(userId => userId !== req.user.id));
    const newlyAddedUserIds = [];
    await run('DELETE FROM note_collaborators WHERE noteId = ?', [noteId]);
    for (const userId of nextSet) {
      const exists = await get('SELECT id FROM users WHERE id = ?', [userId]);
      if (!exists) continue;
      await run('INSERT OR IGNORE INTO note_collaborators (noteId, userId, createdAt) VALUES (?, ?, ?)', [noteId, userId, new Date().toISOString()]);
      if (!previousCollaboratorIds.has(userId)) newlyAddedUserIds.push(userId);
    }
    await moveNoteToTopForUsers(noteId, newlyAddedUserIds);
    const collaborators = await getCollaboratorsForNote(noteId);
    const nextRecipients = await getNoteRecipientIds(noteId);
    const removedUserIds = previousCollaborators.map(row => Number(row.userId)).filter(userId => userId && !nextSet.has(userId));
    if (removedUserIds.length) {
      await run(`DELETE FROM note_collaborator_rejoin_grants WHERE noteId = ? AND userId IN (${removedUserIds.map(() => '?').join(',')})`, [noteId, ...removedUserIds]);
      const revokedStamp = serverLwwStamp();
      await recordNoteSyncChange(noteId, 'delete', removedUserIds, {
        syncId: note.syncId, lwwPhysicalMs: revokedStamp.physicalMs, lwwLogical: revokedStamp.logical,
        lwwDeviceId: revokedStamp.deviceId, lwwOperationId: revokedStamp.operationId
      });
      broadcastRealtime(removedUserIds, { type: 'notes-changed', action: 'access-revoked', noteId, syncId: note.syncId });
    }
    await broadcastNoteChange(noteId, 'collaborators-updated', nextRecipients);
    return { status: 200, collaborators, previousRecipients };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.json(outcome.collaborators);
}));

app.post('/api/notes/:id/collaborators/rejoin', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  const outcome = await withDatabaseTransaction(async () => {
    const note = await get('SELECT id FROM notes WHERE id = ?', [noteId]);
    if (!note) return { status: 404, error: 'Note not found.' };
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const grant = await get('SELECT noteId FROM note_collaborator_rejoin_grants WHERE noteId = ? AND userId = ? AND grantedAt >= ?',
      [noteId, req.user.id, cutoff]);
    if (!grant) return { status: 403, error: 'Rejoin not permitted.' };
    await run('INSERT OR IGNORE INTO note_collaborators (noteId, userId, createdAt) VALUES (?, ?, ?)', [noteId, req.user.id, new Date().toISOString()]);
    await moveNoteToTopForUsers(noteId, [req.user.id]);
    await run('DELETE FROM note_collaborator_rejoin_grants WHERE noteId = ? AND userId = ?', [noteId, req.user.id]);
    await broadcastNoteChange(noteId, 'collaborators-updated');
    return { status: 204 };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.status(204).end();
}));

app.patch('/api/notes/reorder', requireAuth, asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  const positions = parseOrderPositions(req.body.positions, 'id');
  if (positions === false) return res.status(400).json({ error: 'Invalid note positions.' });
  if (!ids.length && !positions?.length) return res.status(400).json({ error: 'No note ids provided.' });
  await applyNoteOrder(req.user.id, positions ? { positions, by: 'id' } : { ids });
  res.status(204).end();
}));

app.post('/api/notes', requireAuth, asyncRoute(async (req, res) => {
  const noteData = canonicalizeNotePayload(req.body);
  const now = new Date().toISOString();
  const trashedAt = noteData.trashed ? now : null;
  const syncId = String(noteData.syncId || noteData.clientId || `note-${crypto.randomUUID()}`);
  const created = await withDatabaseTransaction(async () => {
    const result = await run(
      `INSERT INTO notes
        (ownerUserId, syncId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, binder, extraFields, locked, lockSalt, lockHash, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, lastEditorUserId, isDemo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, syncId, String(noteData.noteTitle || ''), noteData.noteBody || '', noteData.bgColor || '', noteData.bgImage || '',
        JSON.stringify(noteData.checkBoxes || []), JSON.stringify(noteData.images || []), noteData.isCbox ? 1 : 0,
        JSON.stringify(noteData.labels || []), noteData.binder || '', JSON.stringify(noteData.extraFields || {}),
        noteData.locked ? 1 : 0, noteData.lockSalt || '', noteData.lockHash || '', noteData.archived ? 1 : 0,
        noteData.trashed ? 1 : 0, trashedAt, Date.now(), now, now, req.user.id, noteData.isDemo ? 1 : 0]
    );
    await syncNoteImagesForNote(result.id, req.user.id, noteData);
    if (noteData.pinned) await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, result.id]);
    await broadcastNoteChange(result.id, 'created', [req.user.id], { syncId });
    return dbNoteToApi(await getAccessibleNote(result.id, req.user.id));
  });
  res.status(201).json(created);
}));

app.put('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const outcome = await withDatabaseTransaction(async () => {
    const noteId = Number(req.params.id);
    const note = await getAccessibleNote(noteId, req.user.id);
    if (!note) return { status: 404, error: 'Note not found.' };
    await hitTestFault('after-rest-note-read');
    if (req.mcpToken && note.locked && !await mcpNoteIsUnlocked(req, note.id)) {
      return { status: 423, error: 'Unlock this note before modifying it through MCP.' };
    }
    const isOwner = note.ownerUserId === req.user.id;
    const next = canonicalizeNotePayload({ ...dbNoteToApi(note), ...req.body });
    const shouldPinForUser = Object.prototype.hasOwnProperty.call(req.body || {}, 'pinned') ? !!req.body.pinned : !!note.userPinned;
    if (!isOwner) {
      next.bgColor = note.bgColor || ''; next.bgImage = note.bgImage || ''; next.labels = parseJson(note.labels, []);
      next.binder = note.binder || ''; next.archived = Boolean(note.archived); next.trashed = Boolean(note.trashed);
      next.pinned = Boolean(note.pinned); next.locked = Boolean(note.locked);
      next.lockSalt = note.lockSalt || ''; next.lockHash = note.lockHash || '';
    }
    const trashedAt = nextTrashedAt(note, next);
    await run(
      `UPDATE notes SET
        noteTitle = ?, noteBody = ?, bgColor = ?, bgImage = ?, checkBoxes = ?, images = ?, isCbox = ?, labels = ?, binder = ?, extraFields = ?, locked = ?, lockSalt = ?, lockHash = ?, archived = ?, trashed = ?, trashedAt = ?, updatedAt = ?, lastEditorUserId = ?, isDemo = ?
       WHERE id = ?`,
      [String(next.noteTitle || ''), next.noteBody || '', next.bgColor || '', next.bgImage || '', JSON.stringify(next.checkBoxes || []),
        JSON.stringify(next.images || []), next.isCbox ? 1 : 0, JSON.stringify(next.labels || []), next.binder || '',
        JSON.stringify(next.extraFields || {}), next.locked ? 1 : 0, next.lockSalt || '', next.lockHash || '',
        next.archived ? 1 : 0, next.trashed ? 1 : 0, trashedAt, new Date().toISOString(), req.user.id, next.isDemo ? 1 : 0, noteId]
    );
    if (shouldPinForUser) await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, noteId]);
    else await run('DELETE FROM user_pins WHERE userId = ? AND noteId = ?', [req.user.id, noteId]);
    await syncNoteImagesForNote(noteId, note.ownerUserId, next);
    await broadcastNoteChange(noteId, 'updated');
    await cleanupUnusedLabels(req.user.id);
    return { status: 204 };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.status(204).end();
}));

app.patch('/api/notes/:id/view-state', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await getAccessibleNote(noteId, req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });

  await run(
    `INSERT INTO user_note_view_states (userId, noteId, completedChecklistCollapsed, updatedAt)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(userId, noteId) DO UPDATE SET
       completedChecklistCollapsed = excluded.completedChecklistCollapsed,
       updatedAt = excluded.updatedAt`,
    [req.user.id, noteId, req.body?.completedChecklistCollapsed ? 1 : 0, new Date().toISOString()]
  );
  await recordNoteSyncChange(noteId, 'upsert', [req.user.id]);
  broadcastRealtime([req.user.id], { type: 'notes-changed', action: 'view-state-updated', noteId });

  res.status(204).end();
}));

app.patch('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const outcome = await withDatabaseTransaction(async () => {
    const noteId = Number(req.params.id);
    const existing = await getAccessibleNote(noteId, req.user.id);
    if (!existing) return { status: 404, error: 'Note not found.' };
    await hitTestFault('after-rest-note-read');
    if (req.mcpToken && existing.locked && !await mcpNoteIsUnlocked(req, existing.id)) {
      return { status: 423, error: 'Unlock this note before modifying it through MCP.' };
    }

    // Merge the partial request against the latest serialized database state.
    const isOwner = existing.ownerUserId === req.user.id;
    const next = canonicalizeNotePayload({ ...dbNoteToApi(existing), ...req.body });
    const shouldPinForUser = Object.prototype.hasOwnProperty.call(req.body || {}, 'pinned')
      ? !!req.body.pinned
      : !!existing.userPinned;
    if (!isOwner) {
      next.bgColor = existing.bgColor || '';
      next.bgImage = existing.bgImage || '';
      next.labels = parseJson(existing.labels, []);
      next.binder = existing.binder || '';
      next.archived = Boolean(existing.archived);
      next.trashed = Boolean(existing.trashed);
      next.pinned = Boolean(existing.pinned);
      next.locked = Boolean(existing.locked);
      next.lockSalt = existing.lockSalt || '';
      next.lockHash = existing.lockHash || '';
    }
    const trashedAt = nextTrashedAt(existing, next);
    await run(
      `UPDATE notes SET
        noteTitle = ?, noteBody = ?, bgColor = ?, bgImage = ?,
        checkBoxes = ?, images = ?, isCbox = ?, labels = ?, binder = ?, extraFields = ?, locked = ?, lockSalt = ?, lockHash = ?, archived = ?, trashed = ?, trashedAt = ?, updatedAt = ?, lastEditorUserId = ?, isDemo = ?
       WHERE id = ?`,
      [
        String(next.noteTitle || ''), next.noteBody || '', next.bgColor || '', next.bgImage || '',
        JSON.stringify(next.checkBoxes || []), JSON.stringify(next.images || []), next.isCbox ? 1 : 0,
        JSON.stringify(next.labels || []), next.binder || '', JSON.stringify(next.extraFields || {}),
        next.locked ? 1 : 0, next.lockSalt || '', next.lockHash || '', next.archived ? 1 : 0,
        next.trashed ? 1 : 0, trashedAt, new Date().toISOString(), req.user.id, next.isDemo ? 1 : 0, noteId
      ]
    );
    if (shouldPinForUser) await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, noteId]);
    else await run('DELETE FROM user_pins WHERE userId = ? AND noteId = ?', [req.user.id, noteId]);
    await syncNoteImagesForNote(noteId, existing.ownerUserId, next);
    await broadcastNoteChange(noteId, 'updated');
    await cleanupUnusedLabels(req.user.id);
    return { status: 204 };
  });
  if (outcome.error) return res.status(outcome.status).json({ error: outcome.error });
  res.status(204).end();
}));

app.post('/api/notes/:id/clone', requireAuth, asyncRoute(async (req, res) => {
  const row = await getAccessibleNote(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: 'Note not found.' });

  const now = new Date().toISOString();
  const note = dbNoteToApi(row);
  const result = await run(
    `INSERT INTO notes
     (ownerUserId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, binder, extraFields, locked, lockSalt, lockHash, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, isDemo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      req.user.id,
      String(note.noteTitle || ''),
      note.noteBody || '',
      note.bgColor || '',
      note.bgImage || '',
      JSON.stringify(note.checkBoxes || []),
      JSON.stringify(note.images || []),
      note.isCbox ? 1 : 0,
      JSON.stringify(note.labels || []),
      note.binder || '',
      JSON.stringify(noteExtraFields(note)),
      note.locked ? 1 : 0,
      note.lockSalt || '',
      note.lockHash || '',
      note.archived ? 1 : 0,
      note.trashed ? 1 : 0,
      note.trashed ? now : null,
      Date.now(),
      now,
      now,
      note.isDemo ? 1 : 0
    ]
  );
  if (note.pinned) {
    await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, result.id]);
  }
  await syncNoteImagesForNote(result.id, req.user.id, note);
  await broadcastNoteChange(result.id, 'created', [req.user.id]);
  res.status(201).json({ id: result.id });
}));

app.post('/api/notes/merge', requireAuth, asyncRoute(async (req, res) => {
  const orderedIds = Array.isArray(req.body.orderedIds)
    ? req.body.orderedIds.map(Number).filter(Boolean)
    : [];
  if (orderedIds.length < 2) return res.status(400).json({ error: 'At least two notes are required to merge.' });

  // Owned-only. Refuse if any source isn't owned by the requester (we don't
  // want to trash someone else's shared note as a side effect of merge).
  const placeholders = orderedIds.map(() => '?').join(',');
  const rows = await all(
    `SELECT * FROM notes WHERE id IN (${placeholders}) AND ownerUserId = ?`,
    [...orderedIds, req.user.id]
  );
  if (rows.length !== orderedIds.length) {
    return res.status(403).json({ error: 'You can only merge notes you own.' });
  }
  // Re-order rows to match the user's chosen merge order.
  const byId = new Map(rows.map(r => [r.id, r]));
  const sources = orderedIds.map(id => byId.get(id));
  if (sources.some(s => !s)) return res.status(404).json({ error: 'One or more notes were not found.' });

  // Build the merged note. Hybrid: keep text body AND the checklist as
  // first-class fields so the editor can render both stacked. Drawings get
  // flattened to plain inline images (id !== 'drawing') in the merged note.
  const apiNotes = sources.map(dbNoteToApi);

  const mergedTitle = apiNotes.find(n => n.noteTitle && n.noteTitle.trim())?.noteTitle || '';
  const mergedBgColor = apiNotes.find(n => n.bgColor)?.bgColor || '';
  // Treat empty `url("")` as "no image" — older note saves stored it as that
  // literal CSS value when no background was set, and propagating it would
  // make the merged note think it has a real bgImage and apply the .detail-bg
  // class (which forces a white background).
  const hasRealBgImage = (v) => !!v && v !== 'url("")' && v !== 'url()';
  const mergedBgImage = apiNotes.find(n => hasRealBgImage(n.bgImage))?.bgImage || '';

  const bodyParts = [];
  const mergedCheckBoxes = [];
  const mergedImages = [];
  const labelMap = new Map();

  for (const note of apiNotes) {
    if (note.noteBody && note.noteBody.trim()) bodyParts.push(note.noteBody);
    for (const cb of (note.checkBoxes || [])) mergedCheckBoxes.push(cb);
    for (const img of (note.images || [])) {
      // Flatten drawings — strip the editor-marker id so it loads as a
      // regular inline image. The original drawing note remains in trash and
      // is still editable as a drawing if restored.
      const flattened = img.id === 'drawing'
        ? { ...img, id: `drawing-flat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: (img.name || '').replace(/^Drawing\|/, '') }
        : img;
      mergedImages.push(flattened);
    }
    for (const label of (note.labels || [])) {
      if (label.id && !labelMap.has(label.id)) labelMap.set(label.id, label);
    }
  }
  const mergedBody = bodyParts.join('<br><br>');
  const mergedLabels = Array.from(labelMap.values());
  const mergedBinder = apiNotes.find(n => n.binder)?.binder || '';
  const mergedLock = apiNotes.find(n => n.locked && n.lockSalt && n.lockHash);
  // Merge distinct opaque fields, keeping the first selected source's value on conflict.
  const mergedExtraFields = Object.assign({}, ...apiNotes.slice().reverse().map(noteExtraFields));
  // isCbox=true so the editor's checklist surface activates; the new editor
  // logic will additionally render the body when both are present.
  const isCbox = mergedCheckBoxes.length > 0 ? 1 : 0;

  const now = new Date().toISOString();
  const newNoteId = await withDatabaseTransaction(async () => {
    const latestSources = await all(`SELECT id, revision, updatedAt FROM notes WHERE id IN (${placeholders}) AND ownerUserId = ?`, [...orderedIds, req.user.id]);
    if (latestSources.length !== sources.length || sources.some(source => {
      const latest = latestSources.find(row => row.id === source.id);
      return !latest || Number(latest.revision || 1) !== Number(source.revision || 1) || latest.updatedAt !== source.updatedAt;
    })) {
      const conflict = new Error('One or more notes changed while the merge was being prepared. Reload and retry.');
      conflict.status = 409;
      throw conflict;
    }
    const result = await run(
      `INSERT INTO notes
       (ownerUserId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, binder, extraFields, locked, lockSalt, lockHash, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, lastEditorUserId, isDemo)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, ?, ?, ?, ?, 0)`,
      [
        req.user.id,
        String(mergedTitle || ''),
        mergedBody,
        mergedBgColor,
        mergedBgImage,
        JSON.stringify(mergedCheckBoxes),
        JSON.stringify(mergedImages),
        isCbox,
         JSON.stringify(mergedLabels),
         mergedBinder,
         JSON.stringify(mergedExtraFields),
         mergedLock ? 1 : 0,
        mergedLock?.lockSalt || '',
        mergedLock?.lockHash || '',
        Date.now(),
        now,
        now,
        req.user.id
      ]
    );
    const newNoteId = result.id;
    await syncNoteImagesForNote(newNoteId, req.user.id, { noteBody: mergedBody, images: mergedImages });

    // Re-parent attachments from sources onto the merged note. This avoids
    // re-uploading files and keeps the storedFilename references intact.
    await run(
      `UPDATE note_attachments SET noteId = ? WHERE noteId IN (${placeholders})`,
      [newNoteId, ...orderedIds]
    );

    // Re-parent the earliest pending reminder so it fires against the merged
    // note; delete any other pending reminders from the source notes. The
    // editor UI assumes one reminder per note (single chip, single remove
    // action), so dragging multiple reminders onto the merged note would
    // create "invisible" reminders the user can't see or cancel. We pick
    // the earliest pending one (the most conservative — it fires first)
    // and discard the rest. Non-pending reminders (fired/dismissed/snoozed)
    // are historical and stay with the trashed source notes (cascade-purge
    // when trash expires).
    const pendingReminders = await all(
      `SELECT id, dueAtUtc FROM reminders
       WHERE userId = ? AND status = 'pending' AND noteId IN (${placeholders})
       ORDER BY dueAtUtc ASC`,
      [req.user.id, ...orderedIds]
    );
    if (pendingReminders.length > 0) {
      const keepId = pendingReminders[0].id;
      await run(
        `UPDATE reminders SET noteId = ?, updatedAt = ? WHERE id = ?`,
        [newNoteId, now, keepId]
      );
      if (pendingReminders.length > 1) {
        const drop = pendingReminders.slice(1);
        // Fetch full rows so the external-calendar cleanup has gcalEventId etc.
        const dropPlaceholders = drop.map(() => '?').join(',');
        const dropFull = await all(
          `SELECT * FROM reminders WHERE id IN (${dropPlaceholders})`,
          drop.map(r => r.id)
        );
        await run(
          `DELETE FROM reminders WHERE id IN (${dropPlaceholders})`,
          drop.map(r => r.id)
        );
        // Best-effort cleanup of any externally-synced calendar entries.
        // Failures are logged but don't block the merge — the reminder is
        // already gone from our DB and orphaning a remote event is recoverable.
        const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
        afterDatabaseCommit(() => {
          for (const r of dropFull) {
            if (caldav) deleteReminderFromCaldav(caldav, r.id).catch(err => console.error('CalDAV delete failed during merge:', err.message));
            gcalDeleteReminder(req.user.id, r).catch(err => console.error('GCal delete failed during merge:', err.message));
          }
        });
      }
    }

    // Trash the source notes (10-day auto-purge as usual).
    await run(
      `UPDATE notes SET trashed = 1, trashedAt = ?, updatedAt = ?, lastEditorUserId = ? WHERE id IN (${placeholders})`,
      [now, now, req.user.id, ...orderedIds]
    );
    // Drop pin state for the trashed sources (per-user pin records).
    await run(
      `DELETE FROM user_pins WHERE userId = ? AND noteId IN (${placeholders})`,
      [req.user.id, ...orderedIds]
    );

    const recipients = new Set([req.user.id]);
    for (const id of orderedIds) {
      const r = await getNoteRecipientIds(id);
      r.forEach(uid => recipients.add(uid));
    }
    await broadcastNoteChange(newNoteId, 'created', [req.user.id]);
    for (const id of orderedIds) {
      await broadcastNoteChange(id, 'updated', Array.from(recipients));
    }
    return newNoteId;
  });
  res.status(201).json({ id: newNoteId });
}));

app.patch('/api/notes/labels/:labelId', requireAuth, asyncRoute(async (req, res) => {
  const labelId = Number(req.params.labelId);
  const labelValue = String(req.body.name || '');
  const rows = await all('SELECT id, labels FROM notes WHERE ownerUserId = ?', [req.user.id]);
  const recipientIds = new Set([req.user.id]);

  for (const row of rows) {
    let labels = parseJson(row.labels, []);
    if (labelValue === '') {
      labels = labels.filter(label => label.id !== labelId);
    } else {
      labels = labels.map(label => label.id === labelId ? { ...label, name: labelValue } : label);
    }
    await run('UPDATE notes SET labels = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(labels), new Date().toISOString(), row.id]);
    const noteRecipients = await getNoteRecipientIds(row.id);
    noteRecipients.forEach(userId => recipientIds.add(userId));
  }

  broadcastRealtime([...recipientIds], { type: 'notes-changed', action: 'labels-updated' });
  res.status(204).end();
}));

app.delete('/api/notes/:id', requireAuth, asyncRoute(async (req, res) => {
  const noteId = Number(req.params.id);
  const note = await getAccessibleNote(noteId, req.user.id);
  if (!note) return res.status(404).json({ error: 'Note not found.' });

  const isOwner = note.ownerUserId === req.user.id;
  if (isOwner) {
    if (req.mcpToken && !req.mcpCapabilities?.allowPermanentDelete) {
      return res.status(403).json({ error: 'Permanent deletion through MCP is disabled in Keeparr settings.' });
    }
    if (req.mcpToken && note.locked && !await mcpNoteIsUnlocked(req, note.id)) {
      return res.status(423).json({ error: 'Unlock this note before permanently deleting it through MCP.' });
    }
    const recipients = await getNoteRecipientIds(noteId);
    const deletedSnapshot = {
      syncId: note.syncId || `note-${crypto.randomUUID()}`,
      ...serverLwwStamp()
    };
    deletedSnapshot.lwwPhysicalMs = deletedSnapshot.physicalMs;
    deletedSnapshot.lwwLogical = deletedSnapshot.logical;
    deletedSnapshot.lwwDeviceId = deletedSnapshot.deviceId;
    deletedSnapshot.lwwOperationId = deletedSnapshot.operationId;
    await recordDependentSyncDeletesForNote(noteId, recipients);
    await deleteAttachmentFilesForNote(noteId);
    await deleteImageFilesForNote(noteId);
    await run('DELETE FROM notes WHERE id = ?', [noteId]);
    await broadcastNoteChange(noteId, 'deleted', recipients, { deletedSnapshot });
  } else {
    // If not owner, just remove self as collaborator (unshare).
    // Grant a rejoin token so the snackbar undo flow can re-add them.
    const revokedStamp = serverLwwStamp();
    await run('DELETE FROM note_collaborators WHERE noteId = ? AND userId = ?', [noteId, req.user.id]);
    await run(
      'INSERT OR REPLACE INTO note_collaborator_rejoin_grants (noteId, userId, grantedAt) VALUES (?, ?, ?)',
      [noteId, req.user.id, new Date().toISOString()]
    );
    await recordNoteSyncChange(noteId, 'delete', [req.user.id], {
      syncId: note.syncId,
      lwwPhysicalMs: revokedStamp.physicalMs,
      lwwLogical: revokedStamp.logical,
      lwwDeviceId: revokedStamp.deviceId,
      lwwOperationId: revokedStamp.operationId
    });
    broadcastRealtime([req.user.id], {
      type: 'notes-changed',
      action: 'access-revoked',
      noteId,
      syncId: note.syncId
    });
    await broadcastNoteChange(noteId, 'updated');
  }
  await cleanupUnusedLabels(req.user.id);
  res.status(204).end();
}));

// ─── Reminder routes ───────────────────────────────────────────────────────

async function reminderNoteMap(reminders) {
  const noteIds = [...new Set((reminders || []).map(reminder => Number(reminder.noteId || 0)).filter(Boolean))];
  if (!noteIds.length) return new Map();
  // Chunked: an account can have more reminders than SQLite allows bound variables in one statement.
  const notes = [];
  for (let offset = 0; offset < noteIds.length; offset += 500) {
    const chunk = noteIds.slice(offset, offset + 500);
    notes.push(...await all(
      `SELECT n.id, n.ownerUserId, n.noteTitle, n.noteBody, n.checkBoxes, n.isCbox, n.locked, n.archived, n.trashed,
              GROUP_CONCAT(c.userId) AS collaboratorIds
       FROM notes n LEFT JOIN note_collaborators c ON c.noteId = n.id
       WHERE n.id IN (${chunk.map(() => '?').join(',')}) GROUP BY n.id`,
      chunk
    ));
  }
  const notesById = new Map(notes.map(note => [Number(note.id), note]));
  const visible = new Map();
  for (const reminder of reminders || []) {
    const noteId = Number(reminder.noteId || 0);
    const userId = Number(reminder.userId || 0);
    const note = notesById.get(noteId);
    if (!note || !userId || note.archived || note.trashed) continue;
    const collaborators = String(note.collaboratorIds || '').split(',').map(Number);
    if (Number(note.ownerUserId) !== userId && !collaborators.includes(userId)) continue;
    visible.set(`${userId}:${noteId}`, note);
  }
  return visible;
}









async function floatReminderNoteToTop(userId, noteId) {
  if (!userId || !noteId) return;
  const note = await getAccessibleNote(noteId, userId);
  if (!note || note.trashed || note.archived) return;
  await run(
    'INSERT OR REPLACE INTO user_note_positions (userId, noteId, sortOrder) VALUES (?, ?, ?)',
    [userId, noteId, Date.now()]
  );
  await recordNoteSyncChange(noteId, 'upsert', [userId]);
  broadcastRealtime([userId], { type: 'notes-changed', action: 'reordered' });
}



async function recordReminderSyncChange(reminder, operation = 'upsert') {
  if (!reminder?.syncId) return;
  const stamp = rowLwwStamp(reminder);
  const payload = operation === 'delete' ? null : await enrichReminderResponse(reminder);
  await appendSyncChange([reminder.userId], 'reminder', reminder.syncId, operation, payload, stamp);
}

function attachmentResponse(attachment) {
  return {
    id: Number(attachment.id),
    syncId: attachment.syncId || '',
    noteId: Number(attachment.noteId),
    originalName: attachment.originalName,
    fileSize: Number(attachment.fileSize || 0),
    mimeType: attachment.mimeType,
    uploadedAt: attachment.uploadedAt,
    lwwPhysicalMs: Number(attachment.lwwPhysicalMs || 0),
    lwwLogical: Number(attachment.lwwLogical || 0),
    lwwDeviceId: attachment.lwwDeviceId || 'server',
    lwwOperationId: attachment.lwwOperationId || ''
  };
}

async function recordAttachmentSyncChange(attachment, operation = 'upsert', recipients) {
  if (!attachment?.syncId) return;
  const userIds = recipients || await getNoteRecipientIds(attachment.noteId);
  await appendSyncChange(
    userIds,
    'attachment',
    attachment.syncId,
    operation,
    operation === 'delete' ? { syncId: attachment.syncId, noteId: attachment.noteId } : attachmentResponse(attachment),
    rowLwwStamp(attachment)
  );
}

async function recordDependentSyncDeletesForNote(noteId, recipients) {
  const reminders = await all('SELECT * FROM reminders WHERE noteId = ?', [noteId]);
  for (const reminder of reminders) {
    const stamp = serverLwwStamp();
    await recordReminderSyncChange({
      ...reminder,
      syncId: reminder.syncId || `reminder-${crypto.randomUUID()}`,
      lwwPhysicalMs: stamp.physicalMs,
      lwwLogical: stamp.logical,
      lwwDeviceId: stamp.deviceId,
      lwwOperationId: stamp.operationId
    }, 'delete');
  }
  const attachments = await all('SELECT * FROM note_attachments WHERE noteId = ?', [noteId]);
  for (const attachment of attachments) {
    const stamp = serverLwwStamp();
    await recordAttachmentSyncChange({
      ...attachment,
      syncId: attachment.syncId || `attachment-${crypto.randomUUID()}`,
      lwwPhysicalMs: stamp.physicalMs,
      lwwLogical: stamp.logical,
      lwwDeviceId: stamp.deviceId,
      lwwOperationId: stamp.operationId
    }, 'delete', recipients);
  }
}

async function enrichReminderResponses(reminders) {
  const notesById = await reminderNoteMap(reminders);
  return reminders.map(reminder => reminderResponse(reminder, notesById));
}

async function reminderIsVisibleToUser(reminder, userId = reminder?.userId) {
  if (!reminder || !userId) return false;
  if (!reminder.noteId) return true;
  const note = await getAccessibleNote(reminder.noteId, Number(userId));
  return !!note && !note.archived && !note.trashed;
}

async function enrichReminderResponse(reminder) {
  return (await enrichReminderResponses([reminder]))[0];
}

const visibleReminderJoin = 'LEFT JOIN notes reminder_notes ON reminder_notes.id = reminders.noteId';
const visibleReminderWhere = `(reminders.noteId IS NULL OR EXISTS (
  SELECT 1 FROM notes reminder_access_note
  WHERE reminder_access_note.id = reminders.noteId
    AND reminder_access_note.archived = 0 AND reminder_access_note.trashed = 0
    AND (reminder_access_note.ownerUserId = reminders.userId OR EXISTS (
      SELECT 1 FROM note_collaborators reminder_access
      WHERE reminder_access.noteId = reminders.noteId AND reminder_access.userId = reminders.userId
    ))
))`;

app.get('/api/reminders', requireAuth, asyncRoute(async (req, res) => {
  const reminders = await all(
    `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ? AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
    [req.user.id]
  );
  res.json(await enrichReminderResponses(reminders));
}));

// ─── ICS feed routes ───────────────────────────────────────────────────────

app.get('/api/reminders/ics-token', requireAuth, asyncRoute(async (req, res) => {
  const token = await getOrCreateIcsFeedToken(req.user.id);
  res.json({ token });
}));

app.post('/api/reminders/ics-token', requireAuth, asyncRoute(async (req, res) => {
  const token = randomHex(20);
  await run('UPDATE users SET icsFeedToken = ? WHERE id = ?', [token, req.user.id]);
  res.json({ token });
}));

// Shared handler for both ICS feed URL shapes. The "trailing filename"
// variant exists because Thunderbird (and a few other clients) names a
// subscribed calendar after the last URL path segment — putting the token
// at the end means users see the token as the default calendar name.
// Putting keeparr-reminders.ics at the end gives them a friendly default.
const handleIcsFeed = asyncRoute(async (req, res) => {
  const user = await get('SELECT id FROM users WHERE icsFeedToken = ? AND enabled = 1', [req.params.token]);
  if (!user) return res.status(404).type('text').send('Feed not found.');
  const reminders = await all(
    `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ? AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
    [user.id]
  );
  const enrichedReminders = await enrichReminderResponses(reminders);
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'attachment; filename="keeparr-reminders.ics"',
    'Cache-Control': 'no-cache, no-store'
  });
  res.send(buildIcsFeed(enrichedReminders));
});

// Friendly route: token in the middle, keeparr-reminders.ics at the end so
// calendar clients pick up a sensible default name from the URL path.
app.get('/api/reminders/ics/:token/keeparr-reminders.ics', handleIcsFeed);
// Legacy route kept so existing subscriptions don't break.
app.get('/api/reminders/ics/:token', handleIcsFeed);

app.post('/api/reminders/import', requireAuth, asyncRoute(async (req, res) => {
  const icsContent = String(req.body.icsContent || '');
  if (!icsContent) return res.status(400).json({ error: 'icsContent is required.' });
  const events = parseIcsContent(icsContent);
  const now = new Date().toISOString();
  let imported = 0;
  for (const event of events) {
    if (!event.dtstart) continue;
    try {
      const dueAt = parseIcalDate(event.dtstart);
      if (isNaN(dueAt.getTime())) continue;
      const dueAtUtc = dueAt.toISOString();
      const result = await run(
        `INSERT INTO reminders (noteId, userId, dueAtUtc, timezone, repeatRule, status, title, body,
           scheduleVersion, scheduleAnchorAtUtc, createdAt, updatedAt, syncId)
         VALUES (NULL, ?, ?, 'UTC', NULL, 'pending', ?, ?, 1, ?, ?, ?, ?)`,
        [req.user.id, dueAtUtc, plainText(event.summary) || null, plainText(event.description) || null,
          dueAtUtc, now, now, `reminder-${crypto.randomUUID()}`]
      );
      await recordReminderSyncChange(await get('SELECT * FROM reminders WHERE id = ?', [result.id]), 'upsert');
      imported++;
    } catch {}
  }
  res.json({ imported });
}));

app.get('/api/push/vapid-public-key', requireAuth, (_req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscriptions', requireAuth, asyncRoute(async (req, res) => {
  const subscription = req.body.subscription;
  if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'A valid push subscription is required.' });
  }

  const now = new Date().toISOString();
  await run(
    `INSERT INTO push_subscriptions (userId, endpoint, subscription, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET userId = excluded.userId, subscription = excluded.subscription, updatedAt = excluded.updatedAt`,
    [req.user.id, subscription.endpoint, JSON.stringify(subscription), now, now]
  );
  res.status(201).json({ ok: true });
}));

app.delete('/api/push/subscriptions', requireAuth, asyncRoute(async (req, res) => {
  const endpoint = String(req.body.endpoint || '');
  if (endpoint) {
    await run('DELETE FROM push_subscriptions WHERE userId = ? AND endpoint = ?', [req.user.id, endpoint]);
  }
  res.status(204).end();
}));

function locationSavedPlaceResponse(place) {
  return {
    id: Number(place.id),
    userId: Number(place.userId),
    name: String(place.name || ''),
    address: place.address || '',
    placeType: ['home', 'work', 'gym', 'other'].includes(place.placeType) ? place.placeType : 'other',
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
    radiusMeters: place.radiusMeters != null ? Number(place.radiusMeters) : 100,
    locationTrigger: place.locationTrigger === 'leave' ? 'leave' : 'arrive',
    mapPreviewUrl: place.mapPreviewUrl || null,
    createdAt: place.createdAt,
    updatedAt: place.updatedAt
  };
}

function parseLocationSavedPlacePayload(body, existing = {}) {
  const placeTypes = ['home', 'work', 'gym', 'other'];
  const triggers = ['arrive', 'leave'];
  const name = body.name !== undefined ? plainText(body.name).slice(0, 120) : existing.name;
  const address = body.address !== undefined ? plainText(body.address).slice(0, 240) : (existing.address || '');
  const placeType = placeTypes.includes(body.placeType) ? body.placeType : (existing.placeType || 'other');
  const latitude = body.latitude !== undefined ? Number(body.latitude) : Number(existing.latitude);
  const longitude = body.longitude !== undefined ? Number(body.longitude) : Number(existing.longitude);
  const radiusMeters = body.radiusMeters !== undefined ? Number(body.radiusMeters) : Number(existing.radiusMeters || 100);
  const locationTrigger = triggers.includes(body.locationTrigger) ? body.locationTrigger : (existing.locationTrigger || 'arrive');
  const mapPreviewUrl = body.mapPreviewUrl !== undefined ? (String(body.mapPreviewUrl || '') || null) : (existing.mapPreviewUrl || null);
  if (!name) return { error: 'name is required.' };
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { error: 'latitude and longitude are required.' };
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return { error: 'radiusMeters must be positive.' };
  return { name, address, placeType, latitude, longitude, radiusMeters, locationTrigger, mapPreviewUrl };
}

app.get('/api/location-saved-places', requireAuth, asyncRoute(async (req, res) => {
  const places = await all(
    `SELECT * FROM location_saved_places WHERE userId = ? ORDER BY updatedAt DESC, id DESC`,
    [req.user.id]
  );
  res.json(places.map(locationSavedPlaceResponse));
}));

app.post('/api/location-saved-places', requireAuth, asyncRoute(async (req, res) => {
  const parsed = parseLocationSavedPlacePayload(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const now = new Date().toISOString();
  const result = await run(
    `INSERT INTO location_saved_places
       (userId, name, address, placeType, latitude, longitude, radiusMeters, locationTrigger, mapPreviewUrl, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, parsed.name, parsed.address, parsed.placeType, parsed.latitude, parsed.longitude, parsed.radiusMeters, parsed.locationTrigger, parsed.mapPreviewUrl, now, now]
  );
  const place = await get('SELECT * FROM location_saved_places WHERE id = ? AND userId = ?', [result.id, req.user.id]);
  res.status(201).json(locationSavedPlaceResponse(place));
}));

app.patch('/api/location-saved-places/:id', requireAuth, asyncRoute(async (req, res) => {
  const place = await get('SELECT * FROM location_saved_places WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
  if (!place) return res.status(404).json({ error: 'Saved place not found.' });
  const parsed = parseLocationSavedPlacePayload(req.body || {}, place);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const now = new Date().toISOString();
  await run(
    `UPDATE location_saved_places
     SET name = ?, address = ?, placeType = ?, latitude = ?, longitude = ?, radiusMeters = ?, locationTrigger = ?, mapPreviewUrl = ?, updatedAt = ?
     WHERE id = ? AND userId = ?`,
    [parsed.name, parsed.address, parsed.placeType, parsed.latitude, parsed.longitude, parsed.radiusMeters, parsed.locationTrigger, parsed.mapPreviewUrl, now, place.id, req.user.id]
  );
  const updated = await get('SELECT * FROM location_saved_places WHERE id = ? AND userId = ?', [place.id, req.user.id]);
  res.json(locationSavedPlaceResponse(updated));
}));

app.delete('/api/location-saved-places/:id', requireAuth, asyncRoute(async (req, res) => {
  const place = await get('SELECT * FROM location_saved_places WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
  if (!place) return res.status(404).json({ error: 'Saved place not found.' });
  await run('DELETE FROM location_saved_places WHERE id = ? AND userId = ?', [place.id, req.user.id]);
  res.status(204).end();
}));

app.post('/api/reminders', requireAuth, asyncRoute(async (req, res) => {
  const payload = normalizeReminderPayload(req.body || {});
  if (!payload.dueAtUtc && !payload.locationName) return res.status(400).json({ error: 'Either dueAtUtc or locationName is required.' });
  if (payload.dueAtUtc && !Number.isFinite(Date.parse(payload.dueAtUtc))) return res.status(400).json({ error: 'dueAtUtc must be a valid date.' });
  if (payload.locationName && (payload.latitude == null || payload.longitude == null)) {
    return res.status(400).json({ error: 'Location reminders require locationName, latitude, and longitude.' });
  }
  if (payload.radiusMeters != null && (!Number.isFinite(payload.radiusMeters) || payload.radiusMeters <= 0)) {
    return res.status(400).json({ error: 'radiusMeters must be positive.' });
  }
  const noteIdVal = payload.noteId;
  if (noteIdVal) {
    const note = await getAccessibleNote(noteIdVal, req.user.id);
    if (!note) return res.status(404).json({ error: 'Note not found.' });
  }
  const now = new Date().toISOString();
  const stamp = serverLwwStamp();
  const syncId = String(req.body.syncId || req.body.clientId || `reminder-${crypto.randomUUID()}`);

  const existing = noteIdVal ? await get('SELECT * FROM reminders WHERE noteId = ? AND userId = ?', [noteIdVal, req.user.id]) : null;
  const scheduleChanged = existing ? reminderScheduleDefinitionChanged(existing, payload) : false;
  const scheduleVersion = existing ? Number(existing.scheduleVersion || 1) + (scheduleChanged ? 1 : 0) : 1;
  const scheduleAnchorAtUtc = scheduleChanged ? payload.dueAtUtc : (existing?.scheduleAnchorAtUtc || existing?.dueAtUtc || payload.dueAtUtc);
  const reminder = await get(
    `INSERT INTO reminders (noteId, userId, dueAtUtc, timezone, repeatRule, status, title, body, imageUrl, locationName, latitude, longitude, radiusMeters, locationTrigger, scheduleVersion, scheduleAnchorAtUtc, createdAt, updatedAt, syncId, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(userId, noteId) DO UPDATE SET
       userId = excluded.userId,
       syncId = COALESCE(reminders.syncId, excluded.syncId),
       dueAtUtc = excluded.dueAtUtc,
       timezone = excluded.timezone,
       repeatRule = excluded.repeatRule,
       status = 'pending',
       title = excluded.title,
       body = excluded.body,
       imageUrl = excluded.imageUrl,
       locationName = excluded.locationName,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       radiusMeters = excluded.radiusMeters,
       locationTrigger = excluded.locationTrigger,
       scheduleAnchorAtUtc = CASE
         WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
         THEN excluded.scheduleAnchorAtUtc ELSE COALESCE(reminders.scheduleAnchorAtUtc, reminders.dueAtUtc) END,
       scheduleVersion = reminders.scheduleVersion + CASE
         WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
         THEN 1 ELSE 0 END,
       updatedAt = excluded.updatedAt,
       lwwPhysicalMs = excluded.lwwPhysicalMs,
       lwwLogical = excluded.lwwLogical,
       lwwDeviceId = excluded.lwwDeviceId,
       lwwOperationId = excluded.lwwOperationId
     RETURNING *`,
    [
      noteIdVal,
      req.user.id,
      payload.dueAtUtc,
      payload.timezone,
      payload.repeatRule,
      payload.title,
      payload.body,
      payload.imageUrl,
      payload.locationName,
      payload.latitude,
      payload.longitude,
      payload.radiusMeters,
      payload.locationTrigger,
      scheduleVersion,
      scheduleAnchorAtUtc,
      now,
      now,
      syncId,
      stamp.physicalMs,
      stamp.logical,
      stamp.deviceId,
      stamp.operationId
    ]
  );
  await recordReminderSyncChange(reminder, 'upsert');
  const enrichedReminder = await enrichReminderResponse(reminder);
  const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
  if (caldav) pushReminderToCaldav(caldav, enrichedReminder).catch(err => console.error('CalDAV push failed:', err.message));
  gcalPushReminder(req.user.id, enrichedReminder).catch(err => console.error('GCal push failed:', err.message));
  res.status(existing ? 200 : 201).json(enrichedReminder);
}));

app.patch('/api/reminders/:id', requireAuth, asyncRoute(async (req, res) => {
  const reminder = await get('SELECT * FROM reminders WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });
  if (!(await reminderIsVisibleToUser(reminder, req.user.id))) return res.status(404).json({ error: 'Reminder not found.' });
  const now = new Date().toISOString();
  const stamp = serverLwwStamp();
  const validStatuses = ['pending','fired','dismissed','snoozed'];
  const payload = normalizeReminderPayload(req.body || {}, reminder);
  const status = validStatuses.includes(payload.status) ? payload.status : reminder.status;
  const dueAtUtc = payload.dueAtUtc;
  const timezone = payload.timezone || reminder.timezone || 'UTC';
  const locationName = payload.locationName;
  const latitude = payload.latitude;
  const longitude = payload.longitude;
  const radiusMeters = payload.radiusMeters;
  const locationTrigger = payload.locationTrigger;
  const repeatRule = payload.repeatRule;
  if (dueAtUtc && !Number.isFinite(Date.parse(dueAtUtc))) return res.status(400).json({ error: 'dueAtUtc must be a valid date.' });
  const scheduleChanged = reminderScheduleChanged(reminder, { dueAtUtc, timezone, repeatRule });
  const scheduleVersion = Number(reminder.scheduleVersion || 1) + (scheduleChanged ? 1 : 0);
  const scheduleAnchorAtUtc = scheduleChanged ? dueAtUtc : (reminder.scheduleAnchorAtUtc || reminder.dueAtUtc || dueAtUtc);
  const repeat = status === 'fired' ? parseRepeatRule(repeatRule) : null;
  const rolledDueAtUtc = repeat ? nextRepeatDueAt(dueAtUtc, repeat, timezone, Date.now(), reminder.scheduleAnchorAtUtc || dueAtUtc) : null;
  const finalStatus = rolledDueAtUtc ? 'pending' : status;
  const finalDueAtUtc = rolledDueAtUtc || dueAtUtc;

  if (!finalDueAtUtc && !locationName) return res.status(400).json({ error: 'Either dueAtUtc or locationName is required.' });
  if (locationName && (latitude == null || longitude == null)) {
    return res.status(400).json({ error: 'Location reminders require locationName, latitude, and longitude.' });
  }
  if (radiusMeters != null && (!Number.isFinite(radiusMeters) || radiusMeters <= 0)) {
    return res.status(400).json({ error: 'radiusMeters must be positive.' });
  }

  const update = await run(
    `UPDATE reminders SET
       status = ?, dueAtUtc = ?, timezone = ?, repeatRule = ?, locationName = ?, latitude = ?, longitude = ?, radiusMeters = ?, locationTrigger = ?, updatedAt = ?,
       scheduleVersion = ?, scheduleAnchorAtUtc = ?,
       lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?, lwwOperationId = ?,
       syncId = CASE WHEN syncId IS NULL OR syncId = '' THEN ? ELSE syncId END
      WHERE id = ? AND scheduleVersion = ?`,
    [finalStatus, finalDueAtUtc, timezone, repeatRule, locationName, latitude, longitude, radiusMeters, locationTrigger, now,
      scheduleVersion, scheduleAnchorAtUtc, stamp.physicalMs, stamp.logical, stamp.deviceId, stamp.operationId,
      `reminder-${crypto.randomUUID()}`, reminder.id, Number(reminder.scheduleVersion || 1)]
  );
  if (!update.changes) return res.status(409).json({ error: 'Reminder schedule changed. Reload before editing.' });
  const updated = await get('SELECT * FROM reminders WHERE id = ?', [reminder.id]);
  await recordReminderSyncChange(updated, 'upsert');
  const enrichedUpdated = await enrichReminderResponse(updated);
  if ((rolledDueAtUtc || finalStatus === 'fired') && repeat?.moveToTopOnTrigger) await floatReminderNoteToTop(req.user.id, reminder.noteId);
  if (finalStatus === 'pending') {
    const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
    if (caldav) pushReminderToCaldav(caldav, enrichedUpdated).catch(err => console.error('CalDAV push failed:', err.message));
    gcalPushReminder(req.user.id, enrichedUpdated).catch(err => console.error('GCal push failed:', err.message));
  }
  res.json(enrichedUpdated);
}));

app.delete('/api/reminders/:id', requireAuth, asyncRoute(async (req, res) => {
  const reminder = await get('SELECT * FROM reminders WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });
  const stamp = serverLwwStamp();
  reminder.syncId = reminder.syncId || `reminder-${crypto.randomUUID()}`;
  reminder.lwwPhysicalMs = stamp.physicalMs;
  reminder.lwwLogical = stamp.logical;
  reminder.lwwDeviceId = stamp.deviceId;
  reminder.lwwOperationId = stamp.operationId;
  await run('DELETE FROM reminders WHERE id = ?', [reminder.id]);
  await recordReminderSyncChange(reminder, 'delete');
  const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
  if (caldav) deleteReminderFromCaldav(caldav, reminder.id).catch(err => console.error('CalDAV delete failed:', err.message));
  gcalDeleteReminder(req.user.id, reminder).catch(err => console.error('GCal delete failed:', err.message));
  res.status(204).end();
}));

// ─── CalDAV settings routes ────────────────────────────────────────────────

app.get('/api/caldav/settings', requireAuth, asyncRoute(async (req, res) => {
  const s = await get('SELECT * FROM caldav_settings WHERE userId = ?', [req.user.id]);
  if (!s) return res.json(null);
  res.json({ serverUrl: s.serverUrl, calendarUrl: s.calendarUrl, username: s.username, enabled: Boolean(s.enabled) });
}));

app.put('/api/caldav/settings', requireAuth, asyncRoute(async (req, res) => {
  const { serverUrl, calendarUrl, username, password, enabled } = req.body;
  if (!calendarUrl || !username || !password) {
    return res.status(400).json({ error: 'calendarUrl, username, and password are required.' });
  }
  const now = new Date().toISOString();
  const existing = await get('SELECT userId FROM caldav_settings WHERE userId = ?', [req.user.id]);
  const isPlaceholder = password === '••••••••';
  if (existing) {
    if (isPlaceholder) {
      await run(`UPDATE caldav_settings SET serverUrl=?, calendarUrl=?, username=?, enabled=?, updatedAt=? WHERE userId=?`,
        [serverUrl || calendarUrl, calendarUrl, username, enabled ? 1 : 0, now, req.user.id]);
    } else {
      await run(`UPDATE caldav_settings SET serverUrl=?, calendarUrl=?, username=?, password=?, enabled=?, updatedAt=? WHERE userId=?`,
        [serverUrl || calendarUrl, calendarUrl, username, password, enabled ? 1 : 0, now, req.user.id]);
    }
  } else {
    await run(`INSERT INTO caldav_settings (userId, serverUrl, calendarUrl, username, password, enabled, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)`,
      [req.user.id, serverUrl || calendarUrl, calendarUrl, username, password, enabled ? 1 : 0, now, now]);
  }
  const s = await get('SELECT * FROM caldav_settings WHERE userId = ?', [req.user.id]);
  // Backfill: PUT every existing pending reminder to the CalDAV server. The
  // reminder id is the URL key, so re-pushing is idempotent (PUT overwrites).
  // Fire-and-forget so the settings save doesn't wait on N HTTP round-trips.
  if (s && s.enabled) {
    backfillCaldavReminders(s).catch(err =>
      console.error('CalDAV backfill failed:', err.message)
    );
  }
  res.json({ serverUrl: s.serverUrl, calendarUrl: s.calendarUrl, username: s.username, enabled: Boolean(s.enabled) });
}));

async function backfillCaldavReminders(settings) {
  const reminders = await all(
    `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ?
     AND reminders.status = 'pending'
     AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
    [settings.userId]
  );
  const enrichedReminders = await enrichReminderResponses(reminders);
  for (const reminder of enrichedReminders) {
    try {
      await pushReminderToCaldav(settings, reminder);
    } catch (err) {
      console.error(`CalDAV backfill failed for reminder ${reminder.id}:`, err.message);
    }
  }
}

app.delete('/api/caldav/settings', requireAuth, asyncRoute(async (req, res) => {
  await run('DELETE FROM caldav_settings WHERE userId = ?', [req.user.id]);
  res.status(204).end();
}));

app.post('/api/caldav/test', requireAuth, asyncRoute(async (req, res) => {
  const { calendarUrl, username, password } = req.body;
  if (!calendarUrl || !username || !password) {
    return res.status(400).json({ error: 'calendarUrl, username, and password are required.' });
  }
  try {
    const result = await testCaldavConnection({ calendarUrl, username, password });
    res.json({ ok: true, httpStatus: result.status });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
}));

// ─── Google Calendar routes ────────────────────────────────────────────────

app.get('/api/google-calendar/status', requireAuth, asyncRoute(async (req, res) => {
  const row = await get('SELECT clientId, accessToken, enabled FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
  res.json({
    hasCredentials: !!row,
    connected: !!(row?.accessToken),
    enabled: !!(row?.enabled),
    clientId: row?.clientId || null
  });
}));

app.put('/api/google-calendar/credentials', requireAuth, asyncRoute(async (req, res) => {
  const { clientId, clientSecret, enabled } = req.body;
  if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret are required.' });
  const now = new Date().toISOString();
  const existing = await get('SELECT userId, clientSecret FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
  const isPlaceholder = clientSecret === '••••••••';
  if (existing) {
    if (isPlaceholder) {
      await run('UPDATE google_calendar_tokens SET clientId = ?, enabled = ?, updatedAt = ? WHERE userId = ?',
        [clientId, enabled ? 1 : 0, now, req.user.id]);
    } else {
      await run('UPDATE google_calendar_tokens SET clientId = ?, clientSecret = ?, enabled = ?, updatedAt = ? WHERE userId = ?',
        [clientId, clientSecret, enabled ? 1 : 0, now, req.user.id]);
    }
  } else {
    if (isPlaceholder) return res.status(400).json({ error: 'Client secret is required.' });
    await run(
      'INSERT INTO google_calendar_tokens (userId, clientId, clientSecret, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, clientId, clientSecret, enabled ? 1 : 0, now, now]
    );
  }
  res.json({ ok: true });
}));

app.post('/api/auth/google/initiate', requireAuth, asyncRoute(async (req, res) => {
  const row = await get('SELECT clientId FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
  if (!row?.clientId) return res.status(400).json({ error: 'Google credentials not configured.' });
  const state = randomHex(16);
  oauthStates.set(state, { userId: req.user.id, createdAt: Date.now() });
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${baseUrl}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: row.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.events',
    access_type: 'offline',
    prompt: 'consent',
    state
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
}));

app.get('/api/auth/google/callback', asyncRoute(async (req, res) => {
  const { code, state, error } = req.query;
  if (error || !code || !state) {
    return res.redirect('/settings?google=error&message=' + encodeURIComponent(String(error || 'Authorization cancelled.')));
  }
  const stateData = oauthStates.get(String(state));
  if (!stateData) {
    return res.redirect('/settings?google=error&message=' + encodeURIComponent('Invalid or expired state. Please try again.'));
  }
  oauthStates.delete(String(state));
  const row = await get('SELECT * FROM google_calendar_tokens WHERE userId = ?', [stateData.userId]);
  if (!row) {
    return res.redirect('/settings?google=error&message=' + encodeURIComponent('Credentials not found. Please save them first.'));
  }
  const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
  const redirectUri = `${baseUrl}/api/auth/google/callback`;
  try {
    const tokens = await exchangeGoogleCode(row.clientId, row.clientSecret, String(code), redirectUri);
    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
    await run(
      'UPDATE google_calendar_tokens SET accessToken = ?, refreshToken = COALESCE(?, refreshToken), tokenExpiry = ?, enabled = 1, updatedAt = ? WHERE userId = ?',
      [tokens.access_token, tokens.refresh_token || null, expiry, new Date().toISOString(), stateData.userId]
    );
    // Backfill: push any existing pending reminders that haven't been synced
    // yet. Fire-and-forget so the OAuth redirect isn't held up by the
    // calendar API round-trips. gcalCreateAndStore writes the event ID back
    // onto each reminder so future updates/deletes find them.
    backfillGoogleCalendarReminders(stateData.userId).catch(err =>
      console.error('GCal backfill failed:', err.message)
    );
    res.redirect('/settings?google=connected');
  } catch (err) {
    res.redirect('/settings?google=error&message=' + encodeURIComponent(err.message));
  }
}));

async function backfillGoogleCalendarReminders(userId) {
  const token = await getValidGoogleToken(userId);
  if (!token) return;
  const reminders = await all(
    `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ?
     AND reminders.status = 'pending'
     AND reminders.gcalEventId IS NULL
     AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
    [userId]
  );
  const enrichedReminders = await enrichReminderResponses(reminders);
  for (const reminder of enrichedReminders) {
    try {
      await gcalCreateAndStore(userId, reminder, token);
    } catch (err) {
      console.error(`GCal backfill failed for reminder ${reminder.id}:`, err.message);
    }
  }
}

app.delete('/api/google-calendar/disconnect', requireAuth, asyncRoute(async (req, res) => {
  await run(
    'UPDATE google_calendar_tokens SET accessToken = NULL, refreshToken = NULL, tokenExpiry = NULL, updatedAt = ? WHERE userId = ?',
    [new Date().toISOString(), req.user.id]
  );
  res.status(204).end();
}));

app.delete('/api/google-calendar/credentials', requireAuth, asyncRoute(async (req, res) => {
  await run('DELETE FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
  res.status(204).end();
}));

// ─── Update check ───────────────────────────────────────────────────────────


mountLinkPreviewRoutes(app);


mountTakeoutImportRoutes(app, {
  SAFE_IMAGE_TYPES, PRIVATE_IMAGE_PREFIX, findOrCreateLabelForUser, noteExtraFields, syncNoteImagesForNote, recordNoteSyncChange
});

mountStaticAssets(app, staticDir);

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large for this upload.'
      : error.message;
    return res.status(400).json({ error: message });
  }
  if (String(error?.message || '').startsWith('Only PNG, JPG, GIF, and WEBP uploads are supported.') || error.message === 'Only ZIP files are supported.' || error.message === 'This file type is not allowed. Supported formats: PDF, Office documents, text files, and archives.') {
    return res.status(400).json({ error: error.message });
  }

  if (error && error.code === 'SQLITE_CONSTRAINT') {
    return res.status(409).json({ error: 'A record with that value already exists.' });
  }

  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Server error.' });
});

// A stray rejected promise or socket error must not take the whole server down mid-request.
process.on('unhandledRejection', reason => console.error('Unhandled rejection', reason));
process.on('uncaughtException', error => console.error('Uncaught exception', error));

// Docker stops with SIGTERM: stop taking connections, let queued database work finish, then close the database.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down.`);
  setTimeout(() => process.exit(1), 8000).unref();
  const finish = async () => {
    await databaseIdle();
    await closeDatabase().catch(() => {});
    process.exit(0);
  };
  terminateRealtimeClients();
  server.close(() => { finish(); });
  server.closeIdleConnections?.();
  // Keep-alive connections would hold server.close open; finish even if they linger.
  setTimeout(() => { finish(); }, 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

init().then(() => {
  setupRealtime({ server, getAccessibleNote, getNoteRecipientIds });
  if (process.env.KEEPARR_TEST_MODE !== '1') startReminderScheduler();
  startBackupScheduler();
  startHousekeeping();
  cleanupStaleTakeoutUploads();
  server.listen(port, () => {
    console.log(`Keep API listening on http://127.0.0.1:${port}`);
    console.log(`Keep realtime listening on ws://127.0.0.1:${port}/api/realtime`);
    console.log(`SQLite database: ${dbPath}`);
    scheduleStartupMaintenance();
  });
}).catch(error => {
  console.error(error);
  process.exit(1);
});
