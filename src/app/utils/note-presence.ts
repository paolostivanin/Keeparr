import type { NoteI } from '../interfaces/notes';
import type { ReminderI } from '../interfaces/reminder';

/**
 * Presence is presentation-only state. These helpers apply it immutably so a
 * presence flip replaces only the affected notes (unchanged notes keep their
 * identity and their cached card values), and let consumers tell a presence-only
 * publication apart from one that can change layout.
 */

/** The same note when nothing changes, otherwise a copy with the owner/collaborator online flags updated. */
export function withPresence(note: NoteI, userId: number, online: boolean): NoteI {
  let next = note;
  if (note.ownerUserId === userId && note.ownerOnline !== online) next = { ...next, ownerOnline: online };
  if (note.collaborators?.some(collaborator => collaborator.id === userId && collaborator.online !== online)) {
    next = {
      ...next,
      collaborators: note.collaborators.map(collaborator =>
        collaborator.id === userId && collaborator.online !== online ? { ...collaborator, online } : collaborator)
    };
  }
  return next;
}

function sameCollaboratorsIgnoringPresence(left: NoteI['collaborators'], right: NoteI['collaborators']) {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  return left.every((collaborator, index) => {
    const other = right[index];
    return collaborator === other || (
      collaborator.id === other.id && collaborator.username === other.username && collaborator.displayName === other.displayName
      && collaborator.avatarDataUrl === other.avatarDataUrl && collaborator.avatarPreset === other.avatarPreset
    );
  });
}

function differsOnlyByPresence(left: NoteI, right: NoteI) {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]);
  for (const key of keys) {
    if (key === 'ownerOnline') continue;
    if (key === 'collaborators') {
      if (!sameCollaboratorsIgnoringPresence(left.collaborators, right.collaborators)) return false;
      continue;
    }
    if (leftRecord[key] !== rightRecord[key]) return false;
  }
  return true;
}

/** False when `next` is `previous` with at most presence flags changed (same notes, same order). */
export function notesChangeLayout(previous: readonly NoteI[] | null | undefined, next: readonly NoteI[] | null | undefined) {
  if (!previous || !next || previous.length !== next.length) return true;
  for (let index = 0; index < next.length; index++) {
    const before = previous[index];
    const after = next[index];
    if (before === after) continue;
    if (before.id !== after.id || before.syncId !== after.syncId || !differsOnlyByPresence(before, after)) return true;
  }
  return false;
}

/** Changes whenever a reminder can add, remove or alter a card's reminder chip. */
export function reminderChipKey(reminders: readonly Pick<ReminderI, 'noteId' | 'status' | 'dueAtUtc' | 'locationName' | 'repeatRule'>[] | null | undefined) {
  if (!reminders?.length) return '';
  return reminders
    .filter(reminder => reminder.noteId != null)
    .map(reminder => `${reminder.noteId}:${reminder.status}:${reminder.dueAtUtc || ''}:${reminder.locationName || ''}:${reminder.repeatRule || ''}`)
    .join('|');
}
