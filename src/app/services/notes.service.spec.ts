import { NoteI } from '../interfaces/notes';
import { LocalNotePersistenceError, NoteIncompleteError, NotesService } from './notes.service';
import { of, throwError } from 'rxjs';

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

  it('retains the server pagination cursor when refreshing only the local projection', async () => {
    const service = Object.create(NotesService.prototype) as NotesService;
    Object.assign(service, {
      offlineSync: { partition: 'fixture-partition' },
      offlineStore: { listNotes: jasmine.createSpy('listNotes').and.resolveTo([]) },
      nextCursor: 'server-next-page'
    });
    spyOn(service as any, 'withOptimisticNotes').and.returnValue([]);
    spyOn(service as any, 'publishNotes');

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
