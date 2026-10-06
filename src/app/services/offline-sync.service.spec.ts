import { of, Subject } from 'rxjs';
import { OfflineSyncService } from './offline-sync.service';
import { NoteI } from '../interfaces/notes';

function makeSyncService(response: unknown, store: Record<string, jasmine.Spy>) {
  const service = Object.create(OfflineSyncService.prototype) as OfflineSyncService;
  Object.assign(service, {
    apiUrl: '/api',
    currentPartition: 'fixture-partition',
    syncRequestTimeoutMs: 1000,
    http: { get: jasmine.createSpy('get').and.returnValue(of(response)) },
    auth: { authHeaders: () => ({}) },
    store,
    cacheChanged$: new Subject()
  });
  return service;
}

describe('OfflineSyncService incremental cache changes', () => {
  it('advances an empty changes cursor without publishing cache changes', async () => {
    const cursor = { cursor: 12, serverOffsetMs: 0 };
    const store = {
      getSyncState: jasmine.createSpy('getSyncState').and.resolveTo(cursor),
      setSyncState: jasmine.createSpy('setSyncState').and.resolveTo(undefined)
    };
    const service = makeSyncService({ changes: [], cursor: 13, hasMore: false, serverTime: Date.now() }, store);
    const notifications: unknown[] = [];
    service.cacheChanged$.subscribe(change => notifications.push(change));

    await (service as any).pullChanges();

    expect(store.setSyncState).toHaveBeenCalledWith('fixture-partition', 13, jasmine.any(Number));
    expect(notifications).toEqual([]);
  });

  it('publishes only the resource family that changed', async () => {
    const note: NoteI = {
      id: 7, syncId: 'note-7', noteTitle: 'Remote title', noteBody: '', pinned: false,
      bgColor: '', bgImage: '', isCbox: false, labels: [], archived: false, trashed: false
    };
    const store = {
      getSyncState: jasmine.createSpy('getSyncState').and.resolveTo({ cursor: 12, serverOffsetMs: 0 }),
      setSyncState: jasmine.createSpy('setSyncState').and.resolveTo(undefined),
      getNoteBySyncId: jasmine.createSpy('getNoteBySyncId').and.resolveTo(undefined),
      putNote: jasmine.createSpy('putNote').and.resolveTo(undefined)
    };
    const service = makeSyncService({
      changes: [{ sequence: 13, resourceType: 'note', resourceSyncId: note.syncId, operation: 'upsert', payload: note }],
      cursor: 13,
      hasMore: false,
      serverTime: Date.now()
    }, store);
    const notifications: any[] = [];
    service.cacheChanged$.subscribe(change => notifications.push(change));

    await (service as any).pullChanges();

    expect(store.putNote).toHaveBeenCalledWith('fixture-partition', note);
    expect(notifications).toEqual([{ notesChanged: true, remindersChanged: false, attachmentsChanged: false }]);
  });
});
