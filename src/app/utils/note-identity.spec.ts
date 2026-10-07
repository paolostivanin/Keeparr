import { NoteI } from '../interfaces/notes';
import { sameDisplayedNote } from './note-identity';

const base = (): NoteI => ({
  id: 1, syncId: 'n1', revision: 3, updatedAt: 't', lwwOperationId: 'op', lwwPhysicalMs: 5, lwwLogical: 0, noteTitle: 'T', noteBody: 'B',
  pinned: false, bgColor: '', bgImage: '', isCbox: false, labels: [], archived: false, trashed: false, sortOrder: 9,
  checkBoxes: [{ id: 1, done: false, data: 'x' }], images: [], collaborators: [{ id: 2, username: 'u', displayName: 'U', avatarDataUrl: '', avatarPreset: 'cat', shareCount: 0, online: true }]
});

describe('sameDisplayedNote', () => {
  it('treats an equal copy read from storage as the note already shown, ignoring presence', () => {
    const shown = base();
    const fresh = { ...base(), collaborators: [{ ...base().collaborators![0], online: undefined }], ownerOnline: undefined };
    expect(sameDisplayedNote(shown, fresh)).toBeTrue();
  });

  it('notices anything that changes what a card shows, even when the revision did not move', () => {
    const shown = base();
    const changes: Array<Partial<NoteI>> = [
      { revision: 4 }, { lwwOperationId: 'other' }, { noteTitle: 'New' }, { noteBody: 'New' }, { pinned: true }, { archived: true },
      { sortOrder: 10 }, { isCardPreview: true }, { ownerDisplayName: 'Renamed' },
      { labels: [{ id: 1, name: 'a', added: true }] }, { images: [{ id: 'i', dataUrl: 'u', name: 'n', placement: 'top' }] },
      { checkBoxes: [{ id: 1, done: true, data: 'x' }] }, { attachments: [{ id: 1 } as any] },
      { collaborators: [{ ...base().collaborators![0], displayName: 'Renamed' }] }
    ];
    for (const change of changes) expect(sameDisplayedNote(shown, { ...base(), ...change })).withContext(JSON.stringify(change)).toBeFalse();
  });
});
