import { NoteI } from '../interfaces/notes';
import { NotesStoreService } from './notes-store.service';

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

describe('NotesStoreService', () => {
  let store: NotesStoreService;

  beforeEach(() => store = new NotesStoreService());

  it('publishes one ordered collection and rebuilds identity indexes', () => {
    const first = note(1, 'note-a', 'First');
    const second = note(2, 'note-b', 'Second');
    store.publish([first, second]);

    expect(store.value).toEqual([first, second]);
    expect(store.getByServerId(2)).toBe(second);
    expect(store.getBySyncId('note-a')).toBe(first);
    expect(store.indexOfServerId(2)).toBe(1);
  });

  it('exposes memoized signal selectors for the canonical note sections', () => {
    const pinned = { ...note(1, 'pinned', 'Pinned'), pinned: true };
    const unpinned = note(2, 'unpinned', 'Other');
    store.publish([pinned, unpinned]);

    expect(store.allNotes()).toEqual([pinned, unpinned]);
    expect(store.pinnedNotes()).toEqual([pinned]);
    expect(store.unpinnedNotes()).toEqual([unpinned]);
    expect(store.allNotes()).toBe(store.allNotes());

    store.upsert({ ...pinned, pinned: false });
    expect(store.pinnedNotes()).toEqual([]);
    expect(store.unpinnedNotes().map(item => item.syncId)).toEqual(['pinned', 'unpinned']);
  });

  it('upserts one note immutably and preserves other note identities', () => {
    const first = note(1, 'note-a', 'First');
    const second = note(2, 'note-b', 'Second');
    store.publish([first, second]);
    const updated = { ...second, noteTitle: 'Changed' };

    store.upsert(updated);

    expect(store.value).not.toBeNull();
    expect(store.value?.[0]).toBe(first);
    expect(store.value?.[1]).toBe(updated);
    expect(store.getByServerId(2)).toBe(updated);
  });

  it('removes an identity from indexes and clears the active account state', () => {
    store.publish([note(1, 'note-a', 'First'), note(2, 'note-b', 'Second')]);
    expect(store.removeByServerId(1)).toBeTrue();
    expect(store.getByServerId(1)).toBeUndefined();
    expect(store.indexOfServerId(2)).toBe(0);
    store.clear();
    expect(store.value).toBeNull();
    expect(store.getBySyncId('note-b')).toBeUndefined();
  });

  it('remaps a local numeric ID without duplicating its sync identity', () => {
    const local = { ...note(-7, 'stable-sync-id', 'Local'), id: -7 };
    store.publish([local]);

    store.upsert({ ...local, id: 42, noteTitle: 'Accepted by server' });

    expect(store.value?.length).toBe(1);
    expect(store.getByServerId(-7)).toBeUndefined();
    expect(store.getByServerId(42)?.noteTitle).toBe('Accepted by server');
    expect(store.getBySyncId('stable-sync-id')?.id).toBe(42);
  });
});
