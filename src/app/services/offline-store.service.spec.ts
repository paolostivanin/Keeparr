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

  it('revokes cached media object URLs for a purged partition and keeps other partitions', async () => {
    const other = `${partition}-other`;
    await store.putBlob(partition, 'media:/api/a.png', new Blob(['a']));
    await store.putBlob(other, 'media:/api/a.png', new Blob(['b']));
    const revoke = spyOn(URL, 'revokeObjectURL').and.callThrough();

    const mine = await store.offlineMediaUrl(partition, '/api/a.png');
    const theirs = await store.offlineMediaUrl(other, '/api/a.png');
    expect(await store.offlineMediaUrl(partition, '/api/a.png')).toBe(mine);
    expect(store.canonicalMediaUrl(mine)).toBe('/api/a.png');

    await store.purgePartition(partition);

    expect(revoke).toHaveBeenCalledOnceWith(mine);
    expect(store.canonicalMediaUrl(mine)).toBe(mine);
    expect(store.canonicalMediaUrl(theirs)).toBe('/api/a.png');
    store.releaseMediaUrls(other);
    expect(revoke).toHaveBeenCalledWith(theirs);
  });

  it('keeps unknown extension fields through snapshot, edit and queued upsert', async () => {
    const extension = { schema: 7, flags: ['keep-me'] };
    const original = { ...note(1, 'sync-ext', 'Extended'), futureMetadata: extension } as NoteI;
    await store.replaceSnapshot(partition, [original], [], [], 1, Date.now());
    expect((await store.getNote(partition, 1) as any).futureMetadata).toEqual(extension);

    const edited = { ...(await store.getNote(partition, 1))!, noteTitle: 'Edited' };
    await store.putNote(partition, edited);
    await store.enqueue(partition, 'note.upsert', 'sync-ext', edited, store.nextStamp());

    expect(((await store.listNotes(partition))[0] as any).futureMetadata).toEqual(extension);
    expect(((await store.listOutbox(partition))[0].payload as any).futureMetadata).toEqual(extension);
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
    const queuedUpload = (await store.listOutbox(partition)).find(item => item.type === 'attachment.upload');
    expect(queuedUpload?.payload).toEqual(upload.payload);
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

describe('OfflineStoreService editor sessions', () => {
  it('stores, lists, and removes drafts apart from notes and the outbox, and purges them with the partition', async () => {
    const store = new OfflineStoreService();
    const partition = `editor-session-test-${crypto.randomUUID()}`;
    const other = `${partition}-other`;
    const record = (owner: string, sessionKey: string) => ({
      key: `${owner}|${sessionKey}`, partition: owner, sessionKey, base: null, draft: { noteTitle: 'Draft' } as any,
      dirtyFields: ['noteTitle'] as any, generation: 1, savedGeneration: 0, localState: 'dirty' as const,
      remoteState: 'none' as const, updatedAt: 1
    });
    await store.putEditorSession(record(partition, 'a'));
    await store.putEditorSession(record(partition, 'new'));
    await store.putEditorSession(record(other, 'a'));

    expect((await store.getEditorSession(`${partition}|a`))?.draft.noteTitle).toBe('Draft');
    expect((await store.listEditorSessions(partition)).map(item => item.sessionKey).sort()).toEqual(['a', 'new']);
    expect(await store.listOutbox(partition)).toEqual([]);

    await store.deleteEditorSession(`${partition}|a`);
    expect(await store.getEditorSession(`${partition}|a`)).toBeUndefined();

    await store.purgePartition(partition);
    expect(await store.listEditorSessions(partition)).toEqual([]);
    expect((await store.listEditorSessions(other)).length).toBe(1);
    await store.purgePartition(other);
  });
});

describe('OfflineStoreService guarded note saves', () => {
  let store: OfflineStoreService;
  let partition: string;

  beforeEach(() => {
    store = new OfflineStoreService();
    partition = `guard-test-${crypto.randomUUID()}`;
  });

  const server = (id: number, syncId: string, title: string, revision = 3): NoteI => ({ ...note(id, syncId, title), revision });

  it('bases a save of an accepted server note on its cached revision and fields', async () => {
    await store.replaceSnapshot(partition, [server(5, 'n5', 'Server title', 7)], [], [], 1, Date.now());
    const { entry } = await store.persistNoteMutation(partition, { ...server(5, 'n5', 'Edited', 7) }, store.nextStamp());
    expect(entry.guard?.baseRevision).toBe(7);
    expect(entry.guard?.baseFields.noteTitle).toBe('Server title');
    expect(entry.guard?.after).toBeUndefined();
  });

  it('does not guard notes that do not exist on the server yet', async () => {
    const { entry } = await store.persistNoteMutation(partition, note(-4, 'local-only', 'New'), store.nextStamp());
    expect(entry.guard).toBeUndefined();
    const { entry: second } = await store.persistNoteMutation(partition, note(-4, 'local-only', 'New again'), store.nextStamp());
    expect(second.guard).toBeUndefined();
  });

  it('keeps the original accepted base when an unsent save is coalesced', async () => {
    await store.replaceSnapshot(partition, [server(5, 'n5', 'Server title', 7)], [], [], 1, Date.now());
    await store.persistNoteMutation(partition, server(5, 'n5', 'First edit', 7), store.nextStamp());
    const { entry } = await store.persistNoteMutation(partition, server(5, 'n5', 'Second edit', 7), store.nextStamp());

    const queued = await store.listOutbox(partition);
    expect(queued.length).toBe(1);
    expect(queued[0].operationId).toBe(entry.operationId);
    expect(entry.guard?.baseFields.noteTitle).toBe('Server title');
    expect(entry.guard?.baseRevision).toBe(7);
  });

  it('chains a save behind a possibly-sent one without coalescing or overwriting its payload', async () => {
    await store.replaceSnapshot(partition, [server(5, 'n5', 'Server title', 7)], [], [], 1, Date.now());
    const { entry: first } = await store.persistNoteMutation(partition, server(5, 'n5', 'First edit', 7), store.nextStamp());
    await store.claimOutboxForSend([first.key]);
    const { entry: second } = await store.persistNoteMutation(partition, server(5, 'n5', 'Second edit', 7), store.nextStamp());

    const queued = await store.listOutbox(partition);
    expect(queued.map(item => item.operationId)).toEqual([first.operationId, second.operationId]);
    expect((queued[0].payload as NoteI).noteTitle).toBe('First edit');
    expect(queued[0].deliveryState).toBe('sent');
    expect(second.guard?.after).toBe(first.operationId);
    expect(second.guard?.baseRevision).toBeUndefined();
  });

  it('also chains behind legacy entries whose delivery state is unknown', async () => {
    await store.replaceSnapshot(partition, [server(5, 'n5', 'Server title', 7)], [], [], 1, Date.now());
    const legacyStamp = store.nextStamp();
    await store.enqueue(partition, 'note.upsert', 'n5', server(5, 'n5', 'Legacy', 7), legacyStamp);
    const { entry } = await store.persistNoteMutation(partition, server(5, 'n5', 'New edit', 7), store.nextStamp());
    expect(entry.guard?.after).toBe(legacyStamp.operationId);
    expect((await store.listOutbox(partition)).length).toBe(2);
  });

  it('leaves a coalesced legacy unguarded save unguarded so its edits are not hidden from the merge', async () => {
    await store.replaceSnapshot(partition, [server(5, 'n5', 'Server title', 7)], [], [], 1, Date.now());
    await store.persistNoteMutation(partition, server(5, 'n5', 'First', 7), store.nextStamp());
    const [existing] = await store.listOutbox(partition);
    await store.removeOutbox([existing.key]);
    await store.enqueue(partition, 'note.upsert', 'n5', server(5, 'n5', 'Legacy unsent', 7), store.nextStamp());
    const [legacy] = await store.listOutbox(partition);
    // Mark as known-unsent without a guard to model an entry written before guards existed.
    await store.removeOutbox([legacy.key]);
    const db = await (store as any).open();
    await new Promise<void>(resolve => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').put({ ...legacy, deliveryState: 'unsent' });
      tx.oncomplete = () => resolve();
    });
    const { entry } = await store.persistNoteMutation(partition, server(5, 'n5', 'Newer', 7), store.nextStamp());
    expect(entry.guard).toBeUndefined();
  });

  it('keeps same-millisecond outbox entries in creation order', async () => {
    const first = store.nextStamp();
    const second = store.nextStamp();
    await store.enqueue(partition, 'note.upsert', 'n1', note(1, 'n1', 'a'), first);
    await store.enqueue(partition, 'note.upsert', 'n1', note(1, 'n1', 'b'), second);
    const db = await (store as any).open();
    // Force identical creation times, which made the order depend on random operation IDs.
    const entries = await store.listOutbox(partition);
    await new Promise<void>(resolve => {
      const tx = db.transaction('outbox', 'readwrite');
      entries.forEach(entry => tx.objectStore('outbox').put({ ...entry, createdAt: 1 }));
      tx.oncomplete = () => resolve();
    });
    expect((await store.listOutbox(partition)).map(entry => entry.operationId)).toEqual([first.operationId, second.operationId]);
  });

  it('replaces a rejected save atomically and re-chains operations waiting behind it', async () => {
    await store.replaceSnapshot(partition, [server(5, 'n5', 'Server title', 7)], [], [], 1, Date.now());
    const { entry: rejected } = await store.persistNoteMutation(partition, server(5, 'n5', 'First', 7), store.nextStamp());
    await store.claimOutboxForSend([rejected.key]);
    const { entry: waiting } = await store.persistNoteMutation(partition, server(5, 'n5', 'Second', 7), store.nextStamp());

    const { entry: rebased } = await store.replaceRejectedNoteUpsert(
      partition, rejected.key, server(5, 'n5', 'Merged', 9), { baseRevision: 9, baseFields: {} }, store.nextStamp()
    );

    const queued = await store.listOutbox(partition);
    expect(queued.map(item => item.operationId).sort()).toEqual([waiting.operationId, rebased.operationId].sort());
    expect(queued.find(item => item.operationId === waiting.operationId)?.guard?.after).toBe(rebased.operationId);
    expect(queued.find(item => item.key === rejected.key)).toBeUndefined();
    expect((await store.getNoteBySyncId(partition, 'n5'))?.noteTitle).toBe('Merged');
  });
});

describe('OfflineStoreService reconciliation and upgrades', () => {
  let store: OfflineStoreService;
  let partition: string;

  beforeEach(() => {
    store = new OfflineStoreService();
    partition = `reconcile-test-${crypto.randomUUID()}`;
  });
  afterEach(async () => store.purgePartition(partition));

  const reminderFor = (id: number, syncId: string, noteId: number): ReminderI => ({
    id, syncId, noteId, userId: 1, dueAtUtc: '2030-01-01T00:00:00.000Z', timezone: 'UTC', repeatRule: null, status: 'pending' as any,
    title: null, body: null, imageUrl: null, locationName: null, latitude: null, longitude: null, radiusMeters: null,
    createdAt: '', updatedAt: ''
  });
  const attachmentFor = (syncId: string, noteId: number): NoteAttachmentI => ({
    id: -1, syncId, noteId, originalName: 'a.txt', fileSize: 1, mimeType: 'text/plain', uploadedAt: ''
  });

  it('moves cached reminders and attachments to the server note ID when a local note is acknowledged', async () => {
    const local = note(-22, 'remap-parent', 'Local note');
    await store.persistNoteMutation(partition, local, store.nextStamp());
    await store.putReminder(partition, reminderFor(-7, 'remap-reminder', -22));
    await store.putAttachment(partition, attachmentFor('remap-attachment', -22));
    await store.putReminder(partition, reminderFor(9, 'unrelated-reminder', -99));

    await store.applyChangePage(partition, [
      { resourceType: 'note', resourceSyncId: 'remap-parent', operation: 'upsert', payload: { ...local, id: 73, revision: 1 } }
    ], 5, Date.now());

    expect((await store.getReminder(partition, 'remap-reminder'))?.noteId).toBe(73);
    expect((await store.getAttachment(partition, 'remap-attachment'))?.noteId).toBe(73);
    expect((await store.getNoteBySyncId(partition, 'remap-parent'))?.attachments ?? []).toEqual([]);
    expect((await store.getReminder(partition, 'unrelated-reminder'))?.noteId).toBe(-99);
  });

  it('applies the same remap when a snapshot replaces the cache', async () => {
    const local = note(-22, 'snap-parent', 'Local note');
    await store.persistNoteMutation(partition, local, store.nextStamp());
    const reminder = reminderFor(-7, 'snap-reminder', -22);
    await store.putReminder(partition, reminder);
    await store.enqueue(partition, 'reminder.upsert', 'snap-reminder', reminder, store.nextStamp());
    const attachment = attachmentFor('snap-attachment', -22);
    await store.persistAttachmentUpload(partition, 'blob-1', new Blob(['x']), attachment, local,
      { noteSyncId: 'snap-parent', filename: 'a.txt', syncId: 'snap-attachment' }, store.nextStamp());

    await store.replaceSnapshot(partition, [{ ...local, id: 73, revision: 1 }], [], [], 5, Date.now());

    expect((await store.getReminder(partition, 'snap-reminder'))?.noteId).toBe(73);
    expect((await store.getAttachment(partition, 'snap-attachment'))?.noteId).toBe(73);
  });
});

describe('OfflineStoreService interrupted transactions and upgrades', () => {
  let partition: string;

  beforeEach(() => { partition = `interrupt-test-${crypto.randomUUID()}`; });

  it('leaves neither a note nor an outbox entry when the commit is interrupted', async () => {
    const store = new OfflineStoreService();
    const poisoned = { ...note(-8, 'poisoned', 'Cannot be cloned'), checkBoxes: (() => 1) as unknown as any };

    await expectAsync(store.persistNoteMutation(partition, poisoned, store.nextStamp())).toBeRejected();

    expect(await store.getNoteBySyncId(partition, 'poisoned')).toBeUndefined();
    expect(await store.listOutbox(partition)).toEqual([]);
  });

  it('leaves no blob, projection or upload intent when a pending attachment commit is interrupted', async () => {
    const store = new OfflineStoreService();
    const parent = note(-8, 'parent', 'Parent');
    const attachment = { id: -1, syncId: 'att', noteId: -8, originalName: 'a', fileSize: 1, mimeType: 'text/plain', uploadedAt: '', poison: () => 1 } as unknown as NoteAttachmentI;

    await expectAsync(store.persistAttachmentUpload(partition, 'blob-x', new Blob(['x']), attachment, parent,
      { noteSyncId: 'parent', filename: 'a', syncId: 'att' }, store.nextStamp())).toBeRejected();

    expect(await store.getBlob(partition, 'blob-x')).toBeUndefined();
    expect(await store.getAttachment(partition, 'att')).toBeUndefined();
    expect(await store.listOutbox(partition)).toEqual([]);
  });

  it('opens a database from the first schema generation without losing queued work or drafts', async () => {
    const name = `kept-upgrade-${crypto.randomUUID()}`;
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        for (const store of ['notes', 'reminders', 'attachments', 'outbox']) {
          request.result.createObjectStore(store, { keyPath: 'key' }).createIndex('partition', 'partition', { unique: false });
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction(['notes', 'outbox'], 'readwrite');
        tx.objectStore('notes').put({ key: `${partition}|legacy`, partition, syncId: 'legacy', value: { ...note(12, 'legacy', 'Legacy note'), revision: 3 } });
        // Written before delivery state, guards and chains existed.
        tx.objectStore('outbox').put({
          key: `${partition}|legacy-op`, partition, operationId: 'legacy-op', type: 'note.upsert', syncId: 'legacy',
          payload: note(12, 'legacy', 'Legacy unsent edit'), lww: { physicalMs: 1, logical: 0, deviceId: 'd', operationId: 'legacy-op' },
          createdAt: 1, attempts: 2
        });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });

    const store = new OfflineStoreService();
    (store as any).databaseName = name;

    expect((await store.getNote(partition, 12))?.noteTitle).toBe('Legacy note');
    const [legacy] = await store.listOutbox(partition);
    expect(legacy.operationId).toBe('legacy-op');
    expect(legacy.deliveryState).toBeUndefined();
    expect(legacy.attempts).toBe(2);
    expect(await store.hasUnsyncedWork(partition)).toBeTrue();
    // Newer code treats it as possibly sent and queues behind it rather than rewriting it.
    const { entry } = await store.persistNoteMutation(partition, note(12, 'legacy', 'New edit'), store.nextStamp());
    const queued = await store.listOutbox(partition);
    expect(queued.map(item => item.operationId)).toEqual(['legacy-op', entry.operationId]);
    expect((queued[0].payload as NoteI).noteTitle).toBe('Legacy unsent edit');
    expect(entry.guard?.after).toBe('legacy-op');
    expect((await store.getSyncState(partition)).cursor).toBe(0);
    await store.purgePartition(partition);
  });

  it('writes outbox records that an older build can still read', async () => {
    const store = new OfflineStoreService();
    await store.replaceSnapshot(partition, [note(5, 'n5', 'Server')], [], [], 1, Date.now());
    const { entry } = await store.persistNoteMutation(partition, note(5, 'n5', 'Edit'), store.nextStamp());
    const raw = await (async () => {
      const db: IDBDatabase = await (store as any).open();
      return new Promise<any>(resolve => {
        const request = db.transaction('outbox').objectStore('outbox').get(entry.key);
        request.onsuccess = () => resolve(request.result);
      });
    })();
    for (const field of ['key', 'partition', 'operationId', 'type', 'syncId', 'payload', 'lww', 'createdAt', 'attempts']) {
      expect(raw[field]).withContext(field).toBeDefined();
    }
    expect(raw.type).toBe('note.upsert');
    expect(raw.payload.noteTitle).toBe('Edit');
    await store.purgePartition(partition);
  });
});

describe('OfflineStoreService display window', () => {
  it('returns the remembered top of the list in order by point reads, skips vanished notes, and is purged with the partition', async () => {
    const store = new OfflineStoreService();
    const partition = `window-test-${crypto.randomUUID()}`;
    await store.replaceSnapshot(partition, [note(1, 'a', 'A'), note(2, 'b', 'B'), note(3, 'c', 'C')], [], [], 1, Date.now());
    expect(await store.getDisplayWindow(partition)).toEqual([]);

    await store.setDisplayWindow(partition, ['c', 'gone', 'a']);

    expect(await store.getDisplayWindow(partition)).toEqual(['c', 'gone', 'a']);
    expect((await store.getNotesBySyncIds(partition, ['c', 'gone', 'a'])).map(item => item.syncId)).toEqual(['c', 'a']);
    expect(await store.getNotesBySyncIds(partition, [])).toEqual([]);
    // It never collides with the partition's sync cursor.
    expect((await store.getSyncState(partition)).cursor).toBe(1);

    await store.purgePartition(partition);
    expect(await store.getDisplayWindow(partition)).toEqual([]);
  });
});
