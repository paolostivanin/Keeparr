// Changing notes: broadcasting changes, ordering, trash purge, startup maintenance and floating a reminder's note to the top.
const crypto = require('crypto');
const { afterDatabaseCommit, all, run } = require('./db');
const { backfillExistingNoteImages, deleteAttachmentFilesForNote, deleteImageFilesForNote } = require('./files');
const { broadcastRealtime } = require('./realtime');
const { getAccessibleNote, getNoteRecipientIds } = require('./note-data');
const { getAppSetting, setAppSetting } = require('./app-settings');
const { orderedAccessibleIds } = require('./note-order');
const { recordDependentSyncDeletesForNote, recordNoteSyncChange } = require('./sync-changes');
const { serverLwwStamp } = require('./sync-protocol');

async function trashExpirationCutoff() {
  const days = Number(await getAppSetting('trashRetentionDays', '10'));
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function purgeExpiredTrashedNotes() {
  const expired = await all('SELECT * FROM notes WHERE trashed = 1 AND trashedAt IS NOT NULL AND trashedAt <= ?', [await trashExpirationCutoff()]);
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

module.exports = {
  applyNoteOrder, broadcastNoteChange, floatReminderNoteToTop, moveNoteToTopForUsers, scheduleStartupMaintenance, scheduleTrashPurgeIfStale
};
