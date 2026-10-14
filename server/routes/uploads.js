// Image uploads and note attachments.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  PRIVATE_IMAGE_PREFIX, attachmentPath, imageMimeType, safeDownloadName, safeStoredImageFilename, sha256File, upload, uploadAttachment
} = require('../files');
const { asyncRoute, requireAuth, requireAuthOrMediaTicket } = require('../auth');
const { attachmentResponse, recordAttachmentSyncChange } = require('../sync-changes');
const { broadcastNoteChange } = require('../notes');
const { get, run, withDatabaseTransaction } = require('../db');
const { getAccessibleNote, getNoteRecipientIds } = require('../note-data');
const { mcpNoteIsUnlocked } = require('../note-lock');
const { serverLwwStamp } = require('../sync-protocol');
const { uploadDir } = require('../config');

function mountUploadRoutes(app) {
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
}

module.exports = {
  mountUploadRoutes
};
