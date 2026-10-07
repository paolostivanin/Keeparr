import { NoteI } from '../interfaces/notes';
import { notesChangeLayout, reminderChipKey, withPresence } from './note-presence';

function note(id: number, patch: Partial<NoteI> = {}): NoteI {
  return {
    id, syncId: `n${id}`, noteTitle: `Note ${id}`, noteBody: 'Body', pinned: false, bgColor: '', bgImage: '', isCbox: false,
    labels: [], archived: false, trashed: false, ...patch
  };
}
const person = (id: number, online?: boolean) => ({ id, username: `u${id}`, displayName: `U${id}`, avatarDataUrl: '', avatarPreset: 'cat', shareCount: 0, online });

describe('withPresence', () => {
  it('returns the same note when presence is unchanged or unrelated', () => {
    const owned = note(1, { ownerUserId: 5, ownerOnline: true, collaborators: [person(7, false)] });
    expect(withPresence(owned, 5, true)).toBe(owned);
    expect(withPresence(owned, 7, false)).toBe(owned);
    expect(withPresence(owned, 99, true)).toBe(owned);
  });

  it('copies only the changed note and never mutates the original or untouched collaborators', () => {
    const collaborators = [person(7, false), person(8, false)];
    const original = note(1, { ownerUserId: 5, ownerOnline: false, collaborators });
    const updated = withPresence(original, 7, true);

    expect(updated).not.toBe(original);
    expect(updated.collaborators![0].online).toBeTrue();
    expect(updated.collaborators![1]).toBe(collaborators[1]);
    expect(original.collaborators![0].online).toBeFalse();
    expect(original.ownerOnline).toBeFalse();
    expect(withPresence(original, 5, true).ownerOnline).toBeTrue();
  });
});

describe('notesChangeLayout', () => {
  it('ignores presence-only publications but notices content, order and membership changes', () => {
    const a = note(1, { ownerUserId: 5, collaborators: [person(7, false)] });
    const b = note(2);
    const base = [a, b];

    expect(notesChangeLayout(base, [...base])).toBeFalse();
    expect(notesChangeLayout(base, [withPresence(a, 5, true), b])).toBeFalse();
    expect(notesChangeLayout(base, [withPresence(a, 7, true), b])).toBeFalse();
    expect(notesChangeLayout(base, [{ ...a, noteBody: 'Changed' }, b])).toBeTrue();
    expect(notesChangeLayout(base, [{ ...a, collaborators: [person(7, false), person(8)] }, b])).toBeTrue();
    expect(notesChangeLayout(base, [b, a])).toBeTrue();
    expect(notesChangeLayout(base, [a])).toBeTrue();
    expect(notesChangeLayout(null, base)).toBeTrue();
  });
});

describe('reminderChipKey', () => {
  const reminder = (patch: object = {}) => ({ noteId: 1, status: 'pending', dueAtUtc: '2030-01-01T00:00:00.000Z', locationName: null, repeatRule: null, ...patch }) as any;

  it('changes only when a card reminder chip can change', () => {
    const key = reminderChipKey([reminder()]);
    expect(reminderChipKey([reminder()])).toBe(key);
    expect(reminderChipKey([reminder({ dueAtUtc: '2030-02-01T00:00:00.000Z' })])).not.toBe(key);
    expect(reminderChipKey([reminder({ status: 'dismissed' })])).not.toBe(key);
    expect(reminderChipKey([reminder(), reminder({ noteId: 2 })])).not.toBe(key);
    expect(reminderChipKey([reminder({ noteId: null })])).toBe('');
    expect(reminderChipKey([])).toBe('');
  });
});
