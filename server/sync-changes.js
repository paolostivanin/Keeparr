// Recording the change feed: note, reminder and attachment changes and the reminder shapes they carry.
const crypto = require('crypto');
const { all, run } = require('./db');
const { dbNoteToApi, getAccessibleNote, getNoteRecipientIds, hydrateNoteUserFields } = require('./note-data');
const { reminderResponse } = require('./reminder-model');
const { rowLwwStamp, serverLwwStamp } = require('./sync-protocol');

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

module.exports = {
  attachmentResponse, enrichReminderResponse, enrichReminderResponses, recordAttachmentSyncChange, recordDependentSyncDeletesForNote, recordNoteSyncChange, recordReminderSyncChange, reminderIsVisibleToUser
};
