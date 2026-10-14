// Uploaded images and attachments: allowed types, the multer storages, stored file names and cleanup, and keeping a note's image rows in step with its content.
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { afterDatabaseCommit, all, get, run } = require('./db');
const { attachmentDir, uploadDir } = require('./config');
const { parseJson } = require('./note-text');
const { randomHex } = require('./auth');

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

module.exports = {
  PRIVATE_IMAGE_PREFIX, SAFE_IMAGE_TYPES, attachmentPath, backfillExistingNoteImages, canonicalizeNoteHtmlImages, canonicalizeNoteImages, deleteAttachmentFilesForNote, deleteImageFilesForNote, imageMimeType, safeDownloadName, safeStoredImageFilename, sha256File, syncNoteImagesForNote, upload, uploadAttachment
};
