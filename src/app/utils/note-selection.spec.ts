import { NoteI } from '../interfaces/notes';
import { selectedNotesOf } from './note-selection';

const note = (id?: number): NoteI => ({ id, noteTitle: '', pinned: false, bgColor: '', bgImage: '', isCbox: false, labels: [], archived: false, trashed: false });

describe('selectedNotesOf', () => {
  it('returns selected notes in collection order regardless of which cards are mounted', () => {
    const all = [note(1), note(2), note(3), note(4)];
    expect(selectedNotesOf(all, [4, 2]).map(item => item.id)).toEqual([2, 4]);
  });

  it('ignores ids that are not in the collection and is empty without a selection', () => {
    const all = [note(1), note(undefined), note(2)];
    expect(selectedNotesOf(all, [99, 2]).map(item => item.id)).toEqual([2]);
    expect(selectedNotesOf(all, [])).toEqual([]);
  });
});
