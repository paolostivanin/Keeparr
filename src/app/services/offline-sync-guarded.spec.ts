import { HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, Subject, of, throwError } from 'rxjs';
import { NoteI } from '../interfaces/notes';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';

type Mutation = { type: string; syncId: string; operationId: string; payload: NoteI; baseRevision?: number };

/** Minimal server: revision-guarded note upserts with durable operation receipts. */
class FakeServer {
  notes = new Map<string, NoteI>();
  receipts = new Map<string, unknown>();
  received: Mutation[] = [];
  guardedSupport: boolean | 'missing' = true;
  failNextResponse = false;
  status: 'ok' | 403 = 'ok';

  seed(note: NoteI) {
    this.notes.set(note.syncId!, { ...note });
  }

  change(syncId: string, patch: Partial<NoteI>) {
    const current = this.notes.get(syncId)!;
    this.notes.set(syncId, { ...current, ...patch, revision: (current.revision || 0) + 1 });
  }

  http() {
    return {
      get: (url: string) => {
        if (url.endsWith('/client/capabilities')) {
          if (this.guardedSupport === 'missing') return throwError(() => new HttpErrorResponse({ status: 404 }));
          return of({ noteRevisions: this.guardedSupport });
        }
        if (url.endsWith('/sync/changes')) return of({
          changes: [...this.notes.values()].map(note => ({ resourceType: 'note', resourceSyncId: note.syncId, operation: 'upsert', payload: note, sequence: 1 })),
          cursor: 1, hasMore: false, serverTime: Date.now()
        });
        return of({});
      },
      post: (_url: string, body: { mutations: Mutation[] }) => {
        const results = body.mutations.map(mutation => this.apply(mutation));
        if (this.failNextResponse) {
          this.failNextResponse = false;
          return throwError(() => new HttpErrorResponse({ status: 0 }));
        }
        return of({ results, serverTime: Date.now() });
      }
    };
  }

  private apply(mutation: Mutation) {
    this.received.push(JSON.parse(JSON.stringify(mutation)));
    const receipt = this.receipts.get(mutation.operationId);
    if (receipt) return receipt;
    if (this.status === 403) return { ok: false, status: 403, error: 'Note not accessible.', syncId: mutation.syncId };
    const existing = this.notes.get(mutation.syncId);
    if (mutation.baseRevision !== undefined && (existing ? existing.revision !== mutation.baseRevision : mutation.baseRevision !== 0)) {
      return { ok: false, status: 409, resourceType: 'note', syncId: mutation.syncId, latest: existing ? { ...existing } : null };
    }
    const saved = { ...mutation.payload, revision: (existing?.revision || 0) + 1 };
    this.notes.set(mutation.syncId, saved);
    const result = { ok: true, resourceType: 'note', syncId: mutation.syncId, id: saved.id, payload: { ...saved } };
    this.receipts.set(mutation.operationId, result);
    return result;
  }
}

function note(title: string, patch: Partial<NoteI> = {}): NoteI {
  return {
    id: 5, syncId: 'n5', revision: 1, noteTitle: title, noteBody: 'Body', pinned: false, bgColor: '', bgImage: '',
    isCbox: false, labels: [], archived: false, trashed: false, ...patch
  };
}

describe('OfflineSyncService guarded note saves', () => {
  let server: FakeServer;
  let store: OfflineStoreService;
  let service: OfflineSyncService;
  let partition: string;

  function createService(sharedStore = store) {
    const instance = Object.create(OfflineSyncService.prototype) as OfflineSyncService;
    Object.assign(instance, {
      apiUrl: '/api',
      currentPartition: partition,
      syncRequestTimeoutMs: 1000,
      http: server.http(),
      auth: { authHeaders: () => ({}), isAuthExpiredError: () => false },
      store: sharedStore,
      cacheChanged$: new Subject(),
      attention$: new BehaviorSubject([]),
      state$: new BehaviorSubject('saved')
    });
    return instance;
  }

  const outbox = () => store.listOutbox(partition);

  async function save(next: NoteI) {
    const stamp = store.nextStamp();
    return (await store.persistNoteMutation(partition, next, stamp)).entry;
  }

  beforeEach(async () => {
    server = new FakeServer();
    store = new OfflineStoreService();
    partition = `guarded-sync-${crypto.randomUUID()}`;
    service = createService();
    server.seed(note('Original', { revision: 4 }));
    await store.replaceSnapshot(partition, [note('Original', { revision: 4 })], [], [], 1, Date.now());
  });

  afterEach(async () => store.purgePartition(partition));

  it('sends the accepted base revision and advances the server revision', async () => {
    await save(note('Edited', { revision: 4 }));
    await (service as any).flushMutations(await outbox());

    expect(server.received[0].baseRevision).toBe(4);
    expect(server.notes.get('n5')!.noteTitle).toBe('Edited');
    expect(await outbox()).toEqual([]);
  });

  it('falls back to explicit last-writer-wins when the server lacks revision support', async () => {
    server.guardedSupport = 'missing';
    await save(note('Edited', { revision: 4 }));
    await (service as any).flushMutations(await outbox());
    expect(server.received[0].baseRevision).toBeUndefined();

    server.guardedSupport = false;
    (service as any).guardedNotes = undefined;
    await save(note('Edited again', { revision: 5 }));
    await (service as any).flushMutations(await outbox());
    expect(server.received[1].baseRevision).toBeUndefined();
    expect(server.notes.get('n5')!.noteTitle).toBe('Edited again');
  });

  it('merges a concurrent change to other fields and resends against the latest revision', async () => {
    await save(note('Edited title', { revision: 4 }));
    server.change('n5', { labels: [{ id: 9, name: 'remote-label', added: true }], archived: true, pinned: true });

    await (service as any).flushMutations(await outbox());

    const saved = server.notes.get('n5')!;
    expect(saved.noteTitle).toBe('Edited title');
    expect(saved.labels.map(label => label.name)).toEqual(['remote-label']);
    expect(saved.archived).toBeTrue();
    expect(saved.pinned).toBeTrue();
    expect(server.received.map(item => item.baseRevision)).toEqual([4, 5]);
    expect(new Set(server.received.map(item => item.operationId)).size).toBe(2);
    expect(await outbox()).toEqual([]);
    expect((service as any).attention$.value).toEqual([]);
  });

  it('parks a true conflict with its local draft, does not resend it, and surfaces it', async () => {
    const entry = await save(note('My title', { revision: 4 }));
    server.change('n5', { noteTitle: 'Their title' });

    await (service as any).flushMutations(await outbox());
    await service.refreshAttention();

    const [item] = (service as any).attention$.value;
    expect(item).toEqual(jasmine.objectContaining({ key: entry.key, reason: 'conflict', conflictFields: ['noteTitle'], canKeepMine: true }));
    const [parked] = await outbox();
    expect((parked.payload as NoteI).noteTitle).toBe('My title');
    expect(parked.blocked?.latest?.noteTitle).toBe('Their title');
    const sends = server.received.length;
    await (service as any).flushMutations(await outbox());
    expect(server.received.length).toBe(sends);
    expect(server.notes.get('n5')!.noteTitle).toBe('Their title');
  });

  it('lets the user keep their version, which resends against the latest revision', async () => {
    const entry = await save(note('My title', { revision: 4 }));
    server.change('n5', { noteTitle: 'Their title', archived: true });
    await (service as any).flushMutations(await outbox());

    await service.resolveBlockedNote(entry.key, 'mine');
    await (service as any).flushMutations(await outbox());

    const saved = server.notes.get('n5')!;
    expect(saved.noteTitle).toBe('My title');
    expect(saved.archived).toBeTrue();
    expect(await outbox()).toEqual([]);
  });

  it('lets the user take the other version, discarding the parked save', async () => {
    const entry = await save(note('My title', { revision: 4 }));
    server.change('n5', { noteTitle: 'Their title' });
    await (service as any).flushMutations(await outbox());

    expect(await service.blockedLocalNote(entry.key).then(local => local?.noteTitle)).toBe('My title');
    await service.resolveBlockedNote(entry.key, 'theirs');

    expect(await outbox()).toEqual([]);
    expect((await store.getNoteBySyncId(partition, 'n5'))?.noteTitle).toBe('Their title');
    expect((service as any).attention$.value).toEqual([]);
  });

  it('parks a save when access to the note was revoked and keeps the edit', async () => {
    const entry = await save(note('Edit after revocation', { revision: 4 }));
    server.status = 403;
    await (service as any).flushMutations(await outbox());
    await service.refreshAttention();

    const [item] = (service as any).attention$.value;
    expect(item).toEqual(jasmine.objectContaining({ key: entry.key, reason: 'access-revoked', canKeepMine: false }));
    await service.resolveBlockedNote(entry.key, 'mine'); // not offered for revoked access
    expect((await outbox()).length).toBe(1);
    await service.resolveBlockedNote(entry.key, 'theirs');
    expect(await outbox()).toEqual([]);
  });

  describe('acknowledgement chains', () => {
    it('keeps a successor behind a lost-response predecessor and replays the identical operation', async () => {
      const first = await save(note('First', { revision: 4 }));
      server.failNextResponse = true;
      await expectAsync((service as any).flushMutations(await outbox())).toBeRejected();
      const second = await save(note('Second', { revision: 4 }));

      // The first request was applied but its response was lost; it is now immutable.
      const queued = await outbox();
      expect(queued.map(entry => entry.operationId)).toEqual([first.operationId, second.operationId]);
      expect(queued[0].deliveryState).toBe('sent');
      expect((queued[0].payload as NoteI).noteTitle).toBe('First');

      await (service as any).flushMutations(await outbox());

      const sent = server.received;
      expect(sent[0].operationId).toBe(first.operationId);
      expect(sent[1].operationId).toBe(first.operationId);
      expect(sent[1]).toEqual(sent[0]);
      expect(sent[2].operationId).toBe(second.operationId);
      // Replay did not apply twice: Original(4) -> First(5) -> Second(6).
      expect(sent[2].baseRevision).toBe(5);
      expect(server.notes.get('n5')!.noteTitle).toBe('Second');
      expect(server.notes.get('n5')!.revision).toBe(6);
      expect(await outbox()).toEqual([]);
    });

    it('never sends a chained save in the same request as its predecessor', async () => {
      const first = await save(note('First', { revision: 4 }));
      await store.claimOutboxForSend([first.key]);
      const second = await save(note('Second', { revision: 4 }));
      const requests: string[][] = [];
      const http = server.http();
      (service as any).http = { ...http, post: (url: string, body: { mutations: Mutation[] }) => {
        requests.push(body.mutations.map(item => item.operationId));
        return http.post(url, body);
      } };

      await (service as any).flushMutations(await outbox());

      expect(requests).toEqual([[first.operationId], [second.operationId]]);
    });

    it('does not let an older acknowledgement overwrite a newer pending draft in the cache', async () => {
      const first = await save(note('First', { revision: 4 }));
      await store.claimOutboxForSend([first.key]);
      await save(note('Second draft', { revision: 4 }));
      server.notes.set('n5', note('First', { revision: 5 }));

      await (service as any).pullChanges();

      expect((await store.getNoteBySyncId(partition, 'n5'))?.noteTitle).toBe('Second draft');
      expect((await store.getNoteBySyncId(partition, 'n5'))?.revision).toBe(5);
    });

    it('rebases a chained save that loses to a concurrent change from another device', async () => {
      const first = await save(note('First', { revision: 4 }));
      await store.claimOutboxForSend([first.key]);
      await save(note('Second', { revision: 4 }));
      const stale = (service as any).http;
      let injected = false;
      (service as any).http = { ...stale, post: (url: string, body: { mutations: Mutation[] }) => {
        const response = stale.post(url, body);
        if (!injected) { injected = true; server.change('n5', { labels: [{ id: 3, name: 'other-device', added: true }] }); }
        return response;
      } };

      await (service as any).flushMutations(await outbox());

      const saved = server.notes.get('n5')!;
      expect(saved.noteTitle).toBe('Second');
      expect(saved.labels.map(label => label.name)).toEqual(['other-device']);
      expect(await outbox()).toEqual([]);
    });
  });

  describe('two tabs', () => {
    it('without Web Locks, concurrent flushes of one entry stay replay-safe through its receipt', async () => {
      const entry = await save(note('Edited', { revision: 4 }));
      const other = createService();
      const entries = await outbox();

      await Promise.all([(service as any).flushMutations(entries), (other as any).flushMutations(entries)]);

      expect(server.received.filter(item => item.operationId === entry.operationId).length).toBe(2);
      expect(server.notes.get('n5')!.revision).toBe(5);
      expect(server.notes.get('n5')!.noteTitle).toBe('Edited');
      expect(await outbox()).toEqual([]);
    });

    it('serializes syncNow through a partition Web Lock when available and runs directly otherwise', async () => {
      const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
      const held: string[] = [];
      Object.defineProperty(navigator, 'locks', { configurable: true, value: {
        request: (name: string, _options: unknown, callback: () => Promise<void>) => { held.push(name); return callback(); }
      } });
      const cycle = spyOn(service as any, 'syncCycle').and.resolveTo(undefined);
      Object.assign(service, { auth: { currentUser: { id: 1 } } });
      try {
        await service.syncNow();
        expect(held).toEqual([`keeparr-offline-sync:${partition}`]);
        Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
        await service.syncNow();
        expect(held.length).toBe(1);
        expect(cycle).toHaveBeenCalledTimes(2);
      } finally {
        if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
        else delete (navigator as any).locks;
      }
    });
  });
});
