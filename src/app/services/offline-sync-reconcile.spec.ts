import { BehaviorSubject, Subject, of } from 'rxjs';
import { NoteI } from '../interfaces/notes';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';

function note(id: number, syncId: string, title: string): NoteI {
  return {
    id, syncId, revision: 1, noteTitle: title, noteBody: '', pinned: false, bgColor: '', bgImage: '', isCbox: false,
    labels: [], archived: false, trashed: false
  };
}

describe('OfflineSyncService profile switches', () => {
  let store: OfflineStoreService;
  let first: string;
  let second: string;
  let service: OfflineSyncService;
  let release: Subject<unknown>;

  beforeEach(() => {
    store = new OfflineStoreService();
    first = `switch-a-${crypto.randomUUID()}`;
    second = `switch-b-${crypto.randomUUID()}`;
    release = new Subject();
    service = Object.create(OfflineSyncService.prototype) as OfflineSyncService;
    Object.assign(service, {
      apiUrl: '/api',
      currentPartition: first,
      syncRequestTimeoutMs: 5000,
      auth: { authHeaders: () => ({}), isAuthExpiredError: () => false },
      store,
      cacheChanged$: new Subject(),
      attention$: new BehaviorSubject([]),
      state$: new BehaviorSubject('saved')
    });
  });

  afterEach(async () => {
    await store.purgePartition(first);
    await store.purgePartition(second);
  });

  const switchProfile = () => { (service as any).currentPartition = second; };

  it('does not write a snapshot requested by one profile into the profile that replaced it', async () => {
    (service as any).http = { get: () => release };
    const pending = service.bootstrap();
    switchProfile();
    release.next({ notes: [note(1, 'a-note', 'Account A')], reminders: [], attachments: [], cursor: 9, serverTime: Date.now() });
    await pending;

    expect(await store.listNotes(first)).toEqual([]);
    expect(await store.listNotes(second)).toEqual([]);
    expect((await store.getSyncState(second)).cursor).toBe(0);
  });

  it('does not apply a change page fetched for one profile to another', async () => {
    (service as any).http = { get: () => release };
    const pending = (service as any).pullChanges();
    await new Promise(resolve => setTimeout(resolve, 20));
    switchProfile();
    release.next({
      changes: [{ resourceType: 'note', resourceSyncId: 'a-note', operation: 'upsert', payload: note(1, 'a-note', 'Account A'), sequence: 1 }],
      cursor: 4, hasMore: false, serverTime: Date.now()
    });
    await pending;

    expect(await store.listNotes(second)).toEqual([]);
    expect((await store.getSyncState(second)).cursor).toBe(0);
    expect((await store.getSyncState(first)).cursor).toBe(0);
  });

  it('retires acknowledged operations of the old profile but writes nothing else for it after a switch', async () => {
    await store.replaceSnapshot(first, [note(1, 'a-note', 'Original')], [], [], 3, Date.now());
    const { entry } = await store.persistNoteMutation(first, note(1, 'a-note', 'Edited'), store.nextStamp());
    (service as any).http = {
      get: () => of({ noteRevisions: true }),
      post: () => release
    };
    const cacheChanges: unknown[] = [];
    (service as any).cacheChanged$.subscribe((change: unknown) => cacheChanges.push(change));

    const pending = (service as any).flushMutations(await store.listOutbox(first));
    await new Promise(resolve => setTimeout(resolve, 20));
    switchProfile();
    release.next({ results: [{ ok: true, resourceType: 'note', syncId: 'a-note', payload: { ...note(1, 'a-note', 'Edited'), revision: 2 } }], serverTime: Date.now() });
    await pending;

    expect(await store.listOutbox(first)).toEqual([]);
    expect(cacheChanges).toEqual([]);
    expect(await store.listOutbox(second)).toEqual([]);
    expect(entry.partition).toBe(first);
  });
});

describe('Signing out with undelivered work', () => {
  let store: OfflineStoreService;
  let user$: BehaviorSubject<{ id: number } | null>;
  let partition: string;
  let userId: number;

  function startService() {
    // `auth.currentUser` stays unset so no network cycle starts; only the sign-out policy is exercised.
    return new OfflineSyncService(
      { get: () => of({}), post: () => of({}) } as any,
      { currentUser$: user$, currentUser: null, authHeaders: () => ({}) } as any,
      store,
      { run: (fn: () => void) => fn() } as any
    );
  }

  beforeEach(() => {
    store = new OfflineStoreService();
    userId = 910000 + Math.floor(Math.random() * 80000);
    partition = store.partition(userId);
    user$ = new BehaviorSubject<{ id: number } | null>({ id: userId });
  });
  afterEach(async () => store.purgePartition(partition));

  const settle = () => new Promise(resolve => setTimeout(resolve, 150));

  it('keeps the profile when operations were never delivered, then purges it once nothing is pending', async () => {
    startService();
    await store.replaceSnapshot(partition, [note(1, 'n1', 'Cached')], [], [], 2, Date.now());
    const { entry } = await store.persistNoteMutation(partition, note(1, 'n1', 'Unsent edit'), store.nextStamp());

    user$.next(null);
    await settle();
    expect((await store.listOutbox(partition)).map(item => item.operationId)).toEqual([entry.operationId]);
    expect((await store.getNoteBySyncId(partition, 'n1'))?.noteTitle).toBe('Unsent edit');

    await store.removeOutbox([entry.key]);
    user$.next({ id: userId });
    user$.next(null);
    await settle();
    expect(await store.listNotes(partition)).toEqual([]);
  });

  it('keeps the profile when a draft has unsaved changes', async () => {
    startService();
    await store.replaceSnapshot(partition, [note(1, 'n1', 'Cached')], [], [], 2, Date.now());
    await store.putEditorSession({
      key: `${partition}|n1`, partition, sessionKey: 'n1', base: null, draft: { noteTitle: 'Draft' } as any,
      dirtyFields: ['noteTitle'], generation: 1, savedGeneration: 0, localState: 'dirty', remoteState: 'none', updatedAt: 1
    });

    user$.next(null);
    await settle();

    expect((await store.listEditorSessions(partition)).length).toBe(1);
    expect(await store.listNotes(partition)).toHaveSize(1);
  });
});
