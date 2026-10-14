import type { NoteI } from '../interfaces/notes';
import { prefersReducedMotion } from './motion';

type PageFilter = (note: NoteI) => boolean;

let staysOnPage: PageFilter | undefined;
const entering = new Map<string, number>(); // card key (syncId, else id) -> time the mark expires

/** The notes grid registers which notes its page lists, so a card only fades out when a change really takes it away. */
export function setNoteCardPageFilter(filter: PageFilter) {
  staysOnPage = filter;
}

/** Called when that grid goes away; a newer grid's filter is left in place. */
export function clearNoteCardPageFilter(filter: PageFilter) {
  if (staysOnPage === filter) staysOnPage = undefined;
}

/**
 * Runs `change` after fading out the cards it takes off the current page (`patch` is what it does to each note; `null`
 * removes the notes outright), so the remaining cards glide into the gap instead of jumping. Without a grid, with
 * nothing leaving, or with reduced motion, `change` runs straight away.
 */
export async function withLeavingNoteCards<T>(notes: readonly NoteI[], patch: Partial<NoteI> | null, change: () => T | Promise<T>): Promise<T> {
  const filter = staysOnPage;
  const cards = !filter || prefersReducedMotion() ? [] : notes
    .filter(note => note.id != null && (patch === null || !filter({ ...note, ...patch })))
    .flatMap(note => Array.from(document.querySelectorAll<HTMLElement>(`.note-container[data-note-id="${note.id}"]`)));
  if (!cards.length) return change();
  cards.forEach(card => card.classList.add('is-leaving'));
  await new Promise(resolve => setTimeout(resolve, cssDurationMs('--dur-exit', 100)));
  try {
    return await change();
  } finally {
    // A card the change did not remove after all (it failed, the page still lists the note) must not stay invisible.
    setTimeout(() => cards.forEach(card => card.classList.remove('is-leaving')), 400);
  }
}

/** The key a card carries as `data-note-key`. */
export function noteCardKey(note: Pick<NoteI, 'syncId' | 'id'>) {
  return String(note.syncId || note.id);
}

/** Notes the user just created or brought back; their cards get a one-shot entrance when the grid first places them. */
export function markNoteCardsEntering(notes: ReadonlyArray<Pick<NoteI, 'syncId' | 'id'>>) {
  if (prefersReducedMotion()) return;
  const expires = Date.now() + 2000;
  for (const note of notes) if (note.syncId || note.id != null) entering.set(noteCardKey(note), expires);
}

/** True once per marked card, while its mark is fresh. */
export function takeNoteCardEntering(key: string | undefined): boolean {
  const expires = key === undefined ? undefined : entering.get(key);
  if (expires === undefined) return false;
  entering.delete(key!);
  return expires > Date.now();
}

function cssDurationMs(property: string, fallback: number) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(property).trim();
  const amount = parseFloat(value);
  if (!Number.isFinite(amount)) return fallback;
  return value.endsWith('ms') ? amount : amount * 1000;
}
