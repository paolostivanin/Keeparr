import {
  EditorSessionPersister, EditorSessionRecord, EditorSessionStorage, EditorSessionTracker,
  NEW_NOTE_SESSION_KEY, applyEditorDraft, dirtyEditorFields, type EditorDraft
} from './editor-session';
import { NoteI } from '../interfaces/notes';

function note(patch: Partial<NoteI> = {}): NoteI {
  return {
    id: 4, syncId: 'sync-4', revision: 7, noteTitle: 'Title', noteBody: 'Body', pinned: false, bgColor: '', bgImage: '',
    isCbox: false, labels: [], archived: false, trashed: false, ...patch
  };
}

const pick = (value: NoteI): EditorDraft => ({
  noteTitle: value.noteTitle, noteBody: value.noteBody || '', pinned: value.pinned, bgColor: value.bgColor, bgImage: value.bgImage,
  checkBoxes: value.checkBoxes || [], images: value.images || [], isCbox: value.isCbox, labels: value.labels,
  binder: value.binder || '', archived: value.archived, trashed: value.trashed
});

function tracker(base: NoteI | null = note()) {
  return new EditorSessionTracker('p', base ? base.syncId! : NEW_NOTE_SESSION_KEY, base, pick);
}

describe('EditorSessionTracker', () => {
  it('tracks dirty fields and generations against the accepted base', () => {
    const session = tracker();
    expect(session.capture(pick(note()))).toBeUndefined();
    const first = session.capture(pick(note({ noteTitle: 'Changed' })))!;
    expect(first.dirtyFields).toEqual(['noteTitle']);
    expect(first.generation).toBe(1);
    expect(first.localState).toBe('dirty');
    expect(first.baseRevision).toBe(7);
    expect(session.capture(pick(note({ noteTitle: 'Changed' })))).toBeUndefined();
    const second = session.capture(pick(note({ noteTitle: 'Changed', pinned: true })))!;
    expect(second.dirtyFields).toEqual(['noteTitle', 'pinned']);
    expect(second.generation).toBe(2);
  });

  it('reports a clean record when edits are reverted so the stored draft can be removed', () => {
    const session = tracker();
    session.capture(pick(note({ noteBody: 'x' })));
    const reverted = session.capture(pick(note()))!;
    expect(reverted.dirtyFields).toEqual([]);
    expect(reverted.localState).toBe('clean');
  });

  it('advances the base on save without overwriting edits typed while saving', () => {
    const session = tracker();
    session.capture(pick(note({ noteTitle: 'A' })));
    const generation = session.beginSave();
    expect(session.snapshot.localState).toBe('saving');
    session.capture(pick(note({ noteTitle: 'AB' })));
    expect(session.snapshot.localState).toBe('saving');

    const record = session.saveSucceeded(generation);
    expect(record.base!.noteTitle).toBe('A');
    expect(record.draft.noteTitle).toBe('AB');
    expect(record.dirtyFields).toEqual(['noteTitle']);
    expect(record.localState).toBe('dirty');
    expect(record.remoteState).toBe('queued');
    expect(record.savedGeneration).toBe(generation);
  });

  it('is saved-local when nothing changed during the save', () => {
    const session = tracker(null);
    session.capture(pick(note({ noteTitle: 'New' })));
    const record = session.saveSucceeded(session.beginSave());
    expect(record.dirtyFields).toEqual([]);
    expect(record.localState).toBe('saved-local');
  });

  it('keeps the draft after a failed save and re-offers it for storage', () => {
    const session = tracker();
    session.capture(pick(note({ noteTitle: 'Keep me' })));
    const failed = session.saveFailed(session.beginSave(), 'quota');
    expect(failed.localState).toBe('failed');
    expect(failed.lastError).toBe('quota');
    expect(failed.dirtyFields).toEqual(['noteTitle']);
    expect(session.capture(pick(note({ noteTitle: 'Keep me' })))).toBe(session.snapshot);
  });

  it('measures a new note against an empty base', () => {
    expect(dirtyEditorFields(null, pick(note()))).toContain('noteTitle');
    expect(tracker(null).capture(pick(note({ noteTitle: '', noteBody: '' })))).toBeUndefined();
  });
});

describe('applyEditorDraft', () => {
  it('overlays only dirty fields so concurrent changes to other fields survive', () => {
    const session = tracker();
    const record = session.capture(pick(note({ noteTitle: 'Mine' })))!;
    const latest = note({ revision: 9, pinned: true, noteBody: 'Remote body' });
    const merged = applyEditorDraft(latest, record);
    expect(merged.noteTitle).toBe('Mine');
    expect(merged.pinned).toBeTrue();
    expect(merged.noteBody).toBe('Remote body');
    expect(merged.revision).toBe(9);
  });
});

describe('EditorSessionPersister', () => {
  class FakeStorage implements EditorSessionStorage {
    records = new Map<string, EditorSessionRecord>();
    failing = false;
    log: string[] = [];
    async put(record: EditorSessionRecord) {
      if (this.failing) throw new Error('storage unavailable');
      this.log.push(`put:${record.generation}`);
      this.records.set(record.key, record);
    }
    async delete(key: string) {
      if (this.failing) throw new Error('storage unavailable');
      this.log.push('delete');
      this.records.delete(key);
    }
  }

  it('applies writes in order so a delete is never overtaken by an earlier put', async () => {
    const storage = new FakeStorage();
    const persister = new EditorSessionPersister(storage);
    const session = tracker();
    const record = session.capture(pick(note({ noteTitle: 'x' })))!;
    persister.put(record);
    await persister.delete(record.key);
    expect(storage.records.has(record.key)).toBeFalse();
    expect(storage.log[storage.log.length - 1]).toBe('delete');
  });

  it('reports a storage failure, keeps the latest record, and retries it on flush', async () => {
    const storage = new FakeStorage();
    const states: boolean[] = [];
    const persister = new EditorSessionPersister(storage, failed => states.push(failed));
    const session = tracker();
    storage.failing = true;
    const record = session.capture(pick(note({ noteTitle: 'Important' })))!;
    await persister.put(record);
    expect(persister.failed).toBeTrue();
    expect(storage.records.size).toBe(0);

    storage.failing = false;
    await persister.flush();
    expect(persister.failed).toBeFalse();
    expect(storage.records.get(record.key)!.draft.noteTitle).toBe('Important');
    expect(states).toEqual([true, false]);
  });

  it('restores an interrupted session from the stored record', async () => {
    const storage = new FakeStorage();
    const persister = new EditorSessionPersister(storage);
    const first = tracker();
    await persister.put(first.capture(pick(note({ noteTitle: 'Before crash', pinned: true })))!);

    const reopened = tracker(note({ revision: 8 }));
    const stored = storage.records.get(reopened.snapshot.key)!;
    expect(stored.dirtyFields.length).toBe(2);
    const restored = applyEditorDraft(note({ revision: 8 }), stored);
    reopened.adopt(stored);
    expect(restored.noteTitle).toBe('Before crash');
    expect(reopened.snapshot.baseRevision).toBe(8);
    expect(reopened.generation).toBe(stored.generation);
    expect(reopened.hasUnsavedChanges).toBeTrue();
  });
});
