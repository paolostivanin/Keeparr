import { OfflineStoreService } from './offline-store.service';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';

function note(id: number, syncId: string, title: string): NoteI {
  return {
    id,
    syncId,
    noteTitle: title,
    noteBody: '',
    pinned: false,
    bgColor: '',
    bgImage: '',
    isCbox: false,
    labels: [],
    archived: false,
    trashed: false
  };
}

describe('OfflineStoreService indexed note access', () => {
  let store: OfflineStoreService;
  let partition: string;

  beforeEach(() => {
    store = new OfflineStoreService();
    partition = `offline-store-test-${crypto.randomUUID()}`;
  });

  it('resolves a note by partition and numeric ID and updates it without listing the partition', async () => {
    await store.replaceSnapshot(partition, [note(1, 'sync-1', 'One'), note(2, 'sync-2', 'Two')], [], [], 1, Date.now());

    expect((await store.getNote(partition, 2))?.noteTitle).toBe('Two');
    await store.putNote(partition, { ...note(2, 'sync-2', 'Updated two'), noteBody: 'Saved' });

    expect((await store.getNote(partition, 2))?.noteTitle).toBe('Updated two');
    expect((await store.listNotes(partition)).map(item => item.id)).toEqual([1, 2]);
  });

  it('replaces partition records and advances its cursor atomically', async () => {
    await store.replaceSnapshot(partition, [note(1, 'sync-1', 'Old one'), note(2, 'sync-2', 'Old two')], [], [], 10, Date.now());

    await store.replaceSnapshot(partition, [note(3, 'sync-3', 'New snapshot')], [], [], 11, Date.now());

    expect((await store.listNotes(partition)).map(item => item.syncId)).toEqual(['sync-3']);
    expect(await store.getNote(partition, 1)).toBeUndefined();
    expect((await store.getSyncState(partition)).cursor).toBe(11);
  });

  it('preserves latest queued note/reminder edits and does not resurrect queued deletions', async () => {
    const locallyEdited = note(3, 'pending-edit', 'Local edit');
    const older = store.nextStamp();
    const earlierEdit = { ...locallyEdited, noteTitle: 'Earlier queued edit' };
    await store.putNote(partition, earlierEdit);
    await store.enqueue(partition, 'note.upsert', earlierEdit.syncId!, earlierEdit, older);
    const latest = store.nextStamp();
    await store.putNote(partition, locallyEdited);
    await store.enqueue(partition, 'note.upsert', locallyEdited.syncId!, locallyEdited, latest);
    const deleted = note(4, 'pending-delete', 'Deleted locally');
    await store.enqueue(partition, 'note.delete', deleted.syncId!, deleted, store.nextStamp());
    const localReminder: ReminderI = {
      id: 6,
      syncId: 'pending-reminder',
      noteId: -30,
      userId: 1,
      dueAtUtc: '2026-10-07T09:00:00.000Z',
      timezone: 'UTC',
      repeatRule: null,
      status: 'pending',
      title: 'Local reminder title',
      body: 'Local reminder body',
      imageUrl: null,
      locationName: null,
      latitude: null,
      longitude: null,
      radiusMeters: null,
      createdAt: '2026-10-06T12:00:00.000Z',
      updatedAt: '2026-10-06T12:01:00.000Z'
    };
    await store.putReminder(partition, localReminder);
    await store.enqueue(partition, 'reminder.upsert', localReminder.syncId!, localReminder, store.nextStamp());
    const staleReminder = { ...localReminder, id: 60, noteId: 300, title: 'Stale server reminder title' };

    await store.replaceSnapshot(partition, [
      note(30, 'pending-edit', 'Stale server copy'),
      note(40, 'pending-delete', 'Server still has deleted note'),
      note(50, 'unrelated', 'Snapshot note')
    ], [staleReminder], [], 12, Date.now());

    expect((await store.getNoteBySyncId(partition, 'pending-edit'))).toEqual({
      ...locallyEdited,
      id: 30,
      revision: undefined
    });
    expect(await store.getNoteBySyncId(partition, 'pending-delete')).toBeUndefined();
    expect((await store.getNoteBySyncId(partition, 'unrelated'))?.noteTitle).toBe('Snapshot note');
    expect(await store.getReminder(partition, 'pending-reminder')).toEqual({
      ...localReminder,
      id: 60,
      noteId: 300
    });
    expect((await store.getSyncState(partition)).cursor).toBe(12);
  });

  it('applies an incremental change page and its cursor atomically without replacing a newer queued edit', async () => {
    const base = { ...note(9, 'incremental-pending', 'Base'), revision: 3 };
    await store.replaceSnapshot(partition, [base], [], [], 10, Date.now());
    const local = { ...base, noteTitle: 'Newer local edit' };
    await store.persistNoteMutation(partition, local, store.nextStamp());

    const summary = await store.applyChangePage(partition, [{
      resourceType: 'note',
      resourceSyncId: 'incremental-pending',
      operation: 'upsert',
      payload: { ...base, id: 90, revision: 4, noteTitle: 'Accepted server version' }
    }], 11, Date.now());

    expect(await store.getNote(partition, 9)).toBeUndefined();
    expect(await store.getNoteBySyncId(partition, 'incremental-pending')).toEqual(jasmine.objectContaining({
      id: 90,
      revision: 4,
      noteTitle: 'Newer local edit'
    }));
    expect((await store.getSyncState(partition)).cursor).toBe(11);
    expect(summary.noteSyncIds).toEqual(['incremental-pending']);
  });

  it('preserves pending attachment uploads, local blobs, and note previews through snapshot replacement', async () => {
    await store.replaceSnapshot(partition, [note(-12, 'attachment-note', 'Local note')], [], [], 1, Date.now());
    const attachment = {
      id: -120,
      syncId: 'pending-attachment',
      noteId: -12,
      originalName: 'receipt.pdf',
      fileSize: 3,
      mimeType: 'application/pdf',
      uploadedAt: '2026-10-07T08:00:00.000Z'
    };
    const blob = new Blob(['pdf']);
    await store.putAttachment(partition, attachment);
    await store.putBlob(partition, 'pending-attachment-blob', blob);
    await store.enqueue(partition, 'attachment.upload', attachment.syncId, {
      noteSyncId: 'attachment-note',
      blobKey: 'pending-attachment-blob',
      filename: attachment.originalName,
      syncId: attachment.syncId
    }, store.nextStamp());

    await store.replaceSnapshot(partition, [note(42, 'attachment-note', 'Server note')], [], [], 2, Date.now());

    expect(await store.getAttachment(partition, attachment.syncId)).toEqual({ ...attachment, noteId: 42 });
    expect((await store.getNoteBySyncId(partition, 'attachment-note'))?.attachments).toEqual([{ ...attachment, noteId: 42 }]);
    expect(await (await store.getBlob(partition, 'pending-attachment-blob'))?.text()).toBe('pdf');
    expect((await store.listOutbox(partition)).map(entry => entry.type)).toEqual(['attachment.upload']);
  });

  it('commits an offline note and its outbox mutation in one transaction', async () => {
    const local = note(-1, 'offline-note-1', 'Saved offline');
    const stamp = store.nextStamp();

    const { note: persisted, entry } = await store.persistNoteMutation(partition, local, stamp);

    expect((await store.getNote(partition, -1))?.noteTitle).toBe('Saved offline');
    expect(persisted.lwwOperationId).toBe(stamp.operationId);
    expect((await store.listOutbox(partition))).toEqual([entry]);
    expect(entry.payload).toEqual(persisted);
  });

  it('commits a partial note patch and its outbox intent atomically', async () => {
    const base = { ...note(12, 'partial-patch', 'Original title'), noteBody: 'Original body', revision: 4 };
    await store.replaceSnapshot(partition, [base], [], [], 1, Date.now());
    const local = { ...base, noteTitle: 'Patched title' };
    const { note: persisted, entry } = await store.persistNotePatchMutation(
      partition,
      local,
      { noteTitle: 'Patched title' },
      store.nextStamp()
    );

    expect(await store.getNoteBySyncId(partition, base.syncId!)).toEqual(persisted);
    expect(entry.type).toBe('note.patch');
    expect(entry.deliveryState).toBe('unsent');
    expect(entry.payload).toEqual({ id: base.id, patch: { noteTitle: 'Patched title' } });
    expect(await store.listOutbox(partition)).toEqual([entry]);
  });

  it('coalesces a partial patch into a known-unsent full note mutation', async () => {
    const base = note(-12, 'patch-unsent-create', 'Created locally');
    await store.persistNoteMutation(partition, base, store.nextStamp());

    const { note: persisted, entry } = await store.persistNotePatchMutation(
      partition,
      { ...base, noteTitle: 'Created and patched' },
      { noteTitle: 'Created and patched' },
      store.nextStamp()
    );

    expect(entry.type).toBe('note.upsert');
    expect(entry.payload).toEqual(jasmine.objectContaining({ noteTitle: 'Created and patched', lwwOperationId: entry.operationId }));
    expect(await store.listOutbox(partition)).toEqual([entry]);
    expect(await store.getNoteBySyncId(partition, base.syncId!)).toEqual(persisted);
  });

  it('keeps a potentially sent patch immutable and queues later fields as a successor', async () => {
    const base = { ...note(14, 'sent-partial-patch', 'Title'), binder: '' };
    const { entry: first } = await store.persistNotePatchMutation(
      partition,
      { ...base, binder: 'First binder' },
      { binder: 'First binder' },
      store.nextStamp()
    );
    const [claimed] = await store.claimOutboxForSend([first.key]);
    const { entry: successor } = await store.persistNotePatchMutation(
      partition,
      { ...base, binder: 'First binder', noteTitle: 'Successor title' },
      { noteTitle: 'Successor title' },
      store.nextStamp()
    );

    const queued = await store.listOutbox(partition);
    expect(claimed.operationId).toBe(first.operationId);
    expect(queued).toHaveSize(2);
    expect(queued[0].operationId).toBe(first.operationId);
    expect(queued[0].payload).toEqual(first.payload);
    expect(queued[1].operationId).toBe(successor.operationId);
    expect(queued[1].payload).toEqual({ id: base.id, patch: { noteTitle: 'Successor title' } });
  });

  it('commits a merge, source trash state, attachment reparenting, reminder selection, and outbox intent together', async () => {
    const sourceA = { ...note(21, 'merge-source-a', 'First source'), pinned: true };
    const sourceB = { ...note(22, 'merge-source-b', 'Second source'), pinned: true };
    const attachmentA: NoteAttachmentI = {
      id: 31, syncId: 'merge-attachment-a', noteId: sourceA.id, originalName: 'a.pdf',
      fileSize: 10, mimeType: 'application/pdf', uploadedAt: '2026-10-07T10:00:00.000Z'
    };
    const attachmentB: NoteAttachmentI = {
      id: 32, syncId: 'merge-attachment-b', noteId: sourceB.id, originalName: 'b.pdf',
      fileSize: 12, mimeType: 'application/pdf', uploadedAt: '2026-10-07T11:00:00.000Z'
    };
    const reminderA: ReminderI = {
      id: 41, syncId: 'merge-reminder-a', noteId: sourceA.id!, userId: 7,
      dueAtUtc: '2026-10-08T09:00:00.000Z', timezone: 'UTC', repeatRule: null, status: 'pending',
      title: 'Keep', body: null, imageUrl: null, locationName: null, latitude: null, longitude: null,
      radiusMeters: null, createdAt: '2026-10-07T09:00:00.000Z', updatedAt: '2026-10-07T09:00:00.000Z'
    };
    const reminderB: ReminderI = { ...reminderA, id: 42, syncId: 'merge-reminder-b', noteId: sourceB.id!, dueAtUtc: '2026-10-08T10:00:00.000Z', title: 'Drop' };
    await store.replaceSnapshot(partition, [sourceA, sourceB], [reminderA, reminderB], [attachmentA, attachmentB], 1, Date.now());
    const merged = { ...note(-21, 'merged-note-sync', 'Merged'), attachments: [] as NoteAttachmentI[] };

    const result = await store.persistNoteMergeMutation(partition, merged, [sourceA, sourceB], store.nextStamp());

    expect(result.entry.type).toBe('note.merge');
    expect((result.entry.payload as any).orderedSourceSyncIds).toEqual([sourceA.syncId, sourceB.syncId]);
    expect((await store.getNoteBySyncId(partition, sourceA.syncId!))?.trashed).toBeTrue();
    expect((await store.getNoteBySyncId(partition, sourceA.syncId!))?.pinned).toBeFalse();
    expect((await store.getNoteBySyncId(partition, merged.syncId!))?.attachments?.map(item => item.syncId)).toEqual([
      attachmentA.syncId, attachmentB.syncId
    ]);
    expect((await store.listAttachments(partition)).every(item => item.noteId === merged.id)).toBeTrue();
    expect(await store.getReminder(partition, reminderA.syncId!)).toEqual(jasmine.objectContaining({ noteId: merged.id }));
    expect(await store.getReminder(partition, reminderB.syncId!)).toBeUndefined();
    expect(result.keptReminder?.syncId).toBe(reminderA.syncId);
    expect(result.removedReminderSyncIds).toEqual([reminderB.syncId!]);
    expect((await store.listOutbox(partition)).map(item => item.type)).toEqual(['note.merge']);
  });

  it('keeps a source attachment upload immutable and queues merge after it', async () => {
    const sourceA = note(23, 'merge-pending-upload-a', 'First source');
    const sourceB = note(24, 'merge-pending-upload-b', 'Second source');
    await store.replaceSnapshot(partition, [sourceA, sourceB], [], [], 1, Date.now());
    const attachment: NoteAttachmentI = {
      id: -230, syncId: 'merge-upload', noteId: sourceA.id, originalName: 'pending.pdf',
      fileSize: 10, mimeType: 'application/pdf', uploadedAt: '2026-10-07T10:00:00.000Z'
    };
    await store.persistAttachmentUpload(
      partition,
      'pending-blob',
      new Blob(['pending file']),
      attachment,
      { ...sourceA, attachments: [attachment] },
      { noteSyncId: sourceA.syncId!, filename: attachment.originalName, syncId: attachment.syncId! },
      store.nextStamp()
    );
    const merged = note(-23, 'merged-pending-upload', 'Merged');

    await store.persistNoteMergeMutation(partition, merged, [sourceA, sourceB], store.nextStamp());

    const queuedUpload = (await store.listOutbox(partition)).find(item => item.type === 'attachment.upload');
    expect((queuedUpload?.payload as any).noteSyncId).toBe(sourceA.syncId);
    expect(queuedUpload?.deliveryState).toBe('unsent');
    expect((await store.getAttachment(partition, attachment.syncId!))?.noteId).toBe(merged.id);
    expect((await store.listOutbox(partition)).map(item => item.type)).toEqual(['attachment.upload', 'note.merge']);
  });

  it('keeps a potentially sent attachment upload immutable while queueing the merge', async () => {
    const sourceA = note(25, 'merge-sent-upload-a', 'First source');
    const sourceB = note(26, 'merge-sent-upload-b', 'Second source');
    await store.replaceSnapshot(partition, [sourceA, sourceB], [], [], 1, Date.now());
    const upload = await store.enqueue(partition, 'attachment.upload', 'merge-sent-upload', {
      noteSyncId: sourceA.syncId, blobKey: 'pending-blob', filename: 'pending.pdf', syncId: 'merge-sent-upload'
    }, store.nextStamp());
    await store.claimOutboxForSend([upload.key]);

    const merged = note(-25, 'blocked-merge', 'Merged');
    await store.persistNoteMergeMutation(
      partition,
      merged,
      [sourceA, sourceB],
      store.nextStamp()
    );

    expect((await store.getNoteBySyncId(partition, sourceA.syncId!))?.trashed).toBeTrue();
    expect((await store.listOutbox(partition))[0].payload).toEqual(upload.payload);
    expect((await store.listOutbox(partition)).some(item => item.type === 'note.merge')).toBeTrue();
  });

  it('preserves a pending merge over a server snapshot with remapped source identities', async () => {
    const sourceA = { ...note(51, 'snapshot-merge-a', 'First'), pinned: true };
    const sourceB = { ...note(52, 'snapshot-merge-b', 'Second'), pinned: true };
    const attachment: NoteAttachmentI = {
      id: 61, syncId: 'snapshot-merge-attachment', noteId: 51, originalName: 'merged.pdf',
      fileSize: 8, mimeType: 'application/pdf', uploadedAt: '2026-10-07T11:00:00.000Z'
    };
    const reminder: ReminderI = {
      id: 71, syncId: 'snapshot-merge-reminder', noteId: 51, userId: 7,
      dueAtUtc: '2026-10-08T09:00:00.000Z', timezone: 'UTC', repeatRule: null, status: 'pending',
      title: 'Keep', body: null, imageUrl: null, locationName: null, latitude: null, longitude: null,
      radiusMeters: null, createdAt: '2026-10-07T09:00:00.000Z', updatedAt: '2026-10-07T09:00:00.000Z'
    };
    await store.replaceSnapshot(partition, [sourceA, sourceB], [reminder], [attachment], 1, Date.now());
    await store.persistNoteMergeMutation(partition, { ...note(-51, 'snapshot-merged-note', 'Merged'), attachments: [attachment] }, [sourceA, sourceB], store.nextStamp());

    await store.replaceSnapshot(partition, [
      { ...sourceA, id: 151, revision: 3, trashed: false },
      { ...sourceB, id: 152, revision: 4, trashed: false }
    ], [{ ...reminder, noteId: 151 }], [{ ...attachment, noteId: 151 }], 2, Date.now());

    expect(await store.getNoteBySyncId(partition, sourceA.syncId!)).toEqual(jasmine.objectContaining({ id: 151, trashed: true, pinned: false }));
    expect(await store.getNoteBySyncId(partition, 'snapshot-merged-note')).toEqual(jasmine.objectContaining({ id: -51 }));
    expect(await store.getAttachment(partition, attachment.syncId!)).toEqual(jasmine.objectContaining({ noteId: -51 }));
    expect(await store.getReminder(partition, reminder.syncId!)).toEqual(jasmine.objectContaining({ noteId: -51 }));
  });

  it('preserves a pending partial patch over a newer server snapshot without reverting unrelated fields', async () => {
    const base = { ...note(12, 'snapshot-partial-patch', 'Original title'), noteBody: 'Original body' };
    await store.replaceSnapshot(partition, [base], [], [], 1, Date.now());
    await store.persistNotePatchMutation(
      partition,
      { ...base, noteTitle: 'Local patched title' },
      { noteTitle: 'Local patched title' },
      store.nextStamp()
    );

    await store.replaceSnapshot(partition, [{ ...base, noteTitle: 'Remote title', noteBody: 'Remote body', revision: 5 }], [], [], 2, Date.now());

    expect(await store.getNoteBySyncId(partition, base.syncId!)).toEqual(jasmine.objectContaining({
      noteTitle: 'Local patched title',
      noteBody: 'Remote body',
      revision: 5
    }));
  });

  it('applies incremental server changes under pending partial fields', async () => {
    const base = { ...note(13, 'incremental-partial-patch', 'Original title'), noteBody: 'Original body', revision: 2 };
    await store.replaceSnapshot(partition, [base], [], [], 1, Date.now());
    await store.persistNotePatchMutation(
      partition,
      { ...base, binder: 'Local binder' },
      { binder: 'Local binder' },
      store.nextStamp()
    );

    await store.applyChangePage(partition, [{
      resourceType: 'note',
      resourceSyncId: base.syncId!,
      operation: 'upsert',
      payload: { ...base, id: 130, noteTitle: 'Remote title', noteBody: 'Remote body', revision: 3 }
    }], 2, Date.now());

    expect(await store.getNoteBySyncId(partition, base.syncId!)).toEqual(jasmine.objectContaining({
      id: 130,
      revision: 3,
      noteTitle: 'Remote title',
      noteBody: 'Remote body',
      binder: 'Local binder'
    }));
  });

  it('coalesces only unsent note edits and keeps a claimed operation immutable', async () => {
    const first = note(4, 'coalesced-note', 'First unsent edit');
    await store.persistNoteMutation(partition, first, store.nextStamp());
    const second = { ...first, noteTitle: 'Latest unsent edit' };
    const { entry: unsent } = await store.persistNoteMutation(partition, second, store.nextStamp());

    expect(await store.listOutbox(partition)).toEqual([unsent]);
    const [claimed] = await store.claimOutboxForSend([unsent.key]);
    const third = { ...second, noteTitle: 'Edit after request may have started' };
    const { entry: successor } = await store.persistNoteMutation(partition, third, store.nextStamp());
    const queued = await store.listOutbox(partition);

    expect(claimed.operationId).toBe(unsent.operationId);
    expect(claimed.sentAt).toEqual(jasmine.any(Number));
    expect(queued).toHaveSize(2);
    expect(queued[0].operationId).toBe(unsent.operationId);
    expect(queued[0].payload).toEqual(unsent.payload);
    expect(queued[1].operationId).toBe(successor.operationId);
  });

  it('preserves legacy outbox entries with unknown send state instead of coalescing them', async () => {
    const legacy = note(5, 'legacy-send-state', 'Possibly sent legacy operation');
    const legacyStamp = store.nextStamp();
    await store.enqueue(partition, 'note.upsert', legacy.syncId!, legacy, legacyStamp);
    const current = { ...legacy, noteTitle: 'New edit' };
    await store.persistNoteMutation(partition, current, store.nextStamp());

    const queued = await store.listOutbox(partition);
    expect(queued).toHaveSize(2);
    expect(queued[0].operationId).toBe(legacyStamp.operationId);
    expect(queued[0].deliveryState).toBeUndefined();
    expect(queued[1].deliveryState).toBe('unsent');
  });

  it('remaps a local note to its acknowledged server ID by sync identity', async () => {
    const local = note(-22, 'stable-remap-id', 'Local draft');
    await store.persistNoteMutation(partition, local, store.nextStamp());

    await store.putNote(partition, { ...local, id: 73, revision: 4, noteTitle: 'Acknowledged draft' });

    expect((await store.listNotes(partition)).filter(item => item.syncId === local.syncId)).toHaveSize(1);
    expect(await store.getNote(partition, -22)).toBeUndefined();
    expect(await store.getNote(partition, 73)).toEqual(jasmine.objectContaining({
      syncId: local.syncId,
      id: 73,
      revision: 4,
      noteTitle: 'Acknowledged draft'
    }));
  });

  it('commits a pending attachment, blob, note projection, and upload intent together', async () => {
    const localNote = note(-4, 'attachment-owner', 'Has a pending file');
    const attachment = {
      id: -8,
      syncId: 'attachment-operation',
      noteId: -4,
      originalName: 'scan.pdf',
      fileSize: 4,
      mimeType: 'application/pdf',
      uploadedAt: '2026-10-07T08:00:00.000Z'
    };
    const blob = new Blob(['scan']);
    const { entry } = await store.persistAttachmentUpload(
      partition,
      'blob-key',
      blob,
      attachment,
      { ...localNote, attachments: [attachment] },
      { noteSyncId: localNote.syncId!, filename: attachment.originalName, syncId: attachment.syncId },
      store.nextStamp()
    );

    expect((await store.getNoteBySyncId(partition, localNote.syncId!))?.attachments).toEqual([attachment]);
    expect(await store.getAttachment(partition, attachment.syncId)).toEqual(attachment);
    expect(await (await store.getBlob(partition, 'blob-key'))?.text()).toBe('scan');
    expect(await store.listOutbox(partition)).toEqual([entry]);
  });

  it('keeps neighboring account partitions isolated during snapshot replacement', async () => {
    const otherPartition = `${partition}-other`;
    await store.replaceSnapshot(partition, [note(1, 'same-id', 'First account')], [], [], 1, Date.now());
    await store.replaceSnapshot(otherPartition, [note(1, 'same-id', 'Other account')], [], [], 1, Date.now());

    await store.replaceSnapshot(partition, [note(2, 'new-id', 'Refreshed account')], [], [], 2, Date.now());

    expect((await store.getNote(otherPartition, 1))?.noteTitle).toBe('Other account');
    expect((await store.getSyncState(otherPartition)).cursor).toBe(1);
  });

  it('repairs duplicate numeric note identities only through the explicit recovery method', async () => {
    await store.replaceSnapshot(partition, [
      note(7, 'duplicate-a', 'Older duplicate'),
      note(7, 'duplicate-b', 'Preferred duplicate')
    ], [], [], 1, Date.now());

    expect((await store.listNotes(partition))).toHaveSize(1);
    expect(await store.getNoteBySyncId(partition, 'duplicate-a')).toBeDefined();
    expect(await store.getNoteBySyncId(partition, 'duplicate-b')).toBeDefined();
    expect(await store.repairDuplicateNoteIdentities(partition)).toBe(1);
    expect(await store.getNoteBySyncId(partition, 'duplicate-a')).toBeUndefined();
    expect((await store.getNoteBySyncId(partition, 'duplicate-b'))?.noteTitle).toBe('Preferred duplicate');
  });
});
