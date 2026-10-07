import type { NoteI } from '../interfaces/notes';

/**
 * Durable editor session model. A session tracks the accepted base of the note
 * being edited, which fields differ from that base (dirty fields), a
 * monotonically increasing draft generation, and the local/remote save state.
 *
 * The model is pure; persistence is supplied by `EditorSessionPersister` so the
 * same rules can be exercised without a DOM or IndexedDB.
 */

export const EDITOR_DRAFT_FIELDS = [
  'noteTitle',
  'noteBody',
  'pinned',
  'bgColor',
  'bgImage',
  'checkBoxes',
  'images',
  'isCbox',
  'labels',
  'binder',
  'archived',
  'trashed'
] as const;

export type EditorDraftField = (typeof EDITOR_DRAFT_FIELDS)[number];
export type EditorDraft = Pick<NoteI, EditorDraftField>;

/** `saved-local` means the document and its replayable outbox command are committed on this device. */
export type EditorLocalState = 'clean' | 'dirty' | 'saving' | 'saved-local' | 'failed';
/** `queued` means a replayable command exists; acknowledgement tracking belongs to the outbox (M1.4). */
export type EditorRemoteState = 'none' | 'queued';

export const NEW_NOTE_SESSION_KEY = 'new';

export interface EditorSessionRecord {
  /** `${partition}|${sessionKey}`: the store key. */
  key: string;
  partition: string;
  /** Note sync ID for existing notes; `NEW_NOTE_SESSION_KEY` for the composer. */
  sessionKey: string;
  noteId?: number;
  /** Accepted base the draft is measured against; null for a note that does not exist yet. */
  baseRevision?: number;
  baseUpdatedAt?: string;
  base: EditorDraft | null;
  draft: EditorDraft;
  dirtyFields: EditorDraftField[];
  generation: number;
  savedGeneration: number;
  localState: EditorLocalState;
  remoteState: EditorRemoteState;
  lastError?: string;
  updatedAt: number;
}

export function editorSessionKey(partition: string, sessionKey: string) {
  return `${partition}|${sessionKey}`;
}

export function emptyEditorDraft(): EditorDraft {
  return {
    noteTitle: '',
    noteBody: '',
    pinned: false,
    bgColor: '',
    bgImage: '',
    checkBoxes: [],
    images: [],
    isCbox: false,
    labels: [],
    binder: '',
    archived: false,
    trashed: false
  };
}

export function dirtyEditorFields(base: EditorDraft | null, draft: EditorDraft): EditorDraftField[] {
  const reference = base ?? emptyEditorDraft();
  return EDITOR_DRAFT_FIELDS.filter(field => JSON.stringify(reference[field] ?? null) !== JSON.stringify(draft[field] ?? null));
}

/** Overlay only the dirty fields of a recovered draft onto the latest known note. */
export function applyEditorDraft<T extends NoteI>(note: T, record: Pick<EditorSessionRecord, 'draft' | 'dirtyFields'>): T {
  const next = { ...note } as Record<string, unknown>;
  for (const field of record.dirtyFields) next[field] = structuredClone(record.draft[field]);
  return next as unknown as T;
}

export class EditorSessionTracker {
  private record: EditorSessionRecord;
  private inFlight?: { generation: number; draft: EditorDraft };

  constructor(
    partition: string,
    sessionKey: string,
    base: NoteI | null,
    pickBase: (note: NoteI) => EditorDraft,
    now: () => number = Date.now
  ) {
    this.now = now;
    this.record = {
      key: editorSessionKey(partition, sessionKey),
      partition,
      sessionKey,
      noteId: base?.id,
      baseRevision: base?.revision,
      baseUpdatedAt: base?.updatedAt,
      base: base ? structuredClone(pickBase(base)) : null,
      draft: base ? structuredClone(pickBase(base)) : emptyEditorDraft(),
      dirtyFields: [],
      generation: 0,
      savedGeneration: 0,
      localState: 'clean',
      remoteState: 'none',
      updatedAt: now()
    };
  }

  private readonly now: () => number;

  get snapshot(): Readonly<EditorSessionRecord> {
    return this.record;
  }

  get generation() {
    return this.record.generation;
  }

  get hasUnsavedChanges() {
    return this.record.dirtyFields.length > 0;
  }

  /** Re-adopt a record loaded from storage, keeping the current in-memory base. */
  adopt(record: EditorSessionRecord) {
    const { key, partition, noteId, baseRevision, baseUpdatedAt, base } = this.record;
    this.record = {
      ...structuredClone(record), key, partition, noteId, baseRevision, baseUpdatedAt, base,
      localState: record.dirtyFields.length ? 'dirty' : 'clean'
    };
    this.inFlight = undefined;
  }

  /**
   * Record the editor's current content. Returns the record to persist, or
   * undefined when nothing changed since the previous capture. A capture that
   * returns to the base after earlier edits reports a clean record so the
   * stored draft can be removed.
   */
  capture(draft: EditorDraft): EditorSessionRecord | undefined {
    const dirtyFields = dirtyEditorFields(this.record.base, draft);
    const unchanged = JSON.stringify(dirtyFields) === JSON.stringify(this.record.dirtyFields)
      && dirtyFields.every(field => JSON.stringify(this.record.draft[field] ?? null) === JSON.stringify(draft[field] ?? null));
    if (unchanged && this.record.localState !== 'failed') return undefined;
    if (unchanged) return this.record;
    this.record = {
      ...this.record,
      draft: structuredClone(draft),
      dirtyFields,
      generation: this.record.generation + 1,
      localState: this.record.localState === 'saving' ? 'saving' : (dirtyFields.length ? 'dirty' : 'clean'),
      updatedAt: this.now()
    };
    return this.record;
  }

  beginSave(): number {
    this.inFlight = { generation: this.record.generation, draft: structuredClone(this.record.draft) };
    this.record = { ...this.record, localState: 'saving', lastError: undefined };
    return this.inFlight.generation;
  }

  /**
   * The saved generation is now durable locally with its outbox command. The
   * accepted base advances to what was saved; edits typed during the save
   * stay dirty relative to the new base rather than being overwritten.
   */
  saveSucceeded(generation: number, accepted?: Pick<NoteI, 'id' | 'revision' | 'updatedAt'>): EditorSessionRecord {
    const saved = this.inFlight?.generation === generation ? this.inFlight.draft : this.record.draft;
    const dirtyFields = dirtyEditorFields(saved, this.record.draft);
    this.inFlight = undefined;
    this.record = {
      ...this.record,
      noteId: accepted?.id ?? this.record.noteId,
      baseRevision: accepted?.revision ?? this.record.baseRevision,
      baseUpdatedAt: accepted?.updatedAt ?? this.record.baseUpdatedAt,
      base: structuredClone(saved),
      dirtyFields,
      savedGeneration: Math.max(this.record.savedGeneration, generation),
      localState: dirtyFields.length ? 'dirty' : 'saved-local',
      remoteState: 'queued',
      lastError: undefined,
      updatedAt: this.now()
    };
    return this.record;
  }

  saveFailed(generation: number, message: string): EditorSessionRecord {
    if (this.inFlight?.generation === generation) this.inFlight = undefined;
    this.record = { ...this.record, localState: 'failed', lastError: message, updatedAt: this.now() };
    return this.record;
  }
}

export interface EditorSessionStorage {
  put(record: EditorSessionRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Serializes draft writes so a later delete can never be overtaken by an
 * earlier put. A storage failure is remembered (and surfaced through
 * `onFailure`) and the latest record is retried by the next write or flush;
 * the in-memory editor content is never discarded because of it.
 */
export class EditorSessionPersister {
  private chain: Promise<void> = Promise.resolve();
  private pending?: { kind: 'put'; record: EditorSessionRecord } | { kind: 'delete'; key: string };
  failed = false;

  constructor(
    private readonly storage: EditorSessionStorage,
    private readonly onFailure: (failed: boolean) => void = () => undefined
  ) {}

  put(record: EditorSessionRecord) {
    return this.enqueue({ kind: 'put', record: structuredClone(record) });
  }

  delete(key: string) {
    return this.enqueue({ kind: 'delete', key });
  }

  /** Resolves when everything queued so far has been attempted; retries a previously failed write. */
  flush() {
    if (this.pending) return this.enqueue(this.pending);
    return this.chain;
  }

  private enqueue(op: NonNullable<EditorSessionPersister['pending']>) {
    this.pending = op;
    this.chain = this.chain.then(async () => {
      if (this.pending !== op) return;
      try {
        if (op.kind === 'put') await this.storage.put(op.record);
        else await this.storage.delete(op.key);
        this.pending = undefined;
        this.setFailed(false);
      } catch {
        this.setFailed(true);
      }
    });
    return this.chain;
  }

  private setFailed(failed: boolean) {
    if (this.failed === failed) return;
    this.failed = failed;
    this.onFailure(failed);
  }
}
