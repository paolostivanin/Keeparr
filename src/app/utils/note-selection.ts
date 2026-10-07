import type { NoteI } from '../interfaces/notes';

/**
 * The selected notes, in collection order. Selection is held as note IDs, so it does not depend on
 * which cards are currently mounted by a virtualized list; only the collection matters.
 */
export function selectedNotesOf(all: readonly NoteI[], ids: readonly number[]): NoteI[] {
  if (!ids.length) return [];
  const selected = new Set(ids);
  return all.filter(note => !!note.id && selected.has(note.id));
}
