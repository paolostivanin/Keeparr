// Sync for the web and native clients: the document snapshot and change feed, the mutation endpoint and the handlers that
// apply each kind of client mutation.
const crypto = require('crypto');
const fs = require('fs');
const { run, get, all, withDatabaseTransaction, withDatabaseExclusive, afterDatabaseCommit } = require('./db');
const { asyncRoute, requireAuth } = require('./auth');
const { broadcastRealtime } = require('./realtime');
const { hitTestFault } = require('./test-faults');
const { occurrenceId } = require('./native-client');
const { isRepeatOccurrence } = require('./reminder-recurrence');
const { parseJson } = require('./note-text');
const { parseOrderPositions } = require('./note-order');
const {
  accessibleAttachmentRows, canonicalizeNotePayload, dbNoteToApi, getAccessibleNote, getNoteRecipientIds, hydrateNoteUserFields, nextTrashedAt, noteExtraFields
} = require('./note-data');
const { applyNoteOrder, broadcastNoteChange } = require('./notes');
const { attachmentPath, deleteAttachmentFilesForNote, deleteImageFilesForNote, syncNoteImagesForNote } = require('./files');
const {
  attachmentResponse, enrichReminderResponse, enrichReminderResponses, recordAttachmentSyncChange, recordDependentSyncDeletesForNote, recordNoteSyncChange, recordReminderSyncChange, reminderIsVisibleToUser
} = require('./sync-changes');
const { cleanupUnusedLabels } = require('./labels');
const {
  visibleReminderWhere, reminderScheduleChanged, parseRepeatRule, normalizeReminderPayload,
  normalizeReminderDueAt
} = require('./reminder-model');
const {
  serverLwwStamp, normalizeLwwStamp, rowLwwStamp, compareLwwStamp, clampClientSortOrder, parseChangesQuery
} = require('./sync-protocol');
const { mountSyncMutationRoute } = require('./sync-routes');
const { gcalDeleteReminder } = require('./google-calendar');
const { deleteReminderFromCaldav } = require('./calendar');

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

function mountSyncRoutes(app) {
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

  app.get('/api/native/reminders/occurrences', requireAuth, asyncRoute(async (req, res) => {
    res.json(await nativeOccurrencesForUser(req.user.id));
  }));

  mountSyncMutationRoute(app, {
    requireAuth,
    asyncRoute,
    executeSyncMutation,
    syncSnapshotForUser,
    syncCursorForUser,
    testMode: process.env.KEEPARR_TEST_MODE === '1'
  });
}

module.exports = { persistReminderOccurrence, mountSyncRoutes };
