import { NoteI } from '../interfaces/notes';
import { LocalNotePersistenceError, NoteIncompleteError, NotesService } from './notes.service';
import { Observable, Subject, of, throwError } from 'rxjs';
import { RequestGate } from '../utils/request-gate';
import { NotesStoreService } from './notes-store.service';

const note: NoteI = {
  id: 1,
  syncId: 'note-1',
  noteTitle: 'Draft',
  noteBody: '',
  pinned: false,
  bgColor: '',
  bgImage: '',
  isCbox: false,
  labels: [],
  archived: false,
  trashed: false
};

describe('NotesService local persistence errors', () => {
  it('merges a server card preview without discarding a cached full document', () => {
    const full = { ...note, noteBody: '<p>Complete document</p>', checkBoxes: [{ id: 1, done: false, data: 'Full checklist' }], isCardPreview: false };
    const preview = { ...note, noteTitle: 'Updated card title', noteBody: 'Truncated', isCardPreview: true, ownerOnline: true };
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      optimisticNotes: new Map(),
      notesStore: {
        getBySyncId: jasmine.createSpy('getBySyncId').and.returnValue(full),
        getByServerId: jasmine.createSpy('getByServerId').and.returnValue(undefined)
      }
    });

    const [merged] = (service as any).withOptimisticNotes([preview]);

    expect(merged.noteBody).toBe(full.noteBody);
    expect(merged.checkBoxes).toBe(full.checkBoxes);
    expect(merged.noteTitle).toBe(preview.noteTitle);
    expect(merged.ownerOnline).toBeTrue();
    expect(merged.isCardPreview).toBeFalse();
  });

  it('reads labels for the save path from the local copy without a network request', async () => {
    const labels = [{ id: 3, name: 'Local', added: true }];
    const get = jasmine.createSpy('get');
    const getNote = jasmine.createSpy('getNote').and.resolveTo({ ...note, labels });
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, { http: { get }, offlineSync: { partition: 'fixture-partition' }, offlineStore: { getNote } });

    expect(await service.cachedLabels(1)).toBe(labels);
    expect(getNote).toHaveBeenCalledWith('fixture-partition', 1);
    expect(get).not.toHaveBeenCalled();
    getNote.and.resolveTo(undefined);
    expect(await service.cachedLabels(2)).toBeUndefined();
    (service as any).offlineSync = { partition: null };
    expect(await service.cachedLabels(1)).toBeUndefined();
  });

  it('retains the server pagination cursor when refreshing only the local projection', async () => {
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: { partition: 'fixture-partition' },
      offlineStore: { listNotes: jasmine.createSpy('listNotes').and.resolveTo([]) },
      nextCursor: 'server-next-page'
    });
    spyOn(service as any, 'withOptimisticNotes').and.returnValue([]);
    spyOn(service as any, 'publishNotes');
    (service as any).notesList$ = { value: [{ id: 1 }] };
    (service as any).cacheProjectionSerial = 0;

    await (service as any).publishCachedNotes('');

    expect((service as any).nextCursor).toBe('server-next-page');
  });

  it('expires failed link-preview requests and permits retry after the cooldown', async () => {
    const url = 'https://example.test';
    const preview = { title: 'Preview', description: null, image: null, url, domain: 'example.test' };
    const get = jasmine.createSpy('get').and.returnValues(
      throwError(() => new Error('Temporary upstream failure')),
      of(preview)
    );
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      preferences: { value: { richLinkPreviews: true } },
      http: { get },
      auth: { authHeaders: () => ({}) },
      linkPreviewCache: new Map(),
      linkPreviewResolved: new Map(),
      linkPreviewRetryAfter: new Map(),
      preloadedPreviewUrls: new Set([url])
    });

    await expectAsync(service.getLinkPreview(url)).toBeRejected();
    await expectAsync(service.getLinkPreview(url)).toBeRejected();
    expect(get).toHaveBeenCalledTimes(1);
    (service as any).linkPreviewRetryAfter.set(url, Date.now() - 1);
    await expectAsync(service.getLinkPreview(url)).toBeResolvedTo(preview);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('creates online notes in the local outbox before any remote write', async () => {
    spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: { partition: 'fixture-partition' },
      offlineStore: { ensureNoteIdentity: jasmine.createSpy('ensureNoteIdentity') }
    });
    const localCreate = spyOn(service as any, 'saveLocalNewNote').and.resolveTo(-17);
    const remoteWrite = spyOn(service as any, 'withTimeout');

    const id = await service.add({ ...note, id: undefined, syncId: 'new-note', noteTitle: 'New' });

    expect(id).toBe(-17);
    expect(localCreate).toHaveBeenCalledOnceWith(jasmine.objectContaining({ syncId: 'new-note', noteTitle: 'New' }));
    expect(remoteWrite).not.toHaveBeenCalled();
  });

  it('clones a complete note through the durable local-create path with fresh identity and ownership', async () => {
    const source = {
      ...note,
      id: 12,
      noteBody: '<p>Full source body</p>',
      checkBoxes: [{ id: 2, data: 'Keep this checklist', done: false }],
      images: [{ id: 'image-1', dataUrl: 'https://example.test/image.png', name: 'image.png', placement: 'bottom' as const }],
      attachments: [{ id: 4, syncId: 'attachment-4', originalName: 'source.pdf', fileSize: 5, mimeType: 'application/pdf', uploadedAt: '2026-10-07T12:00:00.000Z' }],
      revision: 8,
      ownerUserId: 3,
      collaborators: [{ id: 5, username: 'other', displayName: 'Other', avatarDataUrl: '', avatarPreset: 'cat', shareCount: 1 }],
      completedChecklistCollapsed: true,
      isCardPreview: false,
      futureField: { keep: true }
    } as NoteI;
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: { partition: 'fixture-partition' },
      auth: { currentUser: { id: 7, username: 'current', displayName: 'Current User', avatarDataUrl: '', avatarPreset: 'fox' } },
      http: { post: jasmine.createSpy('post') }
    });
    spyOn(service as any, 'cachedOrLoadedNote').and.resolveTo(source);
    const add = spyOn(service, 'add').and.resolveTo(-24);

    await service.clone(source.id!);

    expect(add).toHaveBeenCalledOnceWith(jasmine.any(Object));
    const clone = add.calls.mostRecent().args[0];
    expect(clone.id).toBeUndefined();
    expect(clone.syncId).toMatch(/^note-/);
    expect(clone.syncId).not.toBe(source.syncId);
    expect(clone.revision).toBeUndefined();
    expect(clone.ownerUserId).toBe(7);
    expect(clone.collaborators).toEqual([]);
    expect(clone.attachments).toEqual([]);
    expect(clone.completedChecklistCollapsed).toBeFalse();
    expect(clone.noteBody).toBe(source.noteBody);
    expect(clone.checkBoxes).toEqual(source.checkBoxes);
    expect(clone.images).toEqual(source.images);
    expect((clone as any).futureField).toEqual({ keep: true });
    expect((service as any).http.post).not.toHaveBeenCalled();
    expect(source.ownerUserId).toBe(3);
  });

  it('merges ordered full notes through the durable merge command', async () => {
    const first = {
      ...note, id: 1, syncId: 'merge-first', ownerUserId: 7, noteTitle: 'First title',
      noteBody: '<p>First body</p>', checkBoxes: [{ id: 1, data: 'First checkbox', done: false }],
      labels: [{ id: 4, name: 'Work', added: true }], futureFirst: 'first'
    } as NoteI;
    const second = {
      ...note, id: 2, syncId: 'merge-second', ownerUserId: 7, noteTitle: 'Second title',
      noteBody: '<p>Second body</p>', checkBoxes: [{ id: 2, data: 'Second checkbox', done: true }],
      labels: [{ id: 4, name: 'Work', added: true }, { id: 5, name: 'Home', added: true }],
      futureSecond: 'second', futureFirst: 'second'
    } as NoteI;
    const persistMerge = jasmine.createSpy('persistNoteMerge').and.resolveTo({});
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: { partition: 'fixture-partition', persistNoteMerge: persistMerge },
      offlineStore: { getNote: jasmine.createSpy('getNote').and.resolveTo(undefined) },
      auth: { currentUser: { id: 7, username: 'current', displayName: 'Current', avatarDataUrl: '', avatarPreset: 'cat' } },
      http: { post: jasmine.createSpy('post') }
    });
    spyOn(service as any, 'cachedOrLoadedNote').and.callFake(async (id: number) => id === 1 ? first : second);
    spyOn(service as any, 'publishCachedNotes').and.resolveTo(undefined);

    const id = await service.merge([1, 2]);

    expect(id).toBeLessThan(0);
    expect(persistMerge).toHaveBeenCalledOnceWith(jasmine.objectContaining({
      id,
      syncId: jasmine.stringMatching(/^note-/),
      noteTitle: 'First title',
      noteBody: '<p>First body</p><br><br><p>Second body</p>',
      checkBoxes: [...(first.checkBoxes || []), ...(second.checkBoxes || [])],
      labels: [{ id: 4, name: 'Work', added: true }, { id: 5, name: 'Home', added: true }],
      futureFirst: 'first',
      futureSecond: 'second',
      ownerUserId: 7
    }), [first, second]);
    expect((service as any).http.post).not.toHaveBeenCalled();
    expect((service as any).publishCachedNotes).toHaveBeenCalled();
  });

  it('commits an online edit through the durable outbox before returning', async () => {
    spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
    const persistNote = jasmine.createSpy('persistNote').and.resolveTo({ note: { ...note, noteTitle: 'Changed' } });
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: {
        partition: 'fixture-partition',
        isConnectionDegraded: () => false,
        persistNote
      },
      offlineStore: { ensureNoteIdentity: jasmine.createSpy('ensureNoteIdentity') },
      auth: { currentUser: { id: 7 } }
    });
    spyOn(service as any, 'cachedOrLoadedNote').and.resolveTo(note);
    spyOn(service as any, 'cacheNoteMedia').and.resolveTo(undefined);
    spyOn(service as any, 'mergeNoteIntoList');
    spyOn(service as any, 'refreshLocalReminderContent').and.resolveTo(undefined);
    const remoteWrite = spyOn(service as any, 'noteWriteWithRetry');

    await service.update({ ...note, noteTitle: 'Changed' }, 1);

    expect(persistNote).toHaveBeenCalledOnceWith(jasmine.objectContaining({
      id: 1,
      syncId: 'note-1',
      noteTitle: 'Changed'
    }));
    expect(remoteWrite).not.toHaveBeenCalled();
    expect((service as any).mergeNoteIntoList).toHaveBeenCalled();
  });

  it('commits online partial-field updates through the durable patch outbox', async () => {
    spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
    const httpPatch = jasmine.createSpy('httpPatch');
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: { partition: 'fixture-partition' },
      offlineStore: { ensureNoteIdentity: jasmine.createSpy('ensureNoteIdentity') },
      auth: { currentUser: { id: 7 } },
      http: { patch: httpPatch }
    });
    spyOn(service as any, 'cachedOrLoadedNote').and.resolveTo({ ...note, noteBody: 'Do not replace this body', revision: 4 });
    const persistPatch = spyOn(service as any, 'persistOfflineNotePatch').and.resolveTo({
      note: { ...note, noteTitle: 'Changed title', noteBody: 'Do not replace this body', revision: 4 }
    });
    spyOn(service as any, 'cacheNoteMedia').and.resolveTo(undefined);
    spyOn(service as any, 'mergeNoteIntoList');
    spyOn(service as any, 'refreshLocalReminderContent').and.resolveTo(undefined);
    spyOn(service as any, 'scheduleIosReminderRefresh');

    await service.updateKey({ noteTitle: 'Changed title' }, 1);

    expect(persistPatch).toHaveBeenCalledOnceWith(jasmine.objectContaining({
      noteTitle: 'Changed title',
      noteBody: 'Do not replace this body',
      revision: 4
    }), { noteTitle: 'Changed title' });
    expect(httpPatch).not.toHaveBeenCalled();
    expect((service as any).mergeNoteIntoList).toHaveBeenCalled();
  });

  it('resolves a stale temporary editor ID by sync identity after server acknowledgement', async () => {
    spyOnProperty(navigator, 'onLine', 'get').and.returnValue(true);
    const acknowledged = { ...note, id: 42, revision: 3 };
    const persistNote = jasmine.createSpy('persistNote').and.resolveTo({ note: acknowledged });
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: { partition: 'fixture-partition', isConnectionDegraded: () => false, persistNote },
      offlineStore: { ensureNoteIdentity: jasmine.createSpy('ensureNoteIdentity'), getNoteBySyncId: jasmine.createSpy('getBySyncId').and.resolveTo(acknowledged) },
      notesStore: { getBySyncId: jasmine.createSpy('getBySyncId').and.returnValue(acknowledged) },
      auth: { currentUser: { id: 7 } }
    });
    spyOn(service as any, 'cachedOrLoadedNote').and.resolveTo(undefined);
    spyOn(service as any, 'cacheNoteMedia').and.resolveTo(undefined);
    spyOn(service as any, 'mergeNoteIntoList');
    spyOn(service as any, 'refreshLocalReminderContent').and.resolveTo(undefined);

    await service.update({ ...note, id: -17, syncId: note.syncId, noteTitle: 'Recovered draft' }, -17);

    expect(persistNote).toHaveBeenCalledOnceWith(jasmine.objectContaining({ id: 42, syncId: note.syncId, noteTitle: 'Recovered draft' }));
  });

  it('distinguishes offline document-and-outbox commit failures', async () => {
    const failure = new DOMException('Storage is full', 'QuotaExceededError');
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: { persistNote: jasmine.createSpy('persistNote').and.rejectWith(failure) }
    });

    let thrown: unknown;
    try {
      await (service as any).persistOfflineNote(note);
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof LocalNotePersistenceError).toBeTrue();
    expect((thrown as LocalNotePersistenceError).originalError).toBe(failure);
  });

  it('distinguishes cached online-edit persistence failures', async () => {
    const failure = new DOMException('Storage is unavailable', 'UnknownError');
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: { partition: 'fixture-partition' },
      offlineStore: { putNote: jasmine.createSpy('putNote').and.rejectWith(failure) }
    });

    let thrown: unknown;
    try {
      await (service as any).persistCachedNote(note);
    } catch (error) {
      thrown = error;
    }

    expect(thrown instanceof LocalNotePersistenceError).toBeTrue();
    expect((thrown as LocalNotePersistenceError).originalError).toBe(failure);
  });
});

describe('NotesService full documents versus previews', () => {
  const preview: NoteI = { ...note, noteBody: 'Truncated…', checkBoxes: [{ id: 1, done: false, data: 'first only' }], isCardPreview: true };

  function service(get: jasmine.Spy) {
    const instance = Object.create(NotesService.prototype) as NotesService;
    (instance as any).get = get;
    return instance;
  }

  it('returns a complete note unchanged without a request', async () => {
    const get = jasmine.createSpy('get');
    const complete = { ...preview, isCardPreview: false };
    expect(await service(get).fullDocument(complete)).toBe(complete);
    expect(get).not.toHaveBeenCalled();
  });

  it('loads the complete document behind a preview', async () => {
    const full = { ...preview, noteBody: 'Everything', checkBoxes: [{ id: 1, done: false, data: 'a' }, { id: 2, done: false, data: 'b' }], isCardPreview: false };
    const get = jasmine.createSpy('get').and.resolveTo(full);
    expect(await service(get).fullDocument(preview)).toBe(full);
    expect(get).toHaveBeenCalledWith(1, { merge: false });
  });

  it('refuses to hand back a preview when the complete note cannot be loaded or is itself truncated', async () => {
    await expectAsync(service(jasmine.createSpy('get').and.rejectWith(new Error('offline'))).fullDocument(preview)).toBeRejectedWithError(NoteIncompleteError);
    await expectAsync(service(jasmine.createSpy('get').and.resolveTo(preview)).fullDocument(preview)).toBeRejectedWithError(NoteIncompleteError);
    await expectAsync(service(jasmine.createSpy('get')).fullDocument({ ...preview, id: -3 })).toBeRejectedWithError(NoteIncompleteError);
  });

  it('keeps a patched preview marked as a preview so truncated content is never treated as complete', async () => {
    const persisted: NoteI[] = [];
    const instance = Object.create(NotesService.prototype) as NotesService;
    Object.assign(instance, {
      auth: { currentUser: { id: 1 } },
      offlineStore: { ensureNoteIdentity: () => undefined },
      offlineSync: { partition: 'p' }
    });
    (instance as any).cachedOrLoadedNote = async () => preview;
    (instance as any).persistOfflineNotePatch = async (value: NoteI) => { persisted.push(value); return { note: value }; };
    (instance as any).cacheNoteMedia = async () => undefined;
    (instance as any).mergeNoteIntoList = () => undefined;
    (instance as any).refreshLocalReminderContent = async () => undefined;
    (instance as any).scheduleIosReminderRefresh = () => undefined;

    await instance.updateKey({ pinned: true }, 1);

    expect(persisted[0].isCardPreview).toBeTrue();
    expect(persisted[0].pinned).toBeTrue();
  });
});

describe('NotesService narrow card updates', () => {
  function collaborating(): NoteI[] {
    return [
      { ...note, id: 1, syncId: 'a', ownerUserId: 5, ownerOnline: false },
      { ...note, id: 2, syncId: 'b', ownerUserId: 9 },
      { ...note, id: 3, syncId: 'c', ownerUserId: 9, collaborators: [{ id: 5, username: 'u', displayName: 'U', avatarDataUrl: '', avatarPreset: 'cat', shareCount: 0, online: false }] }
    ];
  }

  function serviceWith(notes: NoteI[]) {
    const published: Array<{ next: NoteI[]; upserts: readonly NoteI[] }> = [];
    const instance = Object.create(NotesService.prototype) as NotesService;
    Object.assign(instance, {
      notesList$: { value: notes },
      lastNonEmptyNotes: [],
      notesStore: { publishDelta: (next: NoteI[], upserts: readonly NoteI[]) => published.push({ next, upserts }) }
    });
    const publishNotes = spyOn(instance as any, 'publishNotes');
    return { instance, published, publishNotes };
  }

  it('applies a presence change by replacing only the affected notes through a delta publication', () => {
    const notes = collaborating();
    const { instance, published, publishNotes } = serviceWith(notes);

    (instance as any).updateGlobalPresence(5, true);

    expect(publishNotes).not.toHaveBeenCalled();
    expect(published.length).toBe(1);
    const { next, upserts } = published[0];
    expect(upserts.map(item => item.id)).toEqual([1, 3]);
    expect(next[1]).toBe(notes[1]);
    expect(next[0].ownerOnline).toBeTrue();
    expect(notes[0].ownerOnline).toBeFalse();
    expect(notes[2].collaborators![0].online).toBeFalse();
  });

  it('publishes nothing when presence did not change', () => {
    const { instance, published } = serviceWith(collaborating());
    (instance as any).updateGlobalPresence(5, false);
    (instance as any).updateGlobalPresence(77, true);
    expect(published).toEqual([]);
  });

  it('removes an image from a copy of the complete document, never from the card or a preview', async () => {
    const images = [{ id: 'a', dataUrl: 'a', name: 'a', placement: 'top' as const }, { id: 'b', dataUrl: 'b', name: 'b', placement: 'top' as const }];
    const card = { ...note, images: [images[0]], isCardPreview: true, hasMoreImages: true };
    const full = { ...note, images, isCardPreview: false };
    const instance = Object.create(NotesService.prototype) as NotesService;
    const update = jasmine.createSpy('update').and.resolveTo(undefined);
    Object.assign(instance, { update });
    (instance as any).get = async () => full;

    await instance.deleteImage(card, { id: 'a' });

    expect(update).toHaveBeenCalledTimes(1);
    const saved = update.calls.mostRecent().args[0] as NoteI;
    expect(saved.images!.map(image => image.id)).toEqual(['b']);
    expect(full.images.length).toBe(2);
    expect(card.images.length).toBe(1);

    (instance as any).get = async () => { throw new Error('offline'); };
    await expectAsync(instance.deleteImage(card, { id: 'a' })).toBeRejectedWithError(NoteIncompleteError);
    expect(update).toHaveBeenCalledTimes(1);
  });
});

describe('NotesService stale request handling', () => {
  type Pending = { params: Record<string, string>; subject: Subject<unknown>; unsubscribed: boolean };

  function harness() {
    const requests: Pending[] = [];
    const store = new NotesStoreService();
    const published: NoteI[][] = [];
    const instance = Object.create(NotesService.prototype) as NotesService;
    Object.assign(instance, {
      apiUrl: '/api/notes',
      cardPageSize: 80,
      searchQuery: '',
      nextCursor: null,
      isLoading: false,
      isLoadingNextPage: false,
      loading: false,
      loadError: false,
      hasLoaded: false,
      pendingLoadWaiters: [],
      lastNonEmptyNotes: [],
      listGate: new RequestGate(),
      cacheProjectionSerial: 0,
      publicationSerial: 0,
      notesStore: store,
      notesList$: store.notes$,
      auth: { authHeaders: () => ({}) },
      offlineSync: { partition: 'p', syncNow: () => Promise.resolve() },
      http: {
        get: (_url: string, options: { params: Record<string, string> }) => new Observable(subscriber => {
          const subject = new Subject<unknown>();
          const pending: Pending = { params: options.params, subject, unsubscribed: false };
          requests.push(pending);
          const inner = subject.subscribe(subscriber);
          return () => { pending.unsubscribed = true; inner.unsubscribe(); };
        })
      }
    });
    (instance as any).publishCachedNotes = async () => undefined;
    (instance as any).publishNotes = (notes: NoteI[]) => { (instance as any).publicationSerial++; published.push(notes); store.publish(notes); };
    (instance as any).queueLinkPreviewPreload = () => undefined;
    (instance as any).cacheNoteMedia = async () => undefined;
    (instance as any).withOptimisticNotes = (notes: NoteI[]) => notes;
    return { instance, requests, published, store };
  }

  const card = (id: number): NoteI => ({ ...note, id, syncId: `n${id}`, noteTitle: `Note ${id}` });
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));

  it('cancels the request for an old query and never publishes its result when the query changes', async () => {
    const { instance, requests, published } = harness();
    const first = instance.load('alpha');
    await tick();
    expect(requests[0].params['q']).toBe('alpha');

    instance.setSearchQuery('beta');
    await first;
    expect(requests[0].unsubscribed).toBeTrue();
    expect(published).toEqual([]);
    expect((instance as any).loadError).toBeFalse();

    const second = instance.load('beta');
    await tick();
    requests[1].subject.next({ notes: [card(2)], nextCursor: null });
    requests[1].subject.complete();
    await second;
    expect(published.length).toBe(1);
    expect(published[0].map(item => item.id)).toEqual([2]);
  });

  it('supersedes a load in flight when another query is requested, then loads only the newer one', async () => {
    const { instance, requests, published } = harness();
    const first = instance.load('alpha');
    await tick();
    const second = instance.load('beta');
    await tick();
    expect(requests[0].unsubscribed).toBeTrue();
    expect(requests.length).toBe(2);
    expect(requests[1].params['q']).toBe('beta');
    requests[1].subject.next({ notes: [card(7)], nextCursor: 'c1' });
    requests[1].subject.complete();
    await Promise.all([first, second]);
    expect(published.map(list => list.map(item => item.id))).toEqual([[7]]);
    expect((instance as any).nextCursor).toBe('c1');
  });

  it('discards a next page that was requested before a refresh and does not rewind the cursor', async () => {
    const { instance, requests, published } = harness();
    (instance as any).nextCursor = 'old-cursor';
    (instance as any).notesStore.publish([card(1)]);
    const paging = instance.loadNextPage();
    await tick();
    expect(requests[0].params['cursor']).toBe('old-cursor');

    const refresh = instance.load('');
    await tick();
    expect(requests[0].unsubscribed).toBeTrue();
    requests[1].subject.next({ notes: [card(10), card(11)], nextCursor: 'fresh-cursor' });
    requests[1].subject.complete();
    await Promise.all([paging, refresh]);

    expect((instance as any).nextCursor).toBe('fresh-cursor');
    expect(published.map(list => list.map(item => item.id))).toEqual([[10, 11]]);
  });

  it('drops in-flight results for a previous account', async () => {
    const { instance, requests, published } = harness();
    const pending = instance.load('');
    await tick();
    (instance as any).listGate.invalidate();
    await pending;
    expect(requests[0].unsubscribed).toBeTrue();
    expect(published).toEqual([]);
  });

  it('lets only the newest cache projection publish when an older one finishes later', async () => {
    const { instance, published } = harness();
    delete (instance as any).publishCachedNotes;
    const releases: Array<() => void> = [];
    (instance as any).offlineStore = {
      getDisplayWindow: async () => [],
      listNotes: () => new Promise<NoteI[]>(resolve => { releases.push(() => resolve([card(releases.length)])); })
    };
    (instance as any).hydrateOfflineNoteMedia = async (value: NoteI) => value;

    const older = (instance as any).publishCachedNotes('');
    const newer = (instance as any).publishCachedNotes('');
    await tick();
    expect(releases.length).toBe(2);
    releases[1]();
    await newer;
    releases[0]();
    await older;

    expect(published.length).toBe(1);
  });

  it('re-derives a changed-note publication when the list moved on while the cache was read', async () => {
    const { instance, published, store } = harness();
    store.publish([card(1)]);
    const reads: Array<() => void> = [];
    (instance as any).offlineStore = {
      getNoteBySyncId: () => new Promise<NoteI | undefined>(resolve => { reads.push(() => resolve({ ...card(2), noteTitle: 'Changed' })); })
    };
    (instance as any).hydrateOfflineNoteMedia = async (value: NoteI) => value;
    (instance as any).reminders = { markNoteInactive: () => undefined, updateNoteLifecycle: () => undefined };

    const changed = (instance as any).publishChangedCachedNotes(['n2'], []);
    await tick();
    // A page load lands first and replaces the list.
    (instance as any).publishNotes([card(1), card(3)]);
    reads[0]();
    await tick();
    expect(reads.length).toBe(2);
    reads[1]();
    await changed;

    const finalIds = store.value!.map(item => item.id);
    expect(finalIds).toContain(3);
    expect(finalIds).toContain(2);
    expect(published.length).toBe(1); // only the page load went through publishNotes; the change is a delta
  });
});

describe('NotesService cold-start projection', () => {
  const mk = (id: number, title = `Note ${id}`): NoteI => ({ ...note, id, syncId: `n${id}`, noteTitle: title });

  function harness(options: { windowIds: string[]; all: NoteI[]; current?: NoteI[] }) {
    const store = new NotesStoreService();
    if (options.current) store.publish(options.current);
    const published: NoteI[][] = [];
    const instance = Object.create(NotesService.prototype) as NotesService;
    Object.assign(instance, {
      listGate: new RequestGate(), cacheProjectionSerial: 0, publicationSerial: 0, hasLoaded: false,
      notesStore: store, notesList$: store.notes$,
      offlineSync: { partition: 'p' },
      offlineStore: {
        getDisplayWindow: async () => options.windowIds,
        getNotesBySyncIds: async (_p: string, ids: string[]) => ids.flatMap(id => options.all.filter(item => item.syncId === id)),
        listNotes: async () => options.all
      }
    });
    (instance as any).hydrateOfflineNoteMedia = async (value: NoteI) => ({ ...value });
    (instance as any).withOptimisticNotes = (notes: NoteI[]) => notes;
    (instance as any).publishNotes = (notes: NoteI[]) => { published.push(notes); store.publish(notes); };
    return { instance, published, store };
  }

  it('paints the remembered top of the list first, then the complete collection, reusing unchanged note objects', async () => {
    const all = [mk(1), mk(2), mk(3)];
    const { instance, published } = harness({ windowIds: ['n1', 'n2'], all });

    await (instance as any).publishCachedNotes('');

    expect(published.length).toBe(2);
    expect(published[0].map(item => item.id)).toEqual([1, 2]);
    expect(published[1].map(item => item.id)).toEqual([1, 2, 3]);
    expect(published[1][0]).toBe(published[0][0]);
    expect(published[1][1]).toBe(published[0][1]);
  });

  it('publishes the full collection only when nothing is remembered or the list is already populated', async () => {
    const all = [mk(1), mk(2)];
    const none = harness({ windowIds: [], all });
    await (none.instance as any).publishCachedNotes('');
    expect(none.published.length).toBe(1);

    const populated = harness({ windowIds: ['n1'], all, current: [mk(9)] });
    await (populated.instance as any).publishCachedNotes('');
    expect(populated.published.length).toBe(1);
    expect(populated.published[0].map(item => item.id)).toEqual([1, 2]);
  });

  it('does not publish an early window for a profile that is no longer active', async () => {
    const { instance, published } = harness({ windowIds: ['n1'], all: [mk(1)] });
    const pending = (instance as any).publishCachedNotes('');
    (instance as any).offlineSync = { partition: 'someone-else' };
    await pending;
    expect(published).toEqual([]);
  });

  describe('reordering notes', () => {
    const ordered = (id: number, sortOrder: number, extra: Partial<NoteI> = {}): NoteI => ({ ...note, id, syncId: `note-${id}`, sortOrder, ...extra });

    function serviceWith(notes: NoteI[], online: boolean) {
      const service = Object.create(NotesService.prototype) as NotesService;
      const patch = jasmine.createSpy('patch').and.returnValue(of(null));
      const putNote = jasmine.createSpy('putNote').and.resolveTo(undefined);
      const enqueue = jasmine.createSpy('enqueue').and.resolveTo(undefined);
      const publishNotes = jasmine.createSpy('publishNotes');
      Object.assign(service, {
        notesList$: { value: notes },
        apiUrl: '/api/notes',
        noteWriteTimeoutMs: 1000,
        suppressNextReorderReloadUntil: 0,
        http: { patch },
        auth: { authHeaders: () => ({}), currentUser: { id: 7 } },
        offlineStore: { putNote },
        offlineSync: { partition: 'fixture', enqueue, clearConnectionDegraded: jasmine.createSpy('clear'), markConnectionDegraded: jasmine.createSpy('mark') },
        publishNotes
      });
      spyOnProperty(navigator, 'onLine').and.returnValue(online);
      spyOn(service as any, 'withTimeout').and.callFake((promise: Promise<unknown>) => promise);
      return { service, patch, putNote, enqueue, publishNotes };
    }

    it('stores and sends only the note that moved', async () => {
      const notes = [ordered(1, 5000), ordered(2, 4000), ordered(3, 3000), ordered(4, 2000)];
      const { service, patch, putNote, publishNotes } = serviceWith(notes, true);

      await service.reorder([1, 3, 2, 4]);

      expect(putNote).toHaveBeenCalledTimes(1);
      const stored = putNote.calls.mostRecent().args[1] as NoteI;
      expect(stored.id).toBe(3);
      expect(stored.sortOrder).toBeGreaterThan(4000);
      expect(stored.sortOrder).toBeLessThan(5000);
      const body = patch.calls.mostRecent().args[1] as { ids: number[]; positions: Array<{ id: number; sortOrder: number }> };
      expect(body.ids).toEqual([1, 3, 2, 4]);
      expect(body.positions).toEqual([{ id: 3, sortOrder: stored.sortOrder! }]);
      expect((publishNotes.calls.mostRecent().args[0] as NoteI[]).map(item => item.id)).toEqual([1, 3, 2, 4]);
    });

    it('does nothing when the requested order already holds', async () => {
      const notes = [ordered(1, 5000), ordered(2, 4000), ordered(3, 3000)];
      const { service, patch, putNote, enqueue } = serviceWith(notes, true);

      await service.reorder([1, 2, 3]);

      expect(patch).not.toHaveBeenCalled();
      expect(putNote).not.toHaveBeenCalled();
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('queues the whole order for older servers together with the moved positions while offline', async () => {
      const notes = [ordered(1, 5000), ordered(2, 4000), ordered(3, 3000, { pinned: true }), ordered(4, 2000, { pinned: true })];
      const { service, patch, enqueue } = serviceWith(notes, false);

      await service.reorder([3, 4, 2, 1]);

      expect(patch).not.toHaveBeenCalled();
      const [type, syncId, payload] = enqueue.calls.mostRecent().args as [string, string, { syncIds: string[]; positions: Array<{ syncId: string; sortOrder: number }> }];
      expect(type).toBe('note.reorder');
      expect(syncId).toBe('order-7');
      expect(payload.syncIds).toEqual(['note-3', 'note-4', 'note-2', 'note-1']);
      // Pinned notes were already in order; of the other two, note 2 moves above note 1.
      expect(payload.positions).toEqual([{ syncId: 'note-2', sortOrder: 5001 }]);
    });
  });
});
