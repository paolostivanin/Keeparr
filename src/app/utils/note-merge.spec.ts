import { NoteI } from '../interfaces/notes';
import { changedNoteFields, mergeGuardedNote, pickGuardFields } from './note-merge';

function note(patch: Partial<NoteI> = {}): NoteI {
  return {
    id: 1, syncId: 's1', revision: 3, noteTitle: 'Title', noteBody: 'Body', pinned: false, bgColor: '', bgImage: '',
    isCbox: false, labels: [], archived: false, trashed: false, ...patch
  };
}

describe('mergeGuardedNote', () => {
  it('keeps concurrent label, organization, and personal-state changes when only the body was edited', () => {
    const base = pickGuardFields(note());
    const local = note({ noteBody: 'My body' });
    const latest = note({ revision: 4, labels: [{ id: 2, name: 'work', added: true }], archived: true, pinned: true, bgColor: '#ff0000' });

    const { merged, conflicts, localFields } = mergeGuardedNote(base, local, latest);

    expect(conflicts).toEqual([]);
    expect(localFields).toEqual(['noteBody']);
    expect(merged.noteBody).toBe('My body');
    expect(merged.labels.map(label => label.name)).toEqual(['work']);
    expect(merged.archived).toBeTrue();
    expect(merged.pinned).toBeTrue();
    expect(merged.bgColor).toBe('#ff0000');
    expect(merged.revision).toBe(4);
  });

  it('reports a conflict only when both sides changed the same field differently', () => {
    const base = pickGuardFields(note());
    const local = note({ noteTitle: 'Mine', noteBody: 'Mine body' });
    const latest = note({ revision: 4, noteTitle: 'Theirs', noteBody: 'Body' });

    const { merged, conflicts } = mergeGuardedNote(base, local, latest);

    expect(conflicts).toEqual(['noteTitle']);
    expect(merged.noteBody).toBe('Mine body');
    expect(merged.noteTitle).toBe('Theirs');
  });

  it('treats identical concurrent edits and representation differences as no conflict', () => {
    const base = pickGuardFields(note({ bgColor: '#FFAA00', labels: [{ name: 'a', added: true }, { name: 'b', added: true }] }));
    const local = note({ noteTitle: 'Same', bgColor: 'rgb(255, 170, 0)', labels: [{ name: 'b', added: true }, { name: 'a', added: true }] });
    const latest = note({ revision: 4, noteTitle: 'Same', bgColor: '#ffaa00', labels: [{ name: 'a', added: true }, { name: 'b', added: true }] });
    expect(mergeGuardedNote(base, local, latest).conflicts).toEqual([]);
    expect(changedNoteFields(base, local)).toEqual(['noteTitle']);
  });
});
