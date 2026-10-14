// Google Takeout import: validates the uploaded zip, converts Keep JSON into notes, labels and images, and removes
// stale uploads.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { run, get, all, withDatabaseTransaction } = require('./db');
const { takeoutTmpDir, uploadDir } = require('./config');
const { randomHex, asyncRoute, requireAuth } = require('./auth');
const { plainText, escapeHtml } = require('./note-text');
const { neutralizeActiveHtml } = require('./html-safety');
const { serverLwwStamp } = require('./sync-protocol');
const { broadcastRealtime } = require('./realtime');

const KEEP_COLOR_MAP = {
  DEFAULT: '', WHITE: '', GRAY: '',
  RED: '#f8c7c0', ORANGE: '#fddcbb', YELLOW: '#fff8b8',
  GREEN: '#ccff90', TEAL: '#e6f4d7', BLUE: '#d2e3fc',
  CERULEAN: '#cbf0f8', PURPLE: '#d7aefb', PINK: '#fdcfe8',
  BROWN: '#fddcbb',
};

function parseByteSize(value, fallbackBytes) {
  if (value === undefined || value === null || value === '') return fallbackBytes;
  const raw = String(value).trim();
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i);
  if (!match) return fallbackBytes;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return fallbackBytes;
  const unit = String(match[2] || 'b').toLowerCase();
  const multiplier = unit === 'gb' || unit === 'gib'
    ? 1024 ** 3
    : unit === 'mb' || unit === 'mib'
      ? 1024 ** 2
      : unit === 'kb' || unit === 'kib'
        ? 1024
        : 1;
  return Math.floor(amount * multiplier);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value >= 10 || unitIndex === 0 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`;
}

const TAKEOUT_UPLOAD_MAX_BYTES = parseByteSize(
  process.env.KEEPARR_TAKEOUT_UPLOAD_MAX || process.env.KEEPARR_TAKEOUT_UPLOAD_MAX_BYTES,
  5 * 1024 * 1024 * 1024
);

const uploadZip = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, takeoutTmpDir),
    filename: (_req, file, cb) => {
      const originalExt = path.extname(file.originalname || '').toLowerCase() || '.zip';
      cb(null, `takeout-${Date.now()}-${randomHex(12)}${originalExt}`);
    }
  }),
  limits: { fileSize: TAKEOUT_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype === 'application/zip'
      || file.mimetype === 'application/x-zip-compressed'
      || file.originalname?.toLowerCase().endsWith('.zip');
    ok ? cb(null, true) : cb(new Error('Only ZIP files are supported.'));
  }
});

function googleTakeoutUpload(req, res, next) {
  uploadZip.single('takeout')(req, res, (error) => {
    if (!error) return next();
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Google Takeout ZIP is too large for this Keeparr server. The current Takeout upload limit is ${formatBytes(TAKEOUT_UPLOAD_MAX_BYTES)}. If this failed below that size, your proxy/CDN may be rejecting the upload before Keeparr receives it. Try importing over a direct LAN/SSH connection or raise your proxy upload limit.`
      });
    }
    if (error.message === 'Only ZIP files are supported.') {
      return res.status(400).json({ error: error.message });
    }
    next(error);
  });
}

async function cleanupStaleTakeoutUploads(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    const files = await fs.promises.readdir(takeoutTmpDir);
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(files.map(async (file) => {
      const filePath = path.join(takeoutTmpDir, file);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < cutoff) {
        await fs.promises.unlink(filePath).catch(() => {});
      }
    }));
  } catch (error) {
    console.warn('Takeout temp cleanup failed:', error.message);
  }
}

// Limits for Google Takeout zips. Real Keep exports are usually well under
// these caps; the goal is to prevent zip bombs and path-traversal entries
// without breaking large legitimate exports.
const TAKEOUT_MAX_ENTRIES = 100_000;
const TAKEOUT_MAX_PER_ENTRY_BYTES = 250 * 1024 * 1024;     // 250 MB per file
const TAKEOUT_MAX_TOTAL_BYTES = 10 * 1024 * 1024 * 1024;   // 10 GB combined
const TAKEOUT_MAX_FILENAME_LEN = 1024;

function normalizeZipEntryName(name) {
  return String(name || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

function isUnsafeZipPath(name) {
  // Reject any traversal segments or absolute paths. We don't write entry
  // names to disk (we generate our own filenames), but we still treat unsafe
  // paths as a strong signal the upload is malicious.
  if (!name || name.length > TAKEOUT_MAX_FILENAME_LEN) return true;
  if (name.startsWith('/') || /^[A-Za-z]:[\\/]/.test(name)) return true;
  for (const segment of name.split('/')) {
    if (segment === '..' || segment === '.' && false) return true;
    if (segment === '..') return true;
  }
  return false;
}

function isKeepJsonEntry(entry) {
  return !entry.isDirectory && /(^|\/)(?:Takeout\/)?Keep\/[^/]+\.json$/i.test(entry.entryName);
}

function keepListText(item) {
  return String(item?.text ?? item?.title ?? item?.data ?? item?.name ?? '');
}

// Keep in sync with MAX_INDENT_LEVEL in src/app/utils/checkbox-indent.ts.
const MAX_CHECKBOX_INDENT_LEVEL = 3;

function keepListIndentFromValue(value) {
  if (value === true) return 1;
  const numeric = Math.floor(Number(value));
  if (!Number.isFinite(numeric) || numeric < 1) return 0;
  return Math.min(numeric, MAX_CHECKBOX_INDENT_LEVEL);
}

function keepListIndentLevel(item, fallbackLevel = 0) {
  const explicitKeys = [
    'indentLevel',
    'indentationLevel',
    'indent',
    'level',
    'depth',
    'nestingLevel',
    'childLevel'
  ];
  for (const key of explicitKeys) {
    if (item && item[key] !== undefined && item[key] !== null) {
      return keepListIndentFromValue(item[key]);
    }
  }

  const nestedLevel = Math.max(keepListIndentFromValue(fallbackLevel), 1);

  const parentKeys = ['parentId', 'parentItemId', 'parentListItemId', 'superListItemId', 'parent'];
  if (parentKeys.some(key => item && item[key] !== undefined && item[key] !== null && item[key] !== '')) return nestedLevel;

  const text = keepListText(item);
  if (/^(?:\t| {2,}|\u00a0{2,})/.test(text)) return nestedLevel;

  return keepListIndentFromValue(fallbackLevel);
}

function keepListChildren(item) {
  for (const key of ['children', 'childItems', 'subitems', 'subItems', 'items', 'listContent']) {
    if (Array.isArray(item?.[key]) && item[key].length) return item[key];
  }
  return [];
}

function importedKeepChecklistItems(listContent, fallbackLevel = 0, state = { nextId: 0 }) {
  const checkBoxes = [];
  if (!Array.isArray(listContent)) return checkBoxes;

  for (const item of listContent) {
    const rawText = keepListText(item);
    const indentLevel = keepListIndentLevel(item, fallbackLevel);
    checkBoxes.push({
      id: state.nextId++,
      data: escapeHtml(rawText.replace(/^(?:\t| {2,}|\u00a0{2,})/, '')),
      done: !!(item?.isChecked ?? item?.checked ?? item?.done),
      indentLevel
    });

    const children = keepListChildren(item);
    if (children.length) {
      checkBoxes.push(...importedKeepChecklistItems(children, indentLevel + 1, state));
    }
  }

  return checkBoxes;
}

async function readZipEntries(filePath) {
  let admZipError;
  let rawEntries;
  let getRawData;
  try {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(filePath);
    rawEntries = zip.getEntries();
    getRawData = (entry) => entry.getData();
  } catch (error) {
    admZipError = error;
  }

  if (!rawEntries) {
    try {
      const unzipper = require('unzipper');
      const directory = await unzipper.Open.file(filePath);
      rawEntries = directory.files.map(file => ({
        entryName: file.path,
        isDirectory: file.type === 'Directory' || /\/$/.test(file.path),
        _file: file
      }));
      getRawData = (entry) => entry._file.buffer();
    } catch (error) {
      console.error('Takeout ZIP parse error:', admZipError?.message || admZipError, error?.message || error);
      throw new Error('Invalid ZIP file. Upload the Google Takeout ZIP itself, with the stock Takeout/Keep folder inside it.');
    }
  }

  if (rawEntries.length > TAKEOUT_MAX_ENTRIES) {
    throw new Error(`ZIP has too many entries (${rawEntries.length}, max ${TAKEOUT_MAX_ENTRIES}).`);
  }

  let totalExtracted = 0;
  const entries = [];
  for (const raw of rawEntries) {
    const rawName = raw.entryName ?? raw.path ?? '';
    const normalized = normalizeZipEntryName(rawName);
    if (isUnsafeZipPath(normalized)) {
      throw new Error('ZIP contains an unsafe entry path. Aborting.');
    }
    entries.push({
      entryName: normalized,
      isDirectory: !!(raw.isDirectory ?? raw.type === 'Directory'),
      getData: async () => {
        // The declared size is checked before anything is inflated; adm-zip caps its output at that size.
        const declared = Number(raw.header?.size ?? raw._file?.uncompressedSize ?? 0);
        if (declared > TAKEOUT_MAX_PER_ENTRY_BYTES) {
          throw new Error(`Entry "${normalized}" is too large (${formatBytes(declared)}). Max ${formatBytes(TAKEOUT_MAX_PER_ENTRY_BYTES)}.`);
        }
        if (totalExtracted + declared > TAKEOUT_MAX_TOTAL_BYTES) {
          throw new Error(`ZIP expands beyond the safe extraction limit (${formatBytes(TAKEOUT_MAX_TOTAL_BYTES)}).`);
        }
        const data = await getRawData(raw);
        if (!data) return Buffer.alloc(0);
        if (data.length > TAKEOUT_MAX_PER_ENTRY_BYTES) {
          throw new Error(`Entry "${normalized}" is too large (${formatBytes(data.length)}). Max ${formatBytes(TAKEOUT_MAX_PER_ENTRY_BYTES)}.`);
        }
        totalExtracted += data.length;
        if (totalExtracted > TAKEOUT_MAX_TOTAL_BYTES) {
          throw new Error(`ZIP expands beyond the safe extraction limit (${formatBytes(TAKEOUT_MAX_TOTAL_BYTES)}).`);
        }
        return data;
      }
    });
  }
  return entries;
}

function mountTakeoutImportRoutes(app, {
  SAFE_IMAGE_TYPES, PRIVATE_IMAGE_PREFIX, findOrCreateLabelForUser, noteExtraFields, syncNoteImagesForNote, recordNoteSyncChange
}) {
  app.post('/api/import/google-takeout', requireAuth, googleTakeoutUpload, asyncRoute(async (req, res) => {
    const tempPath = req.file?.path;
    try {
      if (!req.file || !tempPath) return res.status(400).json({ error: 'No file uploaded.' });

      let entries;
      try {
        entries = await readZipEntries(tempPath);
      } catch (error) {
        return res.status(400).json({ error: error.message });
      }

      const attachmentsByName = {};
      for (const e of entries) {
        if (!e.isDirectory) attachmentsByName[path.basename(e.entryName)] = e;
      }

      const jsonEntries = entries.filter(isKeepJsonEntry);
      if (!jsonEntries.length) {
        return res.status(400).json({ error: 'No Google Keep notes found in this ZIP. Upload the full Takeout ZIP that contains Takeout/Keep/*.json files. If your ZIP is large and this appears incorrectly, try importing over a direct LAN/SSH connection because some proxies/CDNs reject large uploads before Keeparr can inspect them.' });
      }

      let imported = 0, skipped = 0, errors = 0, pinnedCount = 0, deduped = 0;
      const now = new Date().toISOString();
      const fieldPresence = { isPinned: 0, pinned: 0, isArchived: 0, archived: 0 };

      // Build a fingerprint set of existing notes for this user so re-running
      // the takeout import doesn't silently double everything. Fingerprint =
      // createdAt + first 200 chars of title + body, which Google's exports
      // keep stable across re-exports.
      try {
        await withDatabaseTransaction(async () => {
        const existingFingerprints = new Set();
        const existingRows = await all('SELECT noteTitle, noteBody, createdAt FROM notes WHERE ownerUserId = ?', [req.user.id]);
        for (const row of existingRows) {
          const fp = `${row.createdAt}|${(row.noteTitle || '').slice(0, 200)}|${(row.noteBody || '').slice(0, 200)}`;
          existingFingerprints.add(fp);
        }
        for (const entry of jsonEntries) {
          try {
            let note;
            try { note = JSON.parse((await entry.getData()).toString('utf8')); }
            catch (e) {
              if (e && /zip bomb|too many entries|too large|unsafe entry/i.test(e.message)) throw e;
              errors++; continue;
            }

            if (note.isTrashed) { skipped++; continue; }

            const bgColor = KEEP_COLOR_MAP[note.color] ?? '';

            let noteBody = '';
            if (note.textContent) {
              noteBody = note.textContent
                .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                .replace(/\n/g, '<br>');
            }
            if (note.annotations?.length) {
              const links = note.annotations
                .filter(a => a.url)
                .map(a => neutralizeActiveHtml(`<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.title || a.url)}</a>`))
                .join('<br>');
              if (links) noteBody = noteBody ? `${noteBody}<br>${links}` : links;
            }

            let isCbox = 0, checkBoxes = [];
            if (note.listContent?.length) {
              isCbox = 1;
              checkBoxes = importedKeepChecklistItems(note.listContent);
            }

            const images = [];
            for (const att of (note.attachments || [])) {
              const attMimeType = String(att.mimetype || '').toLowerCase();
              if (!SAFE_IMAGE_TYPES.has(attMimeType)) continue;
              const basename = path.basename(att.filePath || '');
              const attEntry = attachmentsByName[basename];
              if (!attEntry) continue;
              try {
                const ext = SAFE_IMAGE_TYPES.get(attMimeType);
                const filename = `${Date.now()}-${randomHex(12)}${ext}`;
                const data = await attEntry.getData();
                fs.writeFileSync(path.join(uploadDir, filename), data);
                images.push({ id: `img-${Date.now()}`, dataUrl: `${PRIVATE_IMAGE_PREFIX}${filename}`, name: basename, placement: 'top' });
              } catch (e) {
                if (e && /zip bomb|too many entries|too large|unsafe entry/i.test(e.message)) throw e;
                /* skip image */
              }
            }

            const labels = [];
            const seenLabels = new Set();
            for (const rawLabel of (note.labels || [])) {
              const labelName = String(rawLabel?.name || '').trim();
              if (!labelName) continue;
              const labelKey = labelName.toLowerCase();
              if (seenLabels.has(labelKey)) continue;
              seenLabels.add(labelKey);
              const label = await findOrCreateLabelForUser(req.user.id, labelName);
              labels.push({ id: label.id, name: label.name, added: true });
            }
            const createdAt = note.createdTimestampUsec ? new Date(note.createdTimestampUsec / 1000).toISOString() : now;
            const updatedAt = note.userEditedTimestampUsec ? new Date(note.userEditedTimestampUsec / 1000).toISOString() : now;

            // Skip notes that look like a re-import of something already present.
            const noteTitle = plainText(note.title || '') || '';
            const fingerprint = `${createdAt}|${noteTitle.slice(0, 200)}|${noteBody.slice(0, 200)}`;
            if (existingFingerprints.has(fingerprint)) { deduped++; continue; }
            existingFingerprints.add(fingerprint);

            // Google Keep Takeout uses `isPinned`; older or third-party exports
            // sometimes use `pinned`. Accept either to avoid silently dropping pins.
            if ('isPinned' in note) fieldPresence.isPinned++;
            if ('pinned' in note) fieldPresence.pinned++;
            if ('isArchived' in note) fieldPresence.isArchived++;
            if ('archived' in note) fieldPresence.archived++;
            const pinnedFlag = (note.isPinned || note.pinned) ? 1 : 0;
            const archivedFlag = (note.isArchived || note.archived) ? 1 : 0;
            if (pinnedFlag) pinnedCount++;
            // Keep imported notes in their original Keep recency order instead of
            // treating the import itself as the note date.
            const importSortOrder = new Date(updatedAt || createdAt || now).getTime() || Date.now();
            const lww = serverLwwStamp();
            const insertResult = await run(
              `INSERT INTO notes (ownerUserId, syncId, noteTitle, noteBody, pinned, bgColor, bgImage, checkBoxes, images, isCbox, labels, binder, extraFields, archived, trashed, sortOrder, createdAt, updatedAt, lastEditorUserId, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId)
             VALUES (?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, '', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [req.user.id, `note-${crypto.randomUUID()}`, noteTitle, noteBody, pinnedFlag, bgColor,
                JSON.stringify(checkBoxes), JSON.stringify(images), isCbox, JSON.stringify(labels),
                JSON.stringify(noteExtraFields(note)), archivedFlag, importSortOrder, createdAt, updatedAt, req.user.id,
               lww.physicalMs, lww.logical, lww.deviceId, lww.operationId]
            );
            // The /api/notes endpoint resolves `pinned` from the per-user
            // `user_pins` table, not the legacy `notes.pinned` column. Without
            // this insert, takeout-imported pinned notes would never appear
            // pinned in the UI.
            if (pinnedFlag) {
              await run('INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [req.user.id, insertResult.id]);
            }
            await syncNoteImagesForNote(insertResult.id, req.user.id, { noteBody, images });
            await recordNoteSyncChange(insertResult.id, 'upsert', [req.user.id]);
            imported++;
          } catch (e) {
            console.error('Takeout import error:', entry.entryName, e.message);
            errors++;
          }
        }
        });
      } catch (error) {
        if (error && /zip bomb|too many entries|too large|unsafe entry/i.test(error.message)) {
          return res.status(400).json({ error: error.message });
        }
        throw error;
      }

      console.log(
        `[Takeout import] user=${req.user.id} total=${jsonEntries.length} imported=${imported} skipped=${skipped} deduped=${deduped} errors=${errors} pinned=${pinnedCount}`,
        'fields=', fieldPresence
      );

      broadcastRealtime([req.user.id], { type: 'notes-changed' });
      res.json({ imported, skipped, deduped, errors, pinnedCount, total: jsonEntries.length, fieldPresence });
    } finally {
      if (tempPath) {
        fs.promises.unlink(tempPath).catch(() => {});
      }
    }
  }));
}

module.exports = { mountTakeoutImportRoutes, cleanupStaleTakeoutUploads };
