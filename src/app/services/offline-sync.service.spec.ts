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
  it('serializes outbox flushes with a partition-scoped Web Lock', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
    const request = jasmine.createSpy('request').and.callFake(async (_name: string, _options: unknown, callback: () => Promise<void>) => callback());
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    try {
      const service = Object.create(OfflineSyncService.prototype) as OfflineSyncService;
      Object.assign(service, {
        currentPartition: 'https://server.example.test|17',
        auth: { currentUser: { id: 17 } }
      });
      const run = spyOn(service as any, 'syncCycle').and.resolveTo(undefined);

      await service.syncNow();

      expect(request).toHaveBeenCalledOnceWith(
        'keeparr-offline-sync:https://server.example.test|17',
        { mode: 'exclusive' },
        jasmine.any(Function)
      );
      expect(run).toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'locks', descriptor);
      else delete (navigator as any).locks;
    }
  });

  it('sends the durable outbox operation identity for server receipt replay', async () => {
    const operation = {
      key: 'fixture-partition|operation-1',
      partition: 'fixture-partition',
      operationId: 'operation-1',
      type: 'note.patch' as const,
      syncId: 'note-1',
      payload: { id: 1, patch: { noteTitle: 'Saved' } },
      lww: { physicalMs: 100, logical: 0, deviceId: 'device-1', operationId: 'operation-1' },
      createdAt: 100,
      attempts: 0
    };
    const store = {
      claimOutboxForSend: jasmine.createSpy('claimOutboxForSend').and.resolveTo([operation]),
      removeOutbox: jasmine.createSpy('removeOutbox').and.resolveTo(undefined),
      getSyncState: jasmine.createSpy('getSyncState').and.resolveTo({ cursor: 12, serverOffsetMs: 0 }),
      setSyncState: jasmine.createSpy('setSyncState').and.resolveTo(undefined)
    };
    const service = makeSyncService({}, store);
    const post = jasmine.createSpy('post').and.returnValue(of({ results: [{ ok: true }], serverTime: Date.now() }));
    (service as any).http = { post };

    await (service as any).flushMutations([operation]);

    expect(post.calls.mostRecent().args[1].mutations[0].operationId).toBe('operation-1');
    expect(post.calls.mostRecent().args[1].mutations[0]).toEqual(jasmine.objectContaining({
      type: 'note.patch',
      syncId: 'note-1',
      payload: { id: 1, patch: { noteTitle: 'Saved' } }
    }));
    expect(store.claimOutboxForSend).toHaveBeenCalledWith([operation.key]);
    expect(store.removeOutbox).toHaveBeenCalledWith([operation.key]);
  });

  it('orders merge dependencies so source uploads finish before merge and target work follows it', async () => {
    const entry = (type: string, syncId: string, payload: unknown, createdAt: number) => ({
      key: `fixture-partition|${type}-${createdAt}`,
      partition: 'fixture-partition',
      operationId: `${type}-${createdAt}`,
      type,
      syncId,
      payload,
      lww: { physicalMs: createdAt, logical: 0, deviceId: 'device', operationId: `${type}-${createdAt}` },
      createdAt,
      attempts: 0
    } as any);
    const sourceUpsert = entry('note.upsert', 'source-note', { id: -5 }, 1);
    const sourceReminder = entry('reminder.upsert', 'source-reminder', { noteSyncId: 'source-note' }, 2);
    const sourceUpload = entry('attachment.upload', 'source-file', { noteSyncId: 'source-note' }, 3);
    const merge = entry('note.merge', 'merged-note', {
      mergeSyncId: 'merged-note', orderedSourceSyncIds: ['source-note'], localMergeId: -6
    }, 4);
    const targetDelete = entry('note.delete', 'merged-note', { id: -6 }, 5);
    const targetReminder = entry('reminder.upsert', 'target-reminder', { noteSyncId: 'merged-note', noteId: -6 }, 6);
    const targetUpload = entry('attachment.upload', 'target-file', { noteSyncId: 'merged-note' }, 7);
    const targetAttachmentDelete = entry('attachment.delete', 'target-file-delete', { noteId: -6 }, 8);
    const service = Object.create(OfflineSyncService.prototype) as OfflineSyncService;
    Object.assign(service, {
      currentPartition: 'fixture-partition',
      store: { listOutbox: jasmine.createSpy('listOutbox').and.resolveTo([
        sourceUpsert, sourceReminder, sourceUpload, merge, targetDelete, targetReminder, targetUpload, targetAttachmentDelete
      ]) }
    });
    const sequence: string[] = [];
    spyOn(service as any, 'flushMutations').and.callFake(async (entries: any[]) => {
      sequence.push(`mutations:${entries.map(item => item.type).join(',')}`);
    });
    spyOn(service as any, 'flushAttachmentUploads').and.callFake(async (entries: any[]) => {
      sequence.push(`uploads:${entries.map(item => item.syncId).join(',')}`);
    });
    spyOn(service as any, 'pullChanges').and.callFake(async () => { sequence.push('pull'); });

    await (service as any).flushOutbox();

    expect(sequence).toEqual([
      'mutations:note.upsert,reminder.upsert',
      'pull',
      'uploads:source-file',
      'mutations:note.merge',
      'pull',
      'mutations:note.delete,reminder.upsert,attachment.delete',
      'uploads:target-file'
    ]);
  });

  it('advances an empty changes cursor without publishing cache changes', async () => {
    const cursor = { cursor: 12, serverOffsetMs: 0 };
    const store = {
      getSyncState: jasmine.createSpy('getSyncState').and.resolveTo(cursor),
      applyChangePage: jasmine.createSpy('applyChangePage').and.resolveTo({
        noteSyncIds: [], removedNoteSyncIds: [], reminderSyncIds: [], removedReminderSyncIds: [], attachmentSyncIds: []
      })
    };
    const service = makeSyncService({ changes: [], cursor: 13, hasMore: false, serverTime: Date.now() }, store);
    const notifications: unknown[] = [];
    service.cacheChanged$.subscribe(change => notifications.push(change));

    await (service as any).pullChanges();

    expect(store.applyChangePage).toHaveBeenCalledWith('fixture-partition', [], 13, jasmine.any(Number));
    expect(notifications).toEqual([]);
  });

  it('publishes only the resource family that changed', async () => {
    const note: NoteI = {
      id: 7, syncId: 'note-7', noteTitle: 'Remote title', noteBody: '', pinned: false,
      bgColor: '', bgImage: '', isCbox: false, labels: [], archived: false, trashed: false
    };
    const store = {
      getSyncState: jasmine.createSpy('getSyncState').and.resolveTo({ cursor: 12, serverOffsetMs: 0 }),
      applyChangePage: jasmine.createSpy('applyChangePage').and.resolveTo({
        noteSyncIds: ['note-7'], removedNoteSyncIds: [], reminderSyncIds: [], removedReminderSyncIds: [], attachmentSyncIds: []
      })
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

    expect(store.applyChangePage).toHaveBeenCalledWith('fixture-partition', jasmine.any(Array), 13, jasmine.any(Number));
    expect(notifications).toEqual([{
      notesChanged: true,
      remindersChanged: false,
      attachmentsChanged: false,
      noteSyncIds: ['note-7'],
      removedNoteSyncIds: [],
      reminderSyncIds: [],
      removedReminderSyncIds: [],
      attachmentSyncIds: []
    }]);
  });
});

describe('OfflineSyncService profile isolation', () => {
  it('never saves one account\'s edit into another account\'s partition when the profile changes mid-save', async () => {
    let release!: (value: { serverOffsetMs: number }) => void;
    const persistNoteMutation = jasmine.createSpy('persistNoteMutation');
    const service = Object.create(OfflineSyncService.prototype) as OfflineSyncService;
    Object.assign(service, {
      currentPartition: 'account-A',
      state$: { next: () => undefined },
      store: {
        getSyncState: () => new Promise(resolve => release = resolve),
        nextStamp: () => ({}),
        persistNoteMutation
      }
    });

    const saving = service.persistNote({ syncId: 'private-A', noteBody: 'A private draft' } as NoteI);
    (service as any).currentPartition = 'account-B';
    release({ serverOffsetMs: 0 });

    await expectAsync(saving).toBeRejectedWithError(/profile changed/);
    expect(persistNoteMutation).not.toHaveBeenCalled();
  });
});
