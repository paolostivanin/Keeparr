const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const port = 3300 + Math.floor(Math.random() * 1000);
const dbPath = path.join(os.tmpdir(), `keeparr-sync-smoke-${process.pid}.sqlite`);
const base = `http://127.0.0.1:${port}/api`;

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${pathname} failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function waitForServer(child) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited early with ${child.exitCode}`);
    try {
      await request('/setup/status');
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 150));
    }
  }
  throw new Error('Server did not start in time.');
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function main() {
  const child = childProcess.spawn('node', ['server/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));

  try {
    await waitForServer(child);
    await request('/setup/admin', {
      method: 'POST',
      body: JSON.stringify({ username: 'sync-test', displayName: 'Sync Test', password: 'test-password-123' })
    });
    const login = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'sync-test', password: 'test-password-123' })
    });
    const token = login.token;
    const headers = authHeaders(token);
    assert.strictEqual(login.user.showPastReminders, false, 'past reminders should be hidden by default');
    const updatedPreferences = await request('/users/me/preferences', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ showPastReminders: true })
    });
    assert.strictEqual(updatedPreferences.showPastReminders, true, 'past reminder preference should be persisted');
    assert.strictEqual(updatedPreferences.theme, 'light', 'updating another preference should not change the theme');
    const loadedPreferences = await request('/users/me/preferences', { headers });
    assert.strictEqual(loadedPreferences.showPastReminders, true, 'past reminder preference should load on another device');
    await request('/users', {
      method: 'POST',
      headers,
      body: JSON.stringify({ username: 'sync-collab', displayName: 'Sync Collaborator', password: 'test-password-456' })
    });
    const collabLogin = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'sync-collab', password: 'test-password-456' })
    });
    const collabToken = collabLogin.token;
    const collabHeaders = authHeaders(collabToken);
    const now = Date.now();
    const collabExistingNote = await request('/notes', {
      method: 'POST',
      headers: collabHeaders,
      body: JSON.stringify({
        syncId: 'collab-existing-note',
        noteTitle: 'Collaborator existing note',
        noteBody: '',
        pinned: false,
        bgColor: '',
        bgImage: '',
        checkBoxes: [],
        images: [],
        isCbox: false,
        labels: [],
        archived: false,
        trashed: false
      })
    });

    const noteAndReminder = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [
          {
            type: 'reminder.upsert',
            syncId: 'reminder-smoke',
            payload: {
              syncId: 'reminder-smoke',
              noteId: -now,
              noteSyncId: 'note-smoke',
              locationName: 'Home',
              latitude: 43.2,
              longitude: -79.8,
              radiusMeters: 100,
              locationTrigger: 'arrive',
              timezone: 'America/Toronto',
              status: 'pending'
            },
            lww: { physicalMs: now, logical: 1, deviceId: 'smoke-device', operationId: 'reminder-op' }
          },
          {
            type: 'note.upsert',
            syncId: 'note-smoke',
            payload: {
              syncId: 'note-smoke',
              id: -now,
              noteTitle: 'Offline note',
              noteBody: 'Created offline',
              pinned: false,
              bgColor: '',
              bgImage: '',
              checkBoxes: [],
              images: [],
              isCbox: false,
              labels: [],
              archived: false,
              trashed: false
            },
            lww: { physicalMs: now, logical: 0, deviceId: 'smoke-device', operationId: 'note-op' }
          }
        ]
      })
    });
    assert(noteAndReminder.results.every(result => result.ok), JSON.stringify(noteAndReminder.results));
    const note = noteAndReminder.snapshot.notes.find(item => item.syncId === 'note-smoke');
    const reminder = noteAndReminder.snapshot.reminders.find(item => item.syncId === 'reminder-smoke');
    assert(note?.id > 0, 'offline note should receive a server id');
    assert.strictEqual(reminder?.noteId, note.id, 'reminder should resolve noteSyncId to server note id');
    assert.strictEqual(reminder?.locationTrigger, 'arrive');

    await request(`/notes/${note.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ noteBody: 'Updated by another client after the local note was read.' })
    });
    const patchMutation = {
      type: 'note.patch',
      syncId: note.syncId,
      operationId: 'note-patch-smoke-operation',
      payload: { id: note.id, patch: { bgColor: '#abc123' } }
    };
    const patchReply = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ includeSnapshot: false, mutations: [patchMutation] })
    });
    assert.strictEqual(patchReply.results[0].ok, true, 'a patch mutation should be accepted');
    const patchedNote = await request(`/notes/${note.id}`, { headers });
    assert.strictEqual(patchedNote.bgColor, '#abc123');
    assert.strictEqual(patchedNote.noteBody, 'Updated by another client after the local note was read.',
      'a field patch must retain unrelated content changed by another client');
    const patchedRevision = patchedNote.revision;
    assert.strictEqual(patchReply.results[0].revision, patchedRevision,
      'a patch acknowledgement carries the revision a chained guarded save must be based on');
    const replayReply = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ includeSnapshot: false, mutations: [patchMutation] })
    });
    assert.strictEqual(replayReply.results[0].ok, true, 'a lost-response retry should replay its accepted receipt');
    assert.strictEqual(replayReply.results[0].revision, patchedRevision, 'a replayed patch acknowledges the original revision');
    assert.strictEqual((await request(`/notes/${note.id}`, { headers })).revision, patchedRevision,
      'replaying a patch operation must not apply it twice');
    const invalidPatch = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({ includeSnapshot: false, mutations: [{
        type: 'note.patch', syncId: note.syncId, operationId: 'note-patch-invalid-field',
        payload: { id: note.id, patch: { revision: 999 } }
      }] })
    });
    assert.strictEqual(invalidPatch.results[0].ok, false, 'server-managed fields must not be patchable');
    assert.strictEqual(invalidPatch.results[0].status, 400);

    const remindersBeforeNoteEdit = await request('/reminders', { headers });
    const linkedReminderBeforeEdit = remindersBeforeNoteEdit.find(item => item.id === reminder.id);
    assert.strictEqual(linkedReminderBeforeEdit?.title, 'Offline note', 'linked reminder title should come from its current note');
    assert.strictEqual(linkedReminderBeforeEdit?.body, 'Updated by another client after the local note was read.', 'linked reminder body should come from its current note');

    await request(`/notes/${note.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ noteTitle: 'Updated reminder note', noteBody: 'Updated reminder body' })
    });
    const remindersAfterNoteEdit = await request('/reminders', { headers });
    const linkedReminderAfterEdit = remindersAfterNoteEdit.find(item => item.id === reminder.id);
    assert.strictEqual(linkedReminderAfterEdit?.title, 'Updated reminder note', 'linked reminder title should reflect later note edits');
    assert.strictEqual(linkedReminderAfterEdit?.body, 'Updated reminder body', 'linked reminder body should reflect later note edits');

    await request(`/notes/${note.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ trashed: true })
    });
    const remindersAfterTrash = await request('/reminders', { headers });
    assert(!remindersAfterTrash.some(item => item.id === reminder.id), 'trashed notes should not retain active reminders');
    await request(`/notes/${note.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ trashed: false })
    });

    const secondNoteResult = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.upsert',
          syncId: 'note-second',
          payload: {
            syncId: 'note-second',
            noteTitle: 'Second note',
            noteBody: '',
            pinned: false,
            bgColor: '',
            bgImage: '',
            checkBoxes: [],
            images: [],
            isCbox: false,
            labels: [],
            archived: false,
            trashed: false
          },
          lww: { physicalMs: now + 2, logical: 0, deviceId: 'smoke-device', operationId: 'note-second-op' }
        }]
      })
    });
    assert(secondNoteResult.results[0].ok);
    const cursorBeforeReorder = secondNoteResult.snapshot.cursor;
    const reordered = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.reorder',
          syncId: 'order-smoke',
          payload: { syncIds: ['note-smoke', 'note-second'] },
          lww: { physicalMs: now + 3, logical: 0, deviceId: 'smoke-device', operationId: 'order-op' }
        }]
      })
    });
    assert(reordered.results[0].ok, JSON.stringify(reordered.results[0]));
    assert.deepStrictEqual(
      reordered.snapshot.notes.filter(item => ['note-smoke', 'note-second'].includes(item.syncId)).map(item => item.syncId),
      ['note-smoke', 'note-second'],
      'offline reorder should persist through the per-user position table'
    );
    const reorderChanges = await request(`/sync/changes?cursor=${cursorBeforeReorder}`, { headers });
    const reorderedPayloads = reorderChanges.changes
      .filter(change => change.operation === 'upsert' && ['note-smoke', 'note-second'].includes(change.resourceSyncId))
      .map(change => change.payload);
    const firstPayload = reorderedPayloads.find(item => item.syncId === 'note-smoke');
    const secondPayload = reorderedPayloads.find(item => item.syncId === 'note-second');
    assert(
      firstPayload.sortOrder > secondPayload.sortOrder,
      'incremental sync payloads should retain the user-specific reordered positions'
    );

    const cursorBeforePatch = (await request('/sync/changes?cursor=0', { headers })).cursor ?? reorderChanges.cursor;
    const idsBySync = new Map(reordered.snapshot.notes.map(item => [item.syncId, item.id]));
    await request('/notes/reorder', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ ids: [idsBySync.get('note-second'), idsBySync.get('note-smoke')] })
    });
    const patchChanges = await request(`/sync/changes?cursor=${cursorBeforePatch}`, { headers });
    const patchPayloads = patchChanges.changes.filter(c => c.operation === 'upsert').map(c => c.payload);
    const pFirst = patchPayloads.find(i => i.syncId === 'note-second');
    const pSecond = patchPayloads.find(i => i.syncId === 'note-smoke');
    assert(pFirst && pSecond && pFirst.sortOrder > pSecond.sortOrder, 'PATCH /notes/reorder should appear in sync changes');

    const newer = now + 5000;
    const older = now + 1000;
    await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.upsert',
          syncId: 'lww-note',
          payload: {
            syncId: 'lww-note',
            noteTitle: 'newer',
            noteBody: 'winner',
            pinned: false,
            bgColor: '',
            bgImage: '',
            checkBoxes: [],
            images: [],
            isCbox: false,
            labels: [],
            archived: false,
            trashed: false
          },
          lww: { physicalMs: newer, logical: 0, deviceId: 'b', operationId: 'newer' }
        }]
      })
    });
    const olderResult = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.upsert',
          syncId: 'lww-note',
          payload: {
            syncId: 'lww-note',
            noteTitle: 'older',
            noteBody: 'loser',
            pinned: false,
            bgColor: '',
            bgImage: '',
            checkBoxes: [],
            images: [],
            isCbox: false,
            labels: [],
            archived: false,
            trashed: false
          },
          lww: { physicalMs: older, logical: 0, deviceId: 'a', operationId: 'older' }
        }]
      })
    });
    assert.strictEqual(olderResult.results[0].skipped, true, 'older LWW write should be skipped');
    assert.strictEqual(olderResult.snapshot.notes.find(item => item.syncId === 'lww-note').noteTitle, 'newer');

    const sharedNote = await request('/notes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        syncId: 'shared-pin-note',
        noteTitle: 'Shared pin note',
        noteBody: '',
        pinned: true,
        bgColor: '',
        bgImage: '',
        checkBoxes: [],
        images: [],
        isCbox: false,
        labels: [],
        archived: false,
        trashed: false
      })
    });
    await request(`/notes/${sharedNote.id}/collaborators`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ userIds: [collabLogin.user.id] })
    });
    const collabNotesAfterShare = await request('/notes?view=card&limit=5', { headers: collabHeaders });
    const sharedIndex = collabNotesAfterShare.notes.findIndex(note => note.id === sharedNote.id);
    const existingIndex = collabNotesAfterShare.notes.findIndex(note => note.id === collabExistingNote.id);
    assert(sharedIndex > -1 && existingIndex > -1 && sharedIndex < existingIndex, 'newly shared note should appear above existing notes for the recipient');
    await request(`/notes/${sharedNote.id}`, {
      method: 'PATCH',
      headers: collabHeaders,
      body: JSON.stringify({ pinned: true })
    });
    await request(`/notes/${sharedNote.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ pinned: false })
    });
    const collaboratorView = await request(`/notes/${sharedNote.id}`, { headers: collabHeaders });
    const ownerView = await request(`/notes/${sharedNote.id}`, { headers });
    assert.strictEqual(ownerView.pinned, false, 'owner unpin should update only the owner pin state');
    assert.strictEqual(collaboratorView.pinned, true, 'collaborator pin should survive owner unpin');

    const collaboratorPatch = await request('/sync/mutations', {
      method: 'POST',
      headers: collabHeaders,
      body: JSON.stringify({ includeSnapshot: false, mutations: [{
        type: 'note.patch',
        syncId: 'shared-pin-note',
        operationId: 'shared-note-partial-patch',
        payload: { id: sharedNote.id, patch: { noteTitle: 'Shared note patched', binder: 'owner-only change', pinned: false } }
      }] })
    });
    assert.strictEqual(collaboratorPatch.results[0].ok, true, 'collaborators can apply a field-only shared-note patch');
    const ownerAfterPatch = await request(`/notes/${sharedNote.id}`, { headers });
    const collaboratorAfterPatch = await request(`/notes/${sharedNote.id}`, { headers: collabHeaders });
    assert.strictEqual(ownerAfterPatch.noteTitle, 'Shared note patched');
    assert.strictEqual(ownerAfterPatch.binder, '', 'a collaborator patch must not change owner-only organization fields');
    assert.strictEqual(collaboratorAfterPatch.pinned, false, 'a collaborator field patch may update only their personal pin');

    await request(`/notes/${sharedNote.id}`, {
      method: 'PUT',
      headers: collabHeaders,
      body: JSON.stringify({
        ...collaboratorView,
        noteTitle: 'Shared note edited by collaborator',
        noteBody: '<div>Collaborator edit persisted</div>',
        isCbox: true,
        checkBoxes: [{ id: 1, data: 'Collaborator checklist edit', done: false, indent: 0 }]
      })
    });
    const ownerAfterCollaboratorEdit = await request(`/notes/${sharedNote.id}`, { headers });
    assert.strictEqual(ownerAfterCollaboratorEdit.noteTitle, 'Shared note edited by collaborator', 'collaborator should be able to edit shared note title');
    assert.strictEqual(ownerAfterCollaboratorEdit.noteBody, '<div>Collaborator edit persisted</div>', 'collaborator should be able to edit shared note body');
    assert.strictEqual(ownerAfterCollaboratorEdit.checkBoxes[0].data, 'Collaborator checklist edit', 'collaborator should be able to edit shared note checklist items');
    assert.strictEqual(ownerAfterCollaboratorEdit.isCbox, true, 'collaborator should be able to show checkboxes on a shared note');

    const collaboratorSyncBeforeLeave = await request('/sync/changes?cursor=0&limit=500', { headers: collabHeaders });
    await request(`/notes/${sharedNote.id}`, {
      method: 'DELETE',
      headers: collabHeaders
    });
    const collaboratorSyncAfterLeave = await request(`/sync/changes?cursor=${collaboratorSyncBeforeLeave.serverCursor}&limit=500`, { headers: collabHeaders });
    assert(
      collaboratorSyncAfterLeave.changes.some(change =>
        change.resourceType === 'note' &&
        change.resourceSyncId === 'shared-pin-note' &&
        change.operation === 'delete'
      ),
      'collaborator self-unshare should emit a note delete sync change for that collaborator'
    );
    await assert.rejects(
      () => request(`/notes/${sharedNote.id}`, { headers: collabHeaders }),
      /404/,
      'collaborator should lose access after self-unsharing'
    );

    const ownerUnpinnedSharedNote = await request('/notes', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        syncId: 'shared-pin-note-owner-unpinned',
        noteTitle: 'Owner unpinned shared pin note',
        noteBody: '',
        pinned: false,
        bgColor: '',
        bgImage: '',
        checkBoxes: [],
        images: [],
        isCbox: false,
        labels: [],
        archived: false,
        trashed: false
      })
    });
    await request(`/notes/${ownerUnpinnedSharedNote.id}/collaborators`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ userIds: [collabLogin.user.id] })
    });
    await request(`/notes/${ownerUnpinnedSharedNote.id}`, {
      method: 'PATCH',
      headers: collabHeaders,
      body: JSON.stringify({ pinned: true })
    });
    const collaboratorPinnedView = await request(`/notes/${ownerUnpinnedSharedNote.id}`, { headers: collabHeaders });
    const ownerUnpinnedView = await request(`/notes/${ownerUnpinnedSharedNote.id}`, { headers });
    assert.strictEqual(ownerUnpinnedView.pinned, false, 'collaborator pin should not pin the note for the owner');
    assert.strictEqual(collaboratorPinnedView.pinned, true, 'collaborator should be able to pin an owner-unpinned shared note');

    const mergeSourceA = await request('/notes', {
      method: 'POST', headers,
      body: JSON.stringify({ syncId: 'receipt-merge-source-a', noteTitle: 'Merge A', noteBody: '<p>Body A</p>', futureA: 'keep-a' })
    });
    const mergeSourceB = await request('/notes', {
      method: 'POST', headers,
      body: JSON.stringify({ syncId: 'receipt-merge-source-b', noteTitle: 'Merge B', noteBody: '<p>Body B</p>', futureB: 'keep-b' })
    });
    const attachmentForm = new FormData();
    attachmentForm.append('file', new Blob(['merge attachment'], { type: 'text/plain' }), 'merge.txt');
    attachmentForm.append('syncId', 'receipt-merge-attachment');
    const attachmentResponse = await fetch(`${base}/notes/${mergeSourceA.id}/attachments`, {
      method: 'POST', headers: authHeaders(token), body: attachmentForm
    });
    assert.strictEqual(attachmentResponse.status, 201, `merge source attachment failed: ${await attachmentResponse.text()}`);
    const dueSoon = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const dueLater = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const firstMergeReminder = await request('/reminders', {
      method: 'POST', headers, body: JSON.stringify({ noteId: mergeSourceA.id, dueAtUtc: dueSoon, timezone: 'UTC', title: 'Keep reminder' })
    });
    const droppedMergeReminder = await request('/reminders', {
      method: 'POST', headers, body: JSON.stringify({ noteId: mergeSourceB.id, dueAtUtc: dueLater, timezone: 'UTC', title: 'Drop reminder' })
    });
    const mergeCursorBefore = (await request('/sync/changes?cursor=0&limit=500', { headers })).serverCursor;
    const mergeMutation = {
      type: 'note.merge',
      syncId: 'receipt-merge-result',
      operationId: 'receipt-merge-operation',
      payload: { mergeSyncId: 'receipt-merge-result', orderedSourceSyncIds: [mergeSourceA.syncId, mergeSourceB.syncId] }
    };
    const queuedReminderSyncId = 'receipt-merge-earliest-reminder';
    const queuedReminderMutation = {
      type: 'reminder.upsert',
      syncId: queuedReminderSyncId,
      operationId: 'receipt-merge-earliest-reminder-operation',
      payload: {
        syncId: queuedReminderSyncId,
        noteId: -101,
        noteSyncId: mergeSourceB.syncId,
        userId: login.user.id,
        dueAtUtc: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        timezone: 'UTC',
        repeatRule: null,
        status: 'pending',
        title: 'Earlier queued reminder'
      },
      lww: { physicalMs: Date.now(), logical: 0, deviceId: 'merge-test', operationId: 'receipt-merge-earliest-reminder-operation' }
    };
    const mergeReply = await request('/sync/mutations', {
      method: 'POST', headers,
      body: JSON.stringify({ includeSnapshot: false, mutations: [mergeMutation, queuedReminderMutation] })
    });
    assert.strictEqual(mergeReply.results[0].ok, true, 'a merge command should be accepted');
    assert.strictEqual(mergeReply.results[1].ok, true, 'a queued reminder should be applied before the merge transaction');
    const mergedByReceipt = await request(`/notes/${mergeReply.results[0].id}`, { headers });
    assert.strictEqual(mergedByReceipt.syncId, 'receipt-merge-result');
    assert.strictEqual(mergedByReceipt.noteBody, '<p>Body A</p><br><br><p>Body B</p>');
    assert.strictEqual(mergedByReceipt.futureA, 'keep-a');
    assert.strictEqual(mergedByReceipt.futureB, 'keep-b');
    assert.strictEqual(mergedByReceipt.attachments.length, 1, 'source attachments should be re-parented to the merged note');
    assert.strictEqual(mergedByReceipt.attachments[0].originalName, 'merge.txt');
    const mergedReminders = (await request('/reminders', { headers })).filter(reminder => reminder.noteId === mergedByReceipt.id);
    assert.deepStrictEqual(mergedReminders.map(reminder => reminder.syncId), [droppedMergeReminder.syncId], 'the earliest queued pending reminder should be re-parented');
    assert.strictEqual((await request(`/notes/${mergeSourceA.id}`, { headers })).trashed, true);
    const sourceUpdatedAt = (await request(`/notes/${mergeSourceA.id}`, { headers })).updatedAt;
    const replayMergeReply = await request('/sync/mutations', {
      method: 'POST', headers,
      body: JSON.stringify({ includeSnapshot: false, mutations: [mergeMutation] })
    });
    assert.strictEqual(replayMergeReply.results[0].id, mergedByReceipt.id, 'a merge retry should replay its original acknowledgement');
    assert.strictEqual((await request(`/notes/${mergeSourceA.id}`, { headers })).updatedAt, sourceUpdatedAt,
      'receipt replay must not reapply source trashing side effects');
    const mergeChanges = await request(`/sync/changes?cursor=${mergeCursorBefore}&limit=500`, { headers });
    assert(mergeChanges.changes.some(change => change.resourceType === 'attachment'
      && change.resourceSyncId === 'receipt-merge-attachment' && change.operation === 'upsert'
      && change.payload.noteId === mergedByReceipt.id), 'the change feed should publish the attachment re-parenting');
    assert(mergeChanges.changes.some(change => change.resourceType === 'reminder'
      && change.resourceSyncId === droppedMergeReminder.syncId && change.operation === 'upsert'
      && change.payload.noteId === mergedByReceipt.id), 'the change feed should publish the kept reminder re-parenting');
    assert(mergeChanges.changes.some(change => change.resourceType === 'reminder'
      && change.operation === 'delete' && change.resourceSyncId === firstMergeReminder.syncId),
    'the change feed should publish removal of an existing dropped reminder');

    const deleted = await request('/sync/mutations', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        mutations: [{
          type: 'note.delete',
          syncId: 'lww-note',
          payload: { syncId: 'lww-note' },
          lww: { physicalMs: newer + 1000, logical: 0, deviceId: 'b', operationId: 'delete' }
        }]
      })
    });
    assert(!deleted.snapshot.notes.some(item => item.syncId === 'lww-note'), 'deleted note should be absent from snapshot');
    const changes = await request(`/sync/changes?cursor=${Math.max(0, deleted.snapshot.cursor - 1)}`, { headers });
    assert(changes.changes.some(change => change.resourceSyncId === 'lww-note' && change.operation === 'delete'), 'change stream should include delete tombstone');

    console.log('Sync smoke tests passed.');
  } finally {
    child.kill('SIGTERM');
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
