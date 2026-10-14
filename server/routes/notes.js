// Note routes: listing and search, create, edit, share, merge, labels and delete.
const crypto = require('crypto');
const {
  accessibleAttachmentRows, accessibleNoteSummaries, canonicalizeNotePayload, dbNoteToApi, dbNoteToCard, decodeNotesCursor, encodeNotesCursor, getAccessibleNote, getCollaboratorsForNote, getNoteRecipientIds, getOwnedNote, nextTrashedAt, noteExtraFields
} = require('../note-data');
const { afterDatabaseCommit, all, get, run, withDatabaseTransaction } = require('../db');
const { applyNoteOrder, broadcastNoteChange, moveNoteToTopForUsers, scheduleTrashPurgeIfStale } = require('../notes');
const { asyncRoute, requireAuth } = require('../auth');
const { attachmentResponse, recordDependentSyncDeletesForNote, recordNoteSyncChange } = require('../sync-changes');
const { broadcastRealtime, realtimeClients } = require('../realtime');
const { cleanupUnusedLabels } = require('../labels');
const { createPerfTrace, sendJsonWithPerf } = require('../perf');
const { deleteAttachmentFilesForNote, deleteImageFilesForNote, syncNoteImagesForNote } = require('../files');
const { deleteReminderFromCaldav } = require('../calendar');
const { gcalDeleteReminder } = require('../google-calendar');
const { hitTestFault } = require('../test-faults');
const { mcpNoteIsUnlocked, mcpNoteResponse } = require('../note-lock');
const { noteOperatorWhere, noteSearchWhere, searchGroupsFromQuery, searchOperatorsFromQuery } = require('../note-search');
const { parseJson } = require('../note-text');
const { parseOrderPositions } = require('../note-order');
const { serverLwwStamp } = require('../sync-protocol');

function mountNoteRoutes(app) {
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
}

module.exports = {
  mountNoteRoutes
};
