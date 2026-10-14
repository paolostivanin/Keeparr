// Labels: lookup and creation, normalizing a note's labels and cleaning up unused ones.
const { all, get, run } = require('./db');
const { getNoteRecipientIds } = require('./note-data');
const { parseJson } = require('./note-text');
const { recordNoteSyncChange } = require('./sync-changes');
const { serverLwwStamp } = require('./sync-protocol');

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

module.exports = {
  backfillImportedNoteLabels, cleanupUnusedLabels, findLabelForUser, findOrCreateLabelForUser, updateNoteLabelReferencesForUser
};
