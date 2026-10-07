import { NoteI } from '../interfaces/notes';
import { NoteQuery } from './note-query';

function note(id: number, patch: Partial<NoteI> = {}): NoteI {
  return {
    id, syncId: `n${id}`, noteTitle: `Note ${id}`, noteBody: '', pinned: false, bgColor: '', bgImage: '', isCbox: false,
    labels: [], archived: false, trashed: false, createdAt: '2024-03-05T10:00:00.000Z', ...patch
  };
}

const ids = (notes: NoteI[]) => notes.map(item => item.id);

describe('NoteQuery view membership', () => {
  const query = new NoteQuery();
  const label = (name: string) => ({ id: 1, name, added: true });

  it('places every note in exactly one of home/archived/trashed, even when cached flags are missing', () => {
    const legacy = { ...note(4), archived: undefined, trashed: undefined } as unknown as NoteI;
    const notes = [note(1), note(2, { archived: true }), note(3, { trashed: true }), legacy, note(5, { archived: true, trashed: true })];
    expect(ids(query.select(notes, 'home'))).toEqual([1, 4]);
    expect(ids(query.select(notes, 'archived'))).toEqual([2]);
    expect(ids(query.select(notes, 'trashed'))).toEqual([3, 5]);
  });

  it('keeps binder notes out of home unless searching all notes, and honours the current scope', () => {
    const notes = [note(1), note(2, { binder: 'Work', noteTitle: 'Quarterly report' }), note(3, { binder: 'Home' })];
    expect(ids(query.select(notes, 'home'))).toEqual([1]);
    expect(ids(query.select(notes, 'home', 'report', 'all'))).toEqual([2]);
    expect(ids(query.select(notes, 'home', 'report', 'current'))).toEqual([]);
    expect(ids(query.select(notes, 'binder:Work'))).toEqual([2]);
    expect(ids(query.select(notes, 'binder:Work', 'note', 'all'))).toEqual([1, 3]);
  });

  it('shows label pages including archived notes but never trashed ones', () => {
    const notes = [
      note(1, { labels: [label('travel')] }),
      note(2, { labels: [label('travel')], archived: true }),
      note(3, { labels: [label('travel')], trashed: true }),
      note(4, { labels: [{ id: 2, name: 'travel', added: false }] }),
      { ...note(5), labels: undefined } as unknown as NoteI
    ];
    expect(ids(query.select(notes, 'travel'))).toEqual([1, 2]);
  });

  it('selects shared notes by owner or collaborators among active notes', () => {
    const notes = [
      note(1, { ownerUserId: 9 }), note(2, { ownerUserId: 5, collaborators: [{ id: 7 } as any] }), note(3, { ownerUserId: 5 }),
      note(4, { ownerUserId: 9, archived: true })
    ];
    expect(ids(query.select(notes, 'shared', '', 'all', { myUserId: 5 }))).toEqual([1, 2]);
  });

  it('selects attachment notes from counts, flags, or lists', () => {
    const notes = [note(1, { hasAttachments: true }), note(2, { attachmentCount: 2 }), note(3, { attachments: [{ id: 1 } as any] }), note(4), note(5, { hasAttachments: true, trashed: true })];
    expect(ids(query.select(notes, 'attachments'))).toEqual([1, 2, 3]);
  });

  it('orders reminders by earliest pending due time, with untimed ones last, and ignores finished reminders', () => {
    const notes = [note(1), note(2), note(3), note(4), note(5)];
    const reminders = [
      { noteId: 1, status: 'pending', dueAtUtc: '2030-05-01T00:00:00.000Z' },
      { noteId: 1, status: 'pending', dueAtUtc: '2030-01-01T00:00:00.000Z' },
      { noteId: 2, status: 'pending', dueAtUtc: null },
      { noteId: 3, status: 'pending', dueAtUtc: '2030-03-01T00:00:00.000Z' },
      { noteId: 4, status: 'dismissed', dueAtUtc: '2020-01-01T00:00:00.000Z' }
    ] as any;
    expect(ids(query.select(notes, 'reminders', '', 'all', { reminders }))).toEqual([1, 3, 2]);
  });
});

describe('NoteQuery search', () => {
  const query = new NoteQuery();

  it('matches text across title, body, checklist items, labels, binder and attachment names, ignoring case and accents', () => {
    const notes = [
      note(1, { noteTitle: 'Café plans' }),
      note(2, { noteBody: '<p>Buy <b>MILK</b></p>' }),
      note(3, { checkBoxes: [{ id: 1, done: false, data: 'call dentist' }] }),
      note(4, { labels: [{ id: 1, name: 'garden', added: true }] }),
      note(5, { attachments: [{ id: 1, originalName: 'invoice.pdf' } as any] }),
      note(6)
    ];
    expect(ids(query.select(notes, 'home', 'cafe'))).toEqual([1]);
    expect(ids(query.select(notes, 'home', 'milk'))).toEqual([2]);
    expect(ids(query.select(notes, 'home', 'dentist'))).toEqual([3]);
    expect(ids(query.select(notes, 'home', 'garden'))).toEqual([4]);
    expect(ids(query.select(notes, 'home', 'invoice'))).toEqual([5]);
  });

  it('tolerates small typos in longer words but not in short ones', () => {
    const notes = [note(1, { noteTitle: 'Groceries' }), note(2, { noteTitle: 'cat' })];
    expect(ids(query.select(notes, 'home', 'grocries'))).toEqual([1]);
    expect(ids(query.select(notes, 'home', 'cot'))).toEqual([]);
  });

  it('applies operators and combines them with text', () => {
    const notes = [
      note(1, { images: [{ id: 'x', dataUrl: 'u', name: 'n', placement: 'top' }], noteTitle: 'Holiday' }),
      note(2, { images: [{ id: 'drawing', dataUrl: 'u', name: 'n', placement: 'top' }] }),
      note(3, { isCbox: true }),
      note(4, { noteBody: 'see https://example.test' }),
      note(5, { labels: [{ id: 1, name: 'Work Stuff', added: true }] }),
      note(6, { hasAttachments: true })
    ];
    expect(ids(query.select(notes, 'home', '!image'))).toEqual([1]);
    expect(ids(query.select(notes, 'home', '!draw'))).toEqual([2]);
    expect(ids(query.select(notes, 'home', '!todo'))).toEqual([3]);
    expect(ids(query.select(notes, 'home', '!url'))).toEqual([4]);
    expect(ids(query.select(notes, 'home', '!label'))).toEqual([5]);
    expect(ids(query.select(notes, 'home', '!label:work-stuff'))).toEqual([5]);
    expect(ids(query.select(notes, 'home', '!attach'))).toEqual([6]);
    expect(ids(query.select(notes, 'home', '!image holiday'))).toEqual([1]);
    expect(ids(query.select(notes, 'home', '!image nothing'))).toEqual([]);
  });

  it('filters by creation date language', () => {
    const notes = [note(1, { createdAt: '2021-06-15T12:00:00.000Z' }), note(2, { createdAt: '2022-06-15T12:00:00.000Z' }), note(3, { createdAt: undefined })];
    expect(ids(query.select(notes, 'home', '2021'))).toEqual([1]);
    expect(ids(query.select(notes, 'home', 'created june 2022'))).toEqual([2]);
    expect(ids(query.select(notes, 'home', '2022-06-15'))).toEqual([2]);
  });

  it('searches the server-provided text of a preview whose body is truncated', () => {
    const preview = note(1, { noteBody: 'short…', searchText: 'the full text mentions rhubarb', isCardPreview: true });
    expect(ids(query.select([preview], 'home', 'rhubarb'))).toEqual([1]);
  });

  it('returns the input collection untouched for an empty query so identities are preserved', () => {
    const notes = [note(1), note(2)];
    const result = query.select(notes, 'home', '   ');
    expect(result[0]).toBe(notes[0]);
    expect(result[1]).toBe(notes[1]);
  });
});
