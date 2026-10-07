import { computed, Injectable, signal } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { NoteI } from '../interfaces/notes';

const EMPTY_NOTES: NoteI[] = [];

/**
 * The in-memory note collection and its identity indexes.
 * NotesService owns persistence/network commands; this store owns the current
 * ordered collection and fast identity lookups. notes$ remains the compatibility
 * stream while the web components migrate to narrower selectors.
 */
@Injectable({ providedIn: 'root' })
export class NotesStoreService {
  private readonly records = signal<NoteI[] | null>(null);
  readonly allNotes = computed(() => this.records() || EMPTY_NOTES);
  readonly pinnedNotes = computed(() => this.allNotes().filter(note => note.pinned === true));
  readonly unpinnedNotes = computed(() => this.allNotes().filter(note => note.pinned === false));
  readonly notes$ = new BehaviorSubject<NoteI[] | null>(null);
  private readonly bySyncId = new Map<string, NoteI>();
  private readonly byServerId = new Map<number, NoteI>();

  get value() {
    return this.records();
  }

  publish(notes: NoteI[]) {
    this.bySyncId.clear();
    this.byServerId.clear();
    notes.forEach(note => this.index(note));
    this.records.set(notes);
    this.notes$.next(notes);
  }

  publishDelta(notes: NoteI[], upserts: readonly NoteI[], removedSyncIds: readonly string[]) {
    for (const syncId of removedSyncIds) {
      const previous = this.bySyncId.get(syncId);
      if (!previous) continue;
      this.bySyncId.delete(syncId);
      if (previous.id != null && this.byServerId.get(previous.id) === previous) this.byServerId.delete(previous.id);
    }
    for (const note of upserts) {
      const previous = note.syncId ? this.bySyncId.get(note.syncId) : undefined;
      if (previous?.id != null && this.byServerId.get(previous.id) === previous) this.byServerId.delete(previous.id);
      this.index(note);
    }
    this.records.set(notes);
    this.notes$.next(notes);
  }

  clear() {
    this.bySyncId.clear();
    this.byServerId.clear();
    this.records.set(null);
    this.notes$.next(null);
  }

  getBySyncId(syncId: string) {
    return this.bySyncId.get(syncId);
  }

  getByServerId(id: number) {
    return this.byServerId.get(id);
  }

  indexOfServerId(id: number) {
    const note = this.byServerId.get(id);
    return note ? this.value?.indexOf(note) ?? -1 : -1;
  }

  upsert(note: NoteI) {
    const current = this.value;
    if (!current) return;
    const existing = (note.id == null ? undefined : this.getByServerId(note.id))
      || (note.syncId ? this.getBySyncId(note.syncId) : undefined);
    const index = existing ? current.indexOf(existing) : -1;
    const next = [...current];
    if (index < 0) next.unshift(note);
    else next[index] = note;
    this.publishDelta(next, [note], []);
  }

  removeByServerId(id: number) {
    const current = this.value;
    const index = this.indexOfServerId(id);
    if (!current || index < 0) return false;
    const next = [...current];
    const removed = current[index];
    next.splice(index, 1);
    this.publishDelta(next, [], removed.syncId ? [removed.syncId] : []);
    return true;
  }

  private index(note: NoteI) {
    if (note.syncId) this.bySyncId.set(note.syncId, note);
    if (note.id != null) this.byServerId.set(note.id, note);
  }
}
