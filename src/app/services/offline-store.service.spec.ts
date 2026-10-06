import { OfflineStoreService } from './offline-store.service';
import { NoteI } from '../interfaces/notes';

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

  it('keeps neighboring account partitions isolated during snapshot replacement', async () => {
    const otherPartition = `${partition}-other`;
    await store.replaceSnapshot(partition, [note(1, 'same-id', 'First account')], [], [], 1, Date.now());
    await store.replaceSnapshot(otherPartition, [note(1, 'same-id', 'Other account')], [], [], 1, Date.now());

    await store.replaceSnapshot(partition, [note(2, 'new-id', 'Refreshed account')], [], [], 2, Date.now());

    expect((await store.getNote(otherPartition, 1))?.noteTitle).toBe('Other account');
    expect((await store.getSyncState(otherPartition)).cursor).toBe(1);
  });
});
