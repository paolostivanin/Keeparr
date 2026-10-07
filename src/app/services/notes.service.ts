import { Injectable } from '@angular/core';
import { editorSessionKey, type EditorSessionRecord, type EditorSessionStorage } from '../utils/editor-session';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { BehaviorSubject, firstValueFrom, Subscription } from 'rxjs';

export interface LinkPreviewData {
  title: string;
  description: string | null;
  image: string | null;
  url: string;
  domain: string;
}

export interface TakeoutImportResult {
  imported: number;
  skipped: number;
  deduped?: number;
  errors: number;
  pinnedCount?: number;
  total: number;
  fieldPresence?: Record<string, number>;
}

interface NotesCardPage {
  notes: NoteI[];
  nextCursor: string | null;
}
interface NotesLoadOptions {
  cacheBust?: boolean;
}
type KeptDownloadsPlugin = {
  saveFile: (options: { filename: string; mimeType: string; base64Data: string }) => Promise<void>;
};
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI, UpdateKeyI } from './../interfaces/notes';
import { AuthService } from './auth.service';
import { ShareUserI } from '../interfaces/users';
import { ReminderService } from './reminder.service';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';
import { UserPreferencesService } from './user-preferences.service';
import { NotesStoreService } from './notes-store.service';
import { withPresence } from '../utils/note-presence';

const KeptDownloads = registerPlugin<KeptDownloadsPlugin>('KeptDownloads');

export class LocalNotePersistenceError extends Error {
  constructor(readonly originalError: unknown) {
    super('The note could not be saved on this device.');
    this.name = 'LocalNotePersistenceError';
  }
}

/** A command needs the complete note but only a truncated card preview is available. */
export class NoteIncompleteError extends Error {
  constructor() {
    super('The complete note is not available.');
    this.name = 'NoteIncompleteError';
  }
}

@Injectable({
  providedIn: 'root'
})
export class NotesService {
  private readonly apiUrl = `${environment.apiUrl}/notes`;
  private readonly noteWriteTimeoutMs = 5500;
  private readonly mediaUploadTimeoutMs = 12000;
  readonly notesList$: BehaviorSubject<NoteI[] | null>;
  activeEditors$ = new BehaviorSubject<{noteId: number, editors: any[]} | null>(null);
  private realtimeSocket?: WebSocket;
  private realtimeReconnect?: ReturnType<typeof setTimeout>;
  private readonly authSubscription: Subscription;
  private isLoading = false;
  private isLoadingNextPage = false;
  loading = false;
  hasLoaded = false;
  loadError = false;
  private nextCursor: string | null = null;
  private searchQuery = '';
  private searchReloadTimer?: ReturnType<typeof setTimeout>;
  private pendingLoadQuery?: string;
  private pendingLoadWaiters: Array<() => void> = [];
  private readonly cardPageSize = 80;
  private shouldReconnectRealtime = false;
  private preloadedPreviewUrls = new Set<string>();
  private previewPreloadQueue: string[] = [];
  private previewPreloadRunning = false;
  private suppressedRealtimeReloads = new Map<number, number>();
  private suppressedRealtimeCreates = new Map<string, number>();
  private suppressNextReorderReloadUntil = 0;
  private optimisticNotes = new Map<number, NoteI>();
  private lastNonEmptyNotes: NoteI[] = [];
  private iosReminderRefreshTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private reminders: ReminderService,
    private offlineStore: OfflineStoreService,
    private offlineSync: OfflineSyncService,
    private preferences: UserPreferencesService,
    private notesStore: NotesStoreService
  ) {
    this.notesList$ = this.notesStore.notes$;
    this.offlineSync.cacheChanged$.subscribe(change => {
      const changedNotes = change.noteSyncIds || [];
      const removedNotes = change.removedNoteSyncIds || [];
      if (change.fullSnapshot || ((change.notesChanged || change.attachmentsChanged) && !changedNotes.length && !removedNotes.length)) {
        this.publishCachedNotes(this.searchQuery).catch(console.error);
      } else if (changedNotes.length || removedNotes.length) {
        this.publishChangedCachedNotes(changedNotes, removedNotes).catch(console.error);
      }
    });
    this.authSubscription = this.auth.currentUser$.subscribe(user => {
      this.disconnectRealtime();
      if (user?.token) {
        this.connectRealtime(user.token);
        this.publishCachedNotes(this.searchQuery).catch(console.error);
      } else {
        if (this.iosReminderRefreshTimer) clearTimeout(this.iosReminderRefreshTimer);
        this.iosReminderRefreshTimer = undefined;
        this.loading = false;
        this.hasLoaded = false;
        this.loadError = false;
        this.nextCursor = null;
        this.lastNonEmptyNotes = [];
        this.notesStore.clear();
      }
    });
  }

  async load(searchQuery = this.searchQuery, options: NotesLoadOptions = {}) {
    if (this.isLoading) {
      this.pendingLoadQuery = searchQuery;
      return new Promise<void>(resolve => this.pendingLoadWaiters.push(resolve));
    }
    this.isLoading = true;
    this.loading = true;
    this.loadError = false;
    try {
      if (searchQuery !== this.searchQuery) this.nextCursor = null;
      this.searchQuery = searchQuery;
      await this.publishCachedNotes(searchQuery);
      const requestedQuery = searchQuery;
      const page = await this.loadCardPageWithRetry(requestedQuery, options.cacheBust);
      if (requestedQuery !== this.searchQuery) return;
      this.nextCursor = page.nextCursor;
      this.hasLoaded = true;
      const notes = this.withOptimisticNotes(page.notes);
      this.publishNotes(notes);
      this.queueLinkPreviewPreload(notes);
      notes.forEach(note => this.cacheNoteMedia(note).catch(console.error));
      this.offlineSync.syncNow({ bootstrapIfEmpty: true }).catch(console.error);
    } catch (error) {
      this.loadError = !this.notesList$.value?.length;
      if (navigator.onLine) console.error(error);
    } finally {
      this.isLoading = false;
      this.loading = false;
      if (this.pendingLoadQuery !== undefined) {
        const pending = this.pendingLoadQuery;
        const waiters = this.pendingLoadWaiters.splice(0);
        this.pendingLoadQuery = undefined;
        await this.load(pending, options).catch(console.error);
        waiters.forEach(resolve => resolve());
      }
    }
  }

  private async loadCardPageWithRetry(searchQuery: string, cacheBust = false) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const params: Record<string, string> = { view: 'card', limit: String(this.cardPageSize) };
        if (searchQuery.trim()) params['q'] = searchQuery.trim();
        if (cacheBust) params['_'] = String(Date.now());
        return await firstValueFrom(this.http.get<NotesCardPage>(this.apiUrl, {
          headers: this.auth.authHeaders(),
          params
        }));
      } catch (error) {
        lastError = error;
        if (attempt === 2 || searchQuery !== this.searchQuery) break;
        await this.delay(250 * (attempt + 1));
      }
    }
    throw lastError;
  }

  private delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  setSearchQuery(query: string) {
    const next = query || '';
    if (next === this.searchQuery) return;
    this.searchQuery = next;
    this.nextCursor = null;
    if (this.searchReloadTimer) clearTimeout(this.searchReloadTimer);
    this.searchReloadTimer = setTimeout(() => {
      this.searchReloadTimer = undefined;
      this.load(next).catch(console.error);
    }, 250);
  }

  get hasMoreNotes() {
    return !!this.nextCursor;
  }

  async loadNextPage() {
    if (!navigator.onLine) {
      this.nextCursor = null;
      return;
    }
    if (!this.nextCursor || this.isLoading || this.isLoadingNextPage) return;
    this.isLoadingNextPage = true;
    try {
      const requestedQuery = this.searchQuery;
      const params: Record<string, string> = { view: 'card', limit: String(this.cardPageSize), cursor: this.nextCursor };
      if (this.searchQuery.trim()) params['q'] = this.searchQuery.trim();
      const page = await firstValueFrom(this.http.get<NotesCardPage>(this.apiUrl, {
        headers: this.auth.authHeaders(),
        params
      }));
      if (requestedQuery !== this.searchQuery) return;
      this.nextCursor = page.nextCursor;
      const current = this.notesList$.value || [];
      const seen = new Set(current.map(note => note.id).filter(Boolean));
      const merged = [...current, ...page.notes.filter(note => !note.id || !seen.has(note.id))];
      this.publishNotes(merged);
      this.queueLinkPreviewPreload(page.notes);
    } finally {
      this.isLoadingNextPage = false;
    }
  }

  private connectRealtime(token: string) {
    this.shouldReconnectRealtime = true;
    const url = this.realtimeUrl(token);
    console.log('[Kept WS] connecting to', url.replace(/token=[^&]+/, 'token=***'));
    this.realtimeSocket = new WebSocket(url);
    const socket = this.realtimeSocket;

    this.realtimeSocket.onopen = () => {
      console.log('[Kept WS] connected');
      // Replay any notes we'd previously asked to be present in. This covers
      // (a) joinNote() calls issued while the socket was still handshaking,
      // and (b) reconnects after a server restart or network blip.
      for (const noteId of this.joinedNotes) {
        try {
          this.realtimeSocket!.send(JSON.stringify({ type: 'join-note', noteId }));
        } catch {
          // socket closed mid-replay; the next reconnect will retry.
        }
      }
    };

    this.realtimeSocket.onerror = (event) => {
      console.error('[Kept WS] error', event);
    };

    this.realtimeSocket.onmessage = event => {
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'notes-changed') {
          if (message.action === 'access-revoked') {
            this.removeNoteFromListAndCache(Number(message.noteId), String(message.syncId || '')).catch(console.error);
            this.reminders.load().catch(console.error);
            return;
          }
          if (message.action === 'reordered' && this.suppressNextReorderReloadUntil > Date.now()) {
            this.suppressNextReorderReloadUntil = 0;
            return;
          }
          if (this.shouldSuppressRealtimeCreate(message)) return;
          if (this.consumeSuppressedRealtimeReload(message.noteId)) return;
          this.load();
          this.reminders.load().catch(console.error);
        }
        if (message.type === 'reminder-fired') this.reminders.handleFired(message);
        if (message.type === 'presence-update') this.activeEditors$.next({ noteId: message.noteId, editors: message.activeEditors || [] });
        if (message.type === 'global-presence') this.updateGlobalPresence(message.userId, message.online);
        if (message.type === 'profile-updated') this.updateUserProfile(message.user);
      } catch (error) {
        console.log(error);
      }
    };

    this.realtimeSocket.onclose = (event) => {
      console.warn('[Kept WS] closed', event.code, event.reason);
      if (this.realtimeSocket !== socket) return;
      if (!this.shouldReconnectRealtime || !this.auth.token) return;
      this.realtimeReconnect = setTimeout(() => this.connectRealtime(this.auth.token), 2000);
    };
  }

  private shouldSuppressRealtimeCreate(message: any) {
    if (message?.action !== 'created' || !message.syncId) return false;
    const syncId = String(message.syncId);
    const expiresAt = this.suppressedRealtimeCreates.get(syncId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.suppressedRealtimeCreates.delete(syncId);
      return false;
    }
    return true;
  }

  // Track which notes we've asked the server to count us as "present" in.
  // The set is replayed every time the WS connects (initial connect + every
  // reconnect) so a join issued before the WS finished handshaking, or a
  // server restart that drops the socket, doesn't leave us invisible to
  // collaborators.
  private joinedNotes = new Set<number>();

  joinNote(noteId: number) {
    this.joinedNotes.add(noteId);
    if (this.realtimeSocket?.readyState === WebSocket.OPEN) {
      this.realtimeSocket.send(JSON.stringify({ type: 'join-note', noteId }));
    }
  }

  leaveNote(noteId: number) {
    this.joinedNotes.delete(noteId);
    if (this.realtimeSocket?.readyState === WebSocket.OPEN) {
      this.realtimeSocket.send(JSON.stringify({ type: 'leave-note', noteId }));
    }
  }

  private updateGlobalPresence(userId: number, online: boolean) {
    const notes = this.notesList$.value;
    if (!notes) return;
    // Replace only the notes whose presence changed; everything else keeps its identity.
    const upserts: NoteI[] = [];
    const next = notes.map(note => {
      const updated = withPresence(note, userId, online);
      if (updated !== note) upserts.push(updated);
      return updated;
    });
    if (upserts.length) this.publishNoteDelta(next, upserts);
  }

  /** Publish changed notes without rebuilding the identity indexes or re-deriving reminder lifecycle. */
  private publishNoteDelta(next: NoteI[], upserts: readonly NoteI[]) {
    if (next.length) this.lastNonEmptyNotes = next;
    this.notesStore.publishDelta(next, upserts, []);
  }

  private updateUserProfile(user: ShareUserI) {
    if (!user?.id) return;
    const notes = this.notesList$.value;

    if (notes) {
      const upserts: NoteI[] = [];
      const next = notes.map(note => {
        const { note: updated, changed } = this.noteWithUpdatedUserProfile(note, user);
        if (changed) upserts.push(updated);
        return updated;
      });
      if (upserts.length) this.publishNoteDelta(next, upserts);
    }

    const activeEditors = this.activeEditors$.value;
    if (activeEditors?.editors?.some(editor => editor.id === user.id)) {
      this.activeEditors$.next({
        ...activeEditors,
        editors: activeEditors.editors.map(editor => editor.id === user.id ? {
          ...editor,
          username: user.username,
          displayName: user.displayName,
          avatarDataUrl: user.avatarDataUrl || '',
          avatarPreset: user.avatarPreset || 'cat'
        } : editor)
      });
    }

    this.updateCachedUserProfile(user).catch(console.error);
  }

  private noteWithUpdatedUserProfile(note: NoteI, user: ShareUserI) {
    let changed = false;
    let updated = note;
    const avatarDataUrl = user.id === this.auth.currentUser?.id ? '' : (user.avatarDataUrl || '');
    const avatarPreset = user.avatarPreset || 'cat';

    if (note.ownerUserId === user.id) {
      updated = {
        ...updated,
        ownerDisplayName: user.displayName,
        ownerUsername: user.username,
        ownerAvatarDataUrl: avatarDataUrl,
        ownerAvatarPreset: avatarPreset
      };
      changed = true;
    }

    if (note.collaborators?.some(c => c.id === user.id)) {
      updated = {
        ...updated,
        collaborators: note.collaborators.map(c => c.id === user.id ? {
          ...c,
          username: user.username,
          displayName: user.displayName,
          avatarDataUrl,
          avatarPreset
        } : c)
      };
      changed = true;
    }

    return { note: updated, changed };
  }

  private async updateCachedUserProfile(user: ShareUserI) {
    if (!this.offlineSync.partition) return;
    const cached = await this.offlineStore.listNotes(this.offlineSync.partition);
    await Promise.all(cached.map(async note => {
      const result = this.noteWithUpdatedUserProfile(note, user);
      if (result.changed) await this.offlineStore.overwriteNoteMetadata(this.offlineSync.partition, result.note);
    }));
  }

  async deleteImage(note: NoteI, image: any, event?: Event) {
    if (event) event.stopPropagation();
    // Rewrite the complete document, never a truncated preview, and never the card's own object.
    const full = await this.fullDocument(note);
    await this.update({ ...full, images: (full.images || []).filter(img => img.id !== image.id) }, full.id!);
  }

  private disconnectRealtime() {
    this.shouldReconnectRealtime = false;
    if (this.realtimeReconnect) clearTimeout(this.realtimeReconnect);
    this.realtimeSocket?.close();
    this.realtimeSocket = undefined;
  }

  private realtimeUrl(token: string) {
    const encodedToken = encodeURIComponent(token);
    if (environment.apiUrl.startsWith('http')) {
      return `${environment.apiUrl.replace(/^http/, 'ws')}/realtime?token=${encodedToken}`;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${environment.apiUrl}/realtime?token=${encodedToken}`;
  }

  async add(noteObj: NoteI) {
    const pendingNote: NoteI = {
      ...noteObj,
      sortOrder: noteObj.sortOrder ?? Date.now()
    };
    this.offlineStore.ensureNoteIdentity(pendingNote);
    // An authenticated profile always has an offline partition. Persist the
    // note and replay intent there first, even while online, so creation and
    // editing share the same durable local-first close behavior.
    if (this.offlineSync.partition) {
      return this.saveLocalNewNote(pendingNote);
    }
    if (pendingNote.syncId) this.suppressedRealtimeCreates.set(pendingNote.syncId, Date.now() + 5000);
    try {
      const result = await this.withTimeout(
        firstValueFrom(this.http.post<NoteI & { id: number }>(
          this.apiUrl,
          pendingNote,
          { headers: this.auth.authHeaders() }
        )),
        this.noteWriteTimeoutMs
      );
      this.offlineSync.clearConnectionDegraded();
      try {
        const saved = result.sortOrder != null
          ? { ...pendingNote, ...result }
          : await this.get(result.id, { merge: false });
        if (this.offlineSync.partition) await this.offlineStore.putNote(this.offlineSync.partition, saved);
        await this.cacheNoteMedia(saved);
        this.prependNotesIntoList([saved]);
      } catch (hydrateError) {
        console.warn('Created note, but failed to hydrate it locally; reloading notes.', hydrateError);
        this.load(this.searchQuery, { cacheBust: true }).catch(console.error);
      }
      return result.id;
    } catch (error) {
      if (pendingNote.syncId) this.suppressedRealtimeCreates.delete(pendingNote.syncId);
      if (this.auth.notifySessionExpired(error)) {
        console.warn('Note was not saved because the session expired.');
        throw error;
      }
      if (!this.isOfflineError(error) || !this.offlineSync.partition) {
        console.log(error);
        return -1;
      }
      this.offlineSync.markConnectionDegraded();
      return this.saveLocalNewNote(pendingNote);
    }
  }

  private async saveLocalNewNote(pendingNote: NoteI) {
    if (!this.offlineSync.partition || !pendingNote.syncId) return -1;
    let localId = -Date.now();
    while (await this.offlineStore.getNote(this.offlineSync.partition, localId)) localId -= 1;
    const now = new Date().toISOString();
    const localNote: NoteI = { ...pendingNote, id: localId, createdAt: pendingNote.createdAt || now, updatedAt: now };
    const { note } = await this.persistOfflineNote(localNote);
    this.cacheNoteMedia(note).catch(console.error);
    this.prependNotesIntoList([note]);
    return localId;
  }

  async update(object: NoteI, id: number) {
    if (id === -1) return;
    let existing = await this.cachedOrLoadedNote(id);
    if (!existing && object.syncId) {
      existing = this.notesStore.getBySyncId(object.syncId)
        || (this.offlineSync.partition
          ? await this.offlineStore.getNoteBySyncId(this.offlineSync.partition, object.syncId)
          : undefined);
    }
    if (existing?.id != null) id = existing.id;
    const local = { ...existing, ...object, id, isCardPreview: false, updatedAt: new Date().toISOString(), lastEditorUserId: this.auth.currentUser?.id } as NoteI;
    this.offlineStore.ensureNoteIdentity(local);
    if (id < 0 || !navigator.onLine || this.offlineSync.isConnectionDegraded()) {
      const { note: persisted } = await this.persistOfflineNote(local);
      this.cacheNoteMedia(persisted).catch(console.error);
      this.mergeNoteIntoList(persisted);
      await this.refreshLocalReminderContent(persisted);
      return;
    }
    // Commit the document and replayable operation together before reporting a
    // successful close. OfflineSyncService owns the remote write from here, so
    // editor latency no longer depends on the network or a request retry window.
    const { note: persisted } = await this.persistOfflineNote(local);
    this.cacheNoteMedia(persisted).catch(console.error);
    this.mergeNoteIntoList(persisted);
    await this.refreshLocalReminderContent(persisted);
  }

  async updateKey(object: UpdateKeyI, id: number) {
    if (id === -1) return;
    const existing = await this.cachedOrLoadedNote(id);
    // A field patch does not make a truncated preview complete.
    const local = { ...existing, ...object, id, isCardPreview: !!existing?.isCardPreview, updatedAt: new Date().toISOString(), lastEditorUserId: this.auth.currentUser?.id } as NoteI;
    this.offlineStore.ensureNoteIdentity(local);
    if (id < 0) {
      const { note: persisted } = await this.persistOfflineNote(local);
      this.cacheNoteMedia(persisted).catch(console.error);
      this.mergeNoteIntoList(persisted);
      await this.refreshLocalReminderContent(persisted);
      return;
    }
    if (this.offlineSync.partition) {
      const { note: persisted } = await this.persistOfflineNotePatch(local, object);
      this.cacheNoteMedia(persisted).catch(console.error);
      this.mergeNoteIntoList(persisted);
      await this.refreshLocalReminderContent(persisted);
      this.scheduleIosReminderRefresh(id);
      return;
    }
    if (!navigator.onLine) {
      const { note: persisted } = await this.persistOfflineNote(local);
      this.cacheNoteMedia(persisted).catch(console.error);
      this.mergeNoteIntoList(persisted);
      await this.refreshLocalReminderContent(persisted);
      return;
    }
    await this.persistCachedNote(local);
    await this.cacheNoteMedia(local);
    this.mergeNoteIntoList(local);
    await this.refreshLocalReminderContent(local);
    this.suppressRealtimeReload(id);
    try {
      await this.noteWriteWithRetry(
        () => this.withTimeout(
          firstValueFrom(this.http.patch(`${this.apiUrl}/${id}`, object, { headers: this.auth.authHeaders() })),
          this.noteWriteTimeoutMs
        ),
        `update note fields ${id}`
      );
      this.offlineSync.clearConnectionDegraded();
      this.mergeNoteIntoList({ ...object, id } as NoteI);
      this.scheduleIosReminderRefresh(id);
    } catch (error) {
      this.suppressedRealtimeReloads.delete(id);
      if (this.auth.notifySessionExpired(error)) throw error;
      if (this.isOfflineError(error)) {
        this.offlineSync.markConnectionDegraded();
        await this.persistOfflineNote(local);
        return;
      }
      console.log(error);
      await this.load(this.searchQuery, { cacheBust: true }).catch(console.error);
      throw error;
    }
  }

  private async noteWriteWithRetry(write: () => Promise<unknown>, label: string) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await write();
      } catch (error) {
        lastError = error;
        if (attempt === 2 || !this.isRetryableNoteWriteError(error)) break;
        await this.delay(350 * (attempt + 1));
      }
    }
    console.warn(`Failed to ${label} after retries`, lastError);
    throw lastError;
  }

  /** Durable editor-draft storage for the active profile, or undefined before a profile is active. */
  editorSessions() {
    const partition = this.offlineSync.partition;
    if (!partition) return undefined;
    return {
      partition,
      storage: {
        put: (record: EditorSessionRecord) => this.offlineStore.putEditorSession(record),
        delete: (key: string) => this.offlineStore.deleteEditorSession(key)
      } satisfies EditorSessionStorage,
      load: (sessionKey: string) => this.offlineStore.getEditorSession(editorSessionKey(partition, sessionKey))
    };
  }

  private async persistOfflineNote(note: NoteI) {
    try {
      return await this.offlineSync.persistNote(note);
    } catch (error) {
      throw new LocalNotePersistenceError(error);
    }
  }

  private async persistOfflineNotePatch(note: NoteI, patch: UpdateKeyI) {
    try {
      return await this.offlineSync.persistNotePatch(note, patch);
    } catch (error) {
      throw new LocalNotePersistenceError(error);
    }
  }

  private async persistCachedNote(note: NoteI) {
    if (!this.offlineSync.partition) return;
    try {
      await this.offlineStore.putNote(this.offlineSync.partition, note);
    } catch (error) {
      throw new LocalNotePersistenceError(error);
    }
  }

  private async refreshLocalReminderContent(note: NoteI) {
    try {
      await this.reminders.refreshNoteContent(note);
    } catch (error) {
      throw new LocalNotePersistenceError(error);
    }
  }

  private isRetryableNoteWriteError(error: unknown) {
    if (this.isRequestTimeout(error)) return false;
    if (!(error instanceof HttpErrorResponse)) return true;
    return error.status === 0 || error.status === 408 || error.status === 409 || error.status === 429 || error.status >= 500;
  }

  async reorder(ids: number[]) {
    if (!ids.length) return;
    try {
      this.suppressNextReorderReloadUntil = Date.now() + 5000;
      this.reorderLoadedNotes(ids);
      await this.persistLocalOrder(ids);
      if (!navigator.onLine || ids.some(id => id < 0)) {
        await this.queueReorder(ids);
        return;
      }
      await this.withTimeout(
        firstValueFrom(this.http.patch(`${this.apiUrl}/reorder`, { ids }, { headers: this.auth.authHeaders() })),
        this.noteWriteTimeoutMs
      );
      this.offlineSync.clearConnectionDegraded();
    } catch (error) {
      this.suppressNextReorderReloadUntil = 0;
      if (this.isOfflineError(error)) {
        this.offlineSync.markConnectionDegraded();
        await this.queueReorder(ids);
      }
      else console.log(error)
      await this.load();
    }
  }

  private reorderLoadedNotes(ids: number[]) {
    const current = this.notesList$.value;
    if (!current) return;
    const byId = new Map(current.map(note => [note.id, note]));
    const ordered = ids.map(id => byId.get(id)).filter((note): note is NoteI => !!note);
    const orderedIds = new Set(ids);
    const remaining = current.filter(note => !note.id || !orderedIds.has(note.id));
    this.publishNotes([...ordered, ...remaining]);
  }

  async uploadImage(file: File) {
    const formData = new FormData();
    formData.append('image', file);
    if (!navigator.onLine || this.offlineSync.isConnectionDegraded()) {
      return { url: await this.fileToDataUrl(file), name: file.name };
    }
    try {
      const uploaded = await this.withTimeout(
        firstValueFrom(this.http.post<{ url: string, name: string }>(
          `${environment.apiUrl}/uploads/images`,
          formData,
          { headers: this.auth.authHeaders() }
        )),
        this.mediaUploadTimeoutMs
      );
      this.offlineSync.clearConnectionDegraded();
      return uploaded;
    } catch (error) {
      if (!this.isOfflineError(error)) throw error;
      this.offlineSync.markConnectionDegraded();
      return { url: await this.fileToDataUrl(file), name: file.name };
    }
  }

  async uploadAttachment(noteId: number, file: File | Blob, filename?: string) {
    const syncId = `attachment-${crypto.randomUUID()}`;
    const note = await this.cachedOrLoadedNote(noteId);
    const resolvedName = filename || (file instanceof File ? file.name : 'attachment');
    const queueLocalAttachment = async () => {
      if (!this.offlineSync.partition || !note?.syncId) throw new Error('No offline note available for attachment upload.');
      const blobKey = crypto.randomUUID();
      const localAttachment: NoteAttachmentI = {
        id: -Date.now(),
        syncId,
        noteId,
        originalName: resolvedName,
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        uploadedAt: new Date().toISOString()
      };
      const updatedNote = {
        ...note,
        attachments: [localAttachment, ...(note.attachments || [])]
      };
      let persisted: Awaited<ReturnType<OfflineSyncService['persistAttachmentUpload']>>;
      try {
        persisted = await this.offlineSync.persistAttachmentUpload(blobKey, file, localAttachment, updatedNote, {
          noteSyncId: note.syncId,
          filename: resolvedName,
          syncId
        });
      } catch (error) {
        throw new LocalNotePersistenceError(error);
      }
      this.mergeNoteIntoList(persisted.note);
      return persisted.attachment;
    };
    if (this.offlineSync.partition && note?.syncId) {
      return queueLocalAttachment();
    }
    const formData = new FormData();
    formData.append('file', file, resolvedName);
    formData.append('syncId', syncId);
    try {
      const attachment = await this.withTimeout(
        firstValueFrom(this.http.post<NoteAttachmentI>(
          `${environment.apiUrl}/notes/${noteId}/attachments?syncId=${encodeURIComponent(syncId)}`,
          formData,
          { headers: this.auth.authHeaders() }
        )),
        this.mediaUploadTimeoutMs
      );
      this.offlineSync.clearConnectionDegraded();
      if (this.offlineSync.partition) await this.offlineStore.putAttachment(this.offlineSync.partition, attachment);
      return attachment;
    } catch (error) {
      if (!this.isOfflineError(error) || !this.offlineSync.partition || !note?.syncId) throw error;
      this.offlineSync.markConnectionDegraded();
      return queueLocalAttachment();
    }
  }

  async deleteAttachment(noteId: number, attachmentId: number) {
    const note = await this.cachedOrLoadedNote(noteId);
    const attachment = note?.attachments?.find(item => item.id === attachmentId);
    if (attachment?.syncId && note && this.offlineSync.partition) {
      await this.offlineStore.deleteAttachment(this.offlineSync.partition, attachment.syncId);
      await this.offlineStore.putNote(this.offlineSync.partition, {
        ...note,
        attachments: (note.attachments || []).filter(item => item.id !== attachmentId)
      });
      if (await this.offlineStore.cancelPendingAttachmentUpload(this.offlineSync.partition, attachment.syncId)) return;
    }
    if (attachmentId < 0 || !navigator.onLine) {
      if (attachment?.syncId) await this.offlineSync.enqueue('attachment.delete', attachment.syncId, attachment);
      return;
    }
    await firstValueFrom(this.http.delete(
      `${environment.apiUrl}/notes/${noteId}/attachments/${attachmentId}`,
      { headers: this.auth.authHeaders() }
    ));
  }

  async downloadAttachment(attachment: NoteAttachmentI) {
    const blob = await firstValueFrom(this.http.get(`${environment.apiUrl}/attachments/${attachment.id}`, {
      headers: this.auth.authHeaders(),
      responseType: 'blob'
    }));
    const filename = attachment.originalName || 'attachment';
    if (await this.tryNativeDownload(blob, filename, attachment.mimeType)) return;
    this.browserDownloadBlob(blob, filename);
  }

  canUseNativeDownloads() {
    return Capacitor.getPlatform() === 'android';
  }

  async downloadImage(src: string, filename?: string) {
    const imageUrl = this.auth.authenticatedImageUrl(src);
    const response = await fetch(imageUrl);
    if (!response.ok) throw new Error('Could not download image.');
    const blob = await response.blob();
    const resolvedFilename = this.imageDownloadFilename(filename, src, blob.type);
    if (await this.tryNativeDownload(blob, resolvedFilename, blob.type || 'image/png')) return;
    this.browserDownloadBlob(blob, resolvedFilename);
  }

  private async tryNativeDownload(blob: Blob, filename: string, mimeType?: string) {
    if (!this.canUseNativeDownloads()) return false;
    try {
      await KeptDownloads.saveFile({
        filename,
        mimeType: mimeType || blob.type || 'application/octet-stream',
        base64Data: await this.blobToBase64(blob)
      });
      return true;
    } catch (error) {
      console.warn('Native download unavailable; falling back to browser download.', error);
      return false;
    }
  }

  private browserDownloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private blobToBase64(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.includes(',') ? result.split(',')[1] : result);
      };
      reader.readAsDataURL(blob);
    });
  }

  private imageDownloadFilename(filename: string | undefined, src: string, mimeType: string) {
    const clean = String(filename || '').trim();
    if (clean && /\.[a-z0-9]{2,8}$/i.test(clean)) return clean;
    const fromUrl = this.filenameFromUrl(src);
    if (fromUrl) return fromUrl;
    const ext = this.extensionFromMimeType(mimeType);
    return `${clean || 'kept-image'}.${ext}`;
  }

  private filenameFromUrl(src: string) {
    try {
      const url = new URL(src, window.location.origin);
      const filename = decodeURIComponent(url.pathname.split('/').pop() || '').trim();
      return filename && /\.[a-z0-9]{2,8}$/i.test(filename) ? filename : '';
    } catch {
      return '';
    }
  }

  private extensionFromMimeType(mimeType: string) {
    const type = String(mimeType || '').toLowerCase();
    if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
    if (type.includes('webp')) return 'webp';
    if (type.includes('gif')) return 'gif';
    if (type.includes('svg')) return 'svg';
    return 'png';
  }

  async get(id: number, options: { merge?: boolean } = {}) {
    if (id !== -1) {
      if (id < 0 || !navigator.onLine) {
        const cached = this.offlineSync.partition ? await this.offlineStore.getNote(this.offlineSync.partition, id) : undefined;
        if (cached) return cached;
      }
      try {
        const note = await firstValueFrom(this.http.get<NoteI>(`${this.apiUrl}/${id}`, { headers: this.auth.authHeaders() }));
        if (this.offlineSync.partition) await this.offlineStore.putNote(this.offlineSync.partition, note);
        await this.cacheNoteMedia(note);
        await this.reminders.refreshNoteContent(note);
        if (options.merge !== false) this.mergeNoteIntoList(note);
        return note;
      } catch (error) {
        const cached = this.offlineSync.partition ? await this.offlineStore.getNote(this.offlineSync.partition, id) : undefined;
        if (cached) return cached;
        throw error;
      }
    } else return {} as NoteI
  }

  /**
   * The complete document behind a card. Commands that derive a full field
   * (checklist, images, body) from the note must use this: a preview carries
   * truncated content, and writing it back would silently drop the rest.
   */
  async fullDocument(note: NoteI): Promise<NoteI> {
    if (!note.isCardPreview) return note;
    if (!note.id || note.id < 0) throw new NoteIncompleteError();
    let full: NoteI;
    try {
      full = await this.get(note.id, { merge: false });
    } catch {
      throw new NoteIncompleteError();
    }
    if (!full || full.isCardPreview) throw new NoteIncompleteError();
    return full;
  }

  async ensureNotesVisible(ids: number[]) {
    const uniqueIds = [...new Set(ids.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0))];
    if (!uniqueIds.length) return;
    const notes = await Promise.all(uniqueIds.map(id => this.get(id, { merge: false }).catch(error => {
      console.error(error);
      return null;
    })));
    const visibleNotes = notes.filter((note): note is NoteI => !!note?.id);
    visibleNotes.forEach(note => this.optimisticNotes.set(note.id!, note));
    this.prependNotesIntoList(visibleNotes);
  }

  private prependNotesIntoList(notes: NoteI[]) {
    if (!notes.length) return;
    const currentValue = this.notesList$.value || [];
    const current = currentValue.length ? currentValue : this.lastNonEmptyNotes;
    const incomingIds = new Set(notes.map(note => note.id).filter(Boolean));
    const next = [
      ...notes,
      ...current.filter(note => !note.id || !incomingIds.has(note.id))
    ];
    this.publishNotes(next);
    this.queueLinkPreviewPreload(notes);
  }

  private publishNotes(notes: NoteI[]) {
    if (notes.length) this.lastNonEmptyNotes = notes;
    this.reminders.updateNoteLifecycle(notes);
    this.notesStore.publish(notes);
  }

  private withOptimisticNotes(notes: NoteI[]) {
    const merged = notes.map(note => {
      const existing = (note.syncId ? this.notesStore.getBySyncId(note.syncId) : undefined)
        || (note.id != null ? this.notesStore.getByServerId(note.id) : undefined);
      if (!existing || existing.isCardPreview || !note.isCardPreview) return note;
      return {
        ...existing,
        ...note,
        noteBody: existing.noteBody,
        checkBoxes: existing.checkBoxes,
        images: existing.images,
        attachments: existing.attachments,
        collaborators: note.collaborators ?? existing.collaborators,
        isCardPreview: false
      };
    });
    if (!this.optimisticNotes.size) return merged;
    const seen = new Set(merged.map(note => note.id).filter(Boolean));
    for (const id of [...this.optimisticNotes.keys()]) {
      if (seen.has(id)) this.optimisticNotes.delete(id);
    }
    const missing = [...this.optimisticNotes.values()].filter(note => note.id && !seen.has(note.id));
    return missing.length ? [...missing, ...merged] : merged;
  }

  private mergeNoteIntoList(note: NoteI) {
    const current = this.notesList$.value;
    if (!current || !note.id) return;
    const index = this.notesStore.indexOfServerId(note.id);
    if (index < 0) return;
    const existing = current[index];
    const attachments = note.attachments ?? existing.attachments;
    const collaborators = note.collaborators?.length ? note.collaborators : existing.collaborators;
    const next = [...current];
    next[index] = {
      ...existing,
      ...note,
      attachments,
      collaborators,
      hasAttachments: !!(attachments?.length || existing.hasAttachments),
      attachmentCount: attachments?.length ?? existing.attachmentCount,
      searchText: existing.searchText,
      isCardPreview: note.isCardPreview ?? (note.noteBody !== undefined ? false : existing.isCardPreview)
    };
    this.publishNotes(next);
  }

  private async removeNoteFromListAndCache(noteId: number, syncId = '') {
    const current = this.notesList$.value || [];
    const note = this.notesStore.getByServerId(noteId);
    const noteSyncId = syncId || note?.syncId || '';
    this.reminders.markNoteInactive(noteId);
    this.optimisticNotes.delete(noteId);
    this.joinedNotes.delete(noteId);
    if (noteSyncId && this.offlineSync.partition) {
      await this.offlineStore.deleteNote(this.offlineSync.partition, noteSyncId);
    }
    const next = current.filter(item => item.id !== noteId);
    if (next.length !== current.length) this.publishNotes(next);
    if (this.lastNonEmptyNotes.length) {
      this.lastNonEmptyNotes = this.lastNonEmptyNotes.filter(item => item.id !== noteId);
    }
  }

  private suppressRealtimeReload(noteId: number) {
    this.suppressedRealtimeReloads.set(noteId, Date.now() + 5000);
  }

  private consumeSuppressedRealtimeReload(noteId: number) {
    const id = Number(noteId);
    const expiresAt = this.suppressedRealtimeReloads.get(id);
    if (!expiresAt) return false;
    this.suppressedRealtimeReloads.delete(id);
    return expiresAt > Date.now();
  }

  private scheduleIosReminderRefresh(noteId: number) {
    if (Capacitor.getPlatform() !== 'ios' || !navigator.onLine || !this.reminders.getActiveForNote(noteId)) return;
    if (this.iosReminderRefreshTimer) clearTimeout(this.iosReminderRefreshTimer);
    this.iosReminderRefreshTimer = setTimeout(() => {
      this.iosReminderRefreshTimer = undefined;
      this.reminders.load().catch(console.error);
    }, 500);
  }

  async getAll() {
    try {
      const notes = await firstValueFrom(this.http.get<NoteI[]>(this.apiUrl, { headers: this.auth.authHeaders() }));
      if (this.offlineSync.partition) {
        for (const note of notes) {
          await this.offlineStore.putNote(this.offlineSync.partition, note);
          await this.cacheNoteMedia(note);
        }
      }
      return notes;
    } catch (error) {
      if (this.offlineSync.partition) return this.offlineStore.listNotes(this.offlineSync.partition);
      throw error;
    }
  }

  async listShareUsers() {
    return await firstValueFrom(this.http.get<ShareUserI[]>(`${environment.apiUrl}/sharing/users`, { headers: this.auth.authHeaders() }));
  }

  async getCollaborators(id: number) {
    if (id !== -1) {
      return await firstValueFrom(this.http.get<ShareUserI[]>(`${this.apiUrl}/${id}/collaborators`, { headers: this.auth.authHeaders() }));
    } else return []
  }

  async rejoin(noteId: number, userId: number) {
    await firstValueFrom(this.http.post(`${this.apiUrl}/${noteId}/collaborators/rejoin`, { userId }, { headers: this.auth.authHeaders() }));
    this.load();
  }

  async updateCollaborators(id: number, userIds: number[]) {
    if (id !== -1) {
      const users = await firstValueFrom(this.http.put<ShareUserI[]>(
        `${this.apiUrl}/${id}/collaborators`,
        { userIds },
        { headers: this.auth.authHeaders() }
      ));
      this.mergeCollaboratorsIntoList(id, users);
      this.load().catch(console.error);
      return users;
    } else return []
  }

  async updateViewState(id: number, state: { completedChecklistCollapsed?: boolean }) {
    if (id < 0 || !navigator.onLine) return
    await firstValueFrom(this.http.patch(
      `${this.apiUrl}/${id}/view-state`,
      state,
      { headers: this.auth.authHeaders() }
    ));
  }

  private mergeCollaboratorsIntoList(id: number, collaborators: ShareUserI[]) {
    const current = this.notesList$.value;
    if (!current) return;
    const index = this.notesStore.indexOfServerId(id);
    if (index < 0) return;
    const next = [...current];
    next[index] = { ...next[index], collaborators };
    this.publishNotes(next);
  }

  async clone(id: number) {
    if (id === -1) return;
    if (this.offlineSync.partition) {
      const loaded = await this.cachedOrLoadedNote(id);
      const source = loaded?.isCardPreview && id > 0
        ? await this.get(id, { merge: false })
        : loaded;
      if (!source || source.isCardPreview) throw new Error('The complete note is not available to clone.');
      const user = this.auth.currentUser;
      const now = new Date().toISOString();
      const cloned: NoteI = {
        ...source,
        id: undefined,
        syncId: `note-${crypto.randomUUID()}`,
        revision: undefined,
        ownerUserId: user?.id,
        ownerDisplayName: user?.displayName,
        ownerUsername: user?.username,
        ownerAvatarDataUrl: user?.avatarDataUrl || '',
        ownerAvatarPreset: user?.avatarPreset || 'cat',
        collaborators: [],
        attachments: [],
        hasAttachments: false,
        attachmentCount: 0,
        completedChecklistCollapsed: false,
        createdAt: now,
        updatedAt: now,
        trashedAt: source.trashed ? now : undefined,
        sortOrder: Date.now(),
        lastEditorUserId: user?.id,
        lastEditorDisplayName: user?.displayName,
        isCardPreview: false,
        lwwPhysicalMs: undefined,
        lwwLogical: undefined,
        lwwDeviceId: undefined,
        lwwOperationId: undefined
      };
      await this.add(cloned);
      return;
    }
    try {
      await firstValueFrom(this.http.post(`${this.apiUrl}/${id}/clone`, {}, { headers: this.auth.authHeaders() }));
      await this.load();
    } catch (error) {
      console.log(error);
    }
  }

  async merge(orderedIds: number[]): Promise<number | null> {
    if (orderedIds.length < 2) return null;
    if (this.offlineSync.partition) {
      const sourceNotes = await Promise.all(orderedIds.map(async id => {
        const cached = await this.cachedOrLoadedNote(id);
        const complete = cached?.isCardPreview && id > 0
          ? await this.get(id, { merge: false })
          : cached;
        if (!complete || complete.isCardPreview) throw new Error('Complete source notes are required to merge notes.');
        return complete;
      }));
      const user = this.auth.currentUser;
      if (user?.id == null) throw new Error('An authenticated profile is required to merge notes.');
      if (sourceNotes.some(note => note.ownerUserId != null && note.ownerUserId !== user.id)) {
        throw new Error('You can only merge notes you own.');
      }
      const localId = await this.availableLocalNoteId();
      const mergedNote = this.buildMergedNote(sourceNotes, localId, `note-${crypto.randomUUID()}`, user);
      await this.offlineSync.persistNoteMerge(mergedNote, sourceNotes);
      await this.publishCachedNotes(this.searchQuery);
      return localId;
    }
    try {
      const result = await firstValueFrom(
        this.http.post<{ id: number }>(`${this.apiUrl}/merge`, { orderedIds }, { headers: this.auth.authHeaders() })
      );
      await Promise.all([
        this.load(),
        this.reminders.load()
      ]);
      return result?.id ?? null;
    } catch (error: any) {
      console.log(error);
      throw error;
    }
  }

  private async availableLocalNoteId() {
    let id = -Date.now();
    if (!this.offlineSync.partition) return id;
    while (await this.offlineStore.getNote(this.offlineSync.partition, id)) id -= 1;
    return id;
  }

  private buildMergedNote(sourceNotes: NoteI[], id: number, syncId: string, user: NonNullable<AuthService['currentUser']>): NoteI {
    const title = sourceNotes.find(note => note.noteTitle && note.noteTitle.trim())?.noteTitle || '';
    const bgColor = sourceNotes.find(note => note.bgColor)?.bgColor || '';
    const bgImage = sourceNotes.find(note => note.bgImage && note.bgImage !== 'url("")' && note.bgImage !== 'url()')?.bgImage || '';
    const bodyParts: string[] = [];
    const checkBoxes: NonNullable<NoteI['checkBoxes']> = [];
    const images: NonNullable<NoteI['images']> = [];
    const labels = new Map<number, NoteI['labels'][number]>();
    const knownFields = new Set([
      'id', 'syncId', 'revision', 'ownerUserId', 'noteTitle', 'noteBody', 'pinned', 'bgColor', 'bgImage',
      'checkBoxes', 'images', 'attachments', 'isCbox', 'labels', 'binder', 'locked', 'lockSalt', 'lockHash',
      'completedChecklistCollapsed', 'archived', 'trashed', 'trashedAt', 'sortOrder', 'createdAt', 'updatedAt',
      'lwwPhysicalMs', 'lwwLogical', 'lwwDeviceId', 'lwwOperationId', 'collaborators', 'ownerDisplayName',
      'ownerUsername', 'ownerAvatarDataUrl', 'ownerAvatarPreset', 'lastEditorUserId', 'lastEditorDisplayName',
      'isDemo', 'extraFields', 'ownerOnline', 'searchText', 'previewText', 'linkCount', 'nextCursor', 'isCardPreview',
      'hasMoreImages', 'hasAttachments', 'attachmentCount'
    ]);
    const extraFields: Record<string, unknown> = {};
    for (const source of sourceNotes) {
      if (source.noteBody?.trim()) bodyParts.push(source.noteBody);
      checkBoxes.push(...(source.checkBoxes || []));
      for (const image of source.images || []) {
        images.push(image.id === 'drawing'
          ? { ...image, id: `drawing-flat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: (image.name || '').replace(/^Drawing\|/, '') }
          : image);
      }
      for (const label of source.labels || []) {
        if (label.added && label.id && !labels.has(label.id)) labels.set(label.id, label);
      }
    }
    for (const source of [...sourceNotes].reverse()) {
      for (const [key, value] of Object.entries(source)) {
        if (!knownFields.has(key)) extraFields[key] = value;
      }
    }
    const lock = sourceNotes.find(note => note.locked && note.lockSalt && note.lockHash);
    const now = new Date().toISOString();
    return {
      ...extraFields,
      id,
      syncId,
      noteTitle: title,
      noteBody: bodyParts.join('<br><br>'),
      pinned: false,
      bgColor,
      bgImage,
      checkBoxes,
      images,
      attachments: [],
      isCbox: checkBoxes.length > 0,
      labels: [...labels.values()],
      binder: sourceNotes.find(note => note.binder)?.binder || '',
      locked: !!lock,
      lockSalt: lock?.lockSalt || '',
      lockHash: lock?.lockHash || '',
      completedChecklistCollapsed: false,
      archived: false,
      trashed: false,
      createdAt: now,
      updatedAt: now,
      sortOrder: Date.now(),
      ownerUserId: user.id,
      ownerDisplayName: user.displayName,
      ownerUsername: user.username,
      ownerAvatarDataUrl: user.avatarDataUrl || '',
      ownerAvatarPreset: user.avatarPreset || 'cat',
      collaborators: [],
      lastEditorUserId: user.id,
      lastEditorDisplayName: user.displayName,
      isDemo: false,
      isCardPreview: false
    };
  }

  private linkPreviewCache = new Map<string, Promise<LinkPreviewData>>();
  private linkPreviewResolved = new Map<string, LinkPreviewData>();
  private linkPreviewRetryAfter = new Map<string, number>();

  getLinkPreview(url: string): Promise<LinkPreviewData> {
    if (!this.preferences.value.richLinkPreviews) {
      return Promise.reject(new Error('Rich link previews are disabled.'));
    }
    const retryAfter = this.linkPreviewRetryAfter.get(url);
    if (retryAfter && Date.now() < retryAfter) {
      return Promise.reject(new Error('Link preview is temporarily unavailable.'));
    }
    if (retryAfter) this.linkPreviewRetryAfter.delete(url);
    if (!this.linkPreviewCache.has(url)) {
      let promise: Promise<LinkPreviewData>;
      promise = firstValueFrom(
        this.http.get<LinkPreviewData>(`${environment.apiUrl}/link-preview`, {
          params: { url },
          headers: this.auth.authHeaders()
        })
      ).then(data => {
        this.linkPreviewResolved.set(url, data);
        this.linkPreviewRetryAfter.delete(url);
        if (this.linkPreviewResolved.size > 300) {
          const oldest = this.linkPreviewResolved.keys().next().value;
          if (oldest) this.linkPreviewResolved.delete(oldest);
        }
        return data;
      }).catch(error => {
        if (this.linkPreviewCache.get(url) === promise) this.linkPreviewCache.delete(url);
        this.linkPreviewRetryAfter.set(url, Date.now() + 30_000);
        this.preloadedPreviewUrls.delete(url);
        throw error;
      });
      this.linkPreviewCache.set(url, promise);
    }
    return this.linkPreviewCache.get(url)!;
  }

  // Synchronous lookup used by LinkPreviewComponent so it can skip rendering
  // a loading skeleton when a preview was already preloaded.
  peekLinkPreviewCache(url: string): LinkPreviewData | null {
    return this.linkPreviewResolved.get(url) || null;
  }

  private queueLinkPreviewPreload(notes: NoteI[]) {
    if (!this.preferences.value.richLinkPreviews) return;
    // The first rendered chunk is the most likely next viewport. Preload only
    // a bounded subset here; IntersectionObserver handles links farther down
    // the grid as the user scrolls toward them.
    const seen = new Set<string>();
    const urls: string[] = [];
    notes.slice(0, 24).forEach(note => {
      for (const url of this.noteUrls(note).slice(0, 2)) {
        if (seen.has(url) || this.preloadedPreviewUrls.has(url)) continue;
        seen.add(url);
        urls.push(url);
      }
    });
    if (!urls.length) return;
    urls.forEach(url => this.preloadedPreviewUrls.add(url));
    this.previewPreloadQueue.push(...urls);
    if (this.previewPreloadRunning) return;
    this.previewPreloadRunning = true;
    // Kick off immediately — no 250ms delay. The frontend has already
    // painted whatever it can without these previews; getting them back
    // ASAP just lets the cards fill in faster.
    queueMicrotask(() => this.preloadLinkPreviews());
  }

  private async preloadLinkPreviews() {
    // Run a small pool of fetches in parallel. The browser caps connections
    // per origin, so 6 is a safe sweet spot — enough to keep the pipeline
    // full without exhausting the server thread on cold-cache scrapes.
    const concurrency = 6;
    const workers: Promise<void>[] = [];
    const next = async () => {
      while (this.previewPreloadQueue.length) {
        const url = this.previewPreloadQueue.shift()!;
        await this.getLinkPreview(url).catch(() => undefined);
      }
    };
    try {
      for (let i = 0; i < concurrency; i++) workers.push(next());
      await Promise.all(workers);
    } finally {
      this.previewPreloadRunning = false;
    }
  }

  private noteUrls(note: NoteI) {
    const plainBody = String(note.noteBody || '').replace(/<[^>]+>/g, ' ');
    const matches = plainBody.match(/https?:\/\/[^\s"'<>]+/g) || [];
    return [...new Set(matches)].slice(0, 3);
  }

  async importGoogleTakeout(file: File): Promise<TakeoutImportResult> {
    const formData = new FormData();
    formData.append('takeout', file);
    const result = await firstValueFrom(
      this.http.post<TakeoutImportResult>(`${environment.apiUrl}/import/google-takeout`, formData, {
        headers: this.auth.authHeaders()
      })
    );
    await this.load();
    return result;
  }

  async delete(id: number) {
    if (id !== -1) {
      const note = await this.cachedOrLoadedNote(id);
      this.reminders.markNoteInactive(id);
      if (note?.syncId && this.offlineSync.partition) {
        await this.offlineStore.deleteNote(this.offlineSync.partition, note.syncId);
        this.publishNotes((this.notesList$.value || []).filter(item => item.id !== id));
      }
      if (id < 0 || !navigator.onLine) {
        if (note?.syncId) await this.offlineSync.enqueue('note.delete', note.syncId, { id, syncId: note.syncId });
        return;
      }
      try {
        await firstValueFrom(this.http.delete(`${this.apiUrl}/${id}`, { headers: this.auth.authHeaders() }));
        await this.load();
      } catch (error) {
        if (this.isOfflineError(error) && note?.syncId) {
          await this.offlineSync.enqueue('note.delete', note.syncId, { id, syncId: note.syncId });
        } else console.log(error)
      }
    }
  }

  private async publishCachedNotes(searchQuery: string) {
    if (!this.offlineSync.partition) return;
    const cached = await this.offlineStore.listNotes(this.offlineSync.partition);
    const hydrated = await Promise.all(cached.map(note => this.hydrateOfflineNoteMedia(note)));
    hydrated.sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.sortOrder || 0) - Number(a.sortOrder || 0));
    this.hasLoaded = true;
    this.publishNotes(this.withOptimisticNotes(hydrated));
  }

  private async publishChangedCachedNotes(syncIds: readonly string[], removedSyncIds: readonly string[]) {
    if (!this.offlineSync.partition) return;
    const current = this.notesList$.value || this.lastNonEmptyNotes;
    const oldBySyncId = new Map(current.filter(note => note.syncId).map(note => [note.syncId!, note]));
    const removed = new Set(removedSyncIds.filter(syncId => oldBySyncId.has(syncId)));
    let next = current.filter(note => !removed.has(note.syncId || ''));
    const changedNotes: NoteI[] = [];
    for (const syncId of syncIds) {
      const stored = await this.offlineStore.getNoteBySyncId(this.offlineSync.partition, syncId);
      const existingIndex = next.findIndex(note => note.syncId === syncId);
      if (!stored) {
        if (existingIndex < 0) continue;
        removed.add(syncId);
        next.splice(existingIndex, 1);
        continue;
      }
      const hydrated = await this.hydrateOfflineNoteMedia(stored);
      if (existingIndex >= 0) {
        if (JSON.stringify(next[existingIndex]) === JSON.stringify(hydrated)) continue;
        next.splice(existingIndex, 1);
      }
      next.splice(this.sortedNoteInsertionIndex(next, hydrated), 0, hydrated);
      changedNotes.push(hydrated);
    }
    if (!changedNotes.length && !removed.size) return;
    for (const syncId of removed) {
      const noteId = oldBySyncId.get(syncId)?.id;
      if (noteId != null) this.reminders.markNoteInactive(noteId);
    }
    if (next.length) this.lastNonEmptyNotes = next;
    this.reminders.updateNoteLifecycle(changedNotes);
    this.notesStore.publishDelta(next, changedNotes, [...removed]);
    this.queueLinkPreviewPreload(changedNotes);
  }

  private sortedNoteInsertionIndex(notes: NoteI[], note: NoteI) {
    const compare = (left: NoteI, right: NoteI) => Number(right.pinned) - Number(left.pinned)
      || Number(right.sortOrder || 0) - Number(left.sortOrder || 0)
      || Number(right.id || 0) - Number(left.id || 0);
    let low = 0;
    let high = notes.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(note, notes[middle]) < 0) high = middle;
      else low = middle + 1;
    }
    return low;
  }

  private async cachedOrLoadedNote(id: number) {
    const loaded = this.notesStore.getByServerId(id);
    if (loaded && !loaded.isCardPreview) return loaded;
    if (this.offlineSync.partition) {
      const cached = await this.offlineStore.getNote(this.offlineSync.partition, id);
      if (cached) return this.hydrateOfflineNoteMedia(cached);
    }
    if (id > 0 && navigator.onLine) return this.get(id, { merge: false });
    return loaded;
  }

  private async persistLocalOrder(ids: number[]) {
    if (!this.offlineSync.partition) return;
    const current = this.notesList$.value || [];
    const byId = new Map(current.map(note => [note.id, note]));
    const base = Date.now();
    for (let index = 0; index < ids.length; index += 1) {
      const note = byId.get(ids[index]);
      if (!note) continue;
      const updated = { ...note, sortOrder: base + ids.length - index, updatedAt: new Date().toISOString() };
      await this.offlineStore.putNote(this.offlineSync.partition, updated);
    }
  }

  private async queueReorder(ids: number[]) {
    const syncIds = (this.notesList$.value || [])
      .filter(note => ids.includes(note.id || 0) && note.syncId)
      .sort((a, b) => ids.indexOf(a.id!) - ids.indexOf(b.id!))
      .map(note => note.syncId!);
    if (!syncIds.length) return;
    await this.offlineSync.enqueue('note.reorder', `order-${this.auth.currentUser?.id || 0}`, { syncIds });
  }

  private isOfflineError(error: unknown) {
    return !navigator.onLine || this.isRequestTimeout(error) || (error instanceof HttpErrorResponse && error.status === 0);
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error('Request timed out.');
            error.name = 'KeptRequestTimeout';
            reject(error);
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private isRequestTimeout(error: unknown) {
    return error instanceof Error && error.name === 'KeptRequestTimeout';
  }

  private fileToDataUrl(file: File | Blob) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
      reader.readAsDataURL(file);
    });
  }

  private async cacheNoteMedia(note: NoteI) {
    if (!this.offlineSync.partition || !navigator.onLine) return;
    const urls = this.noteImageUrls(note);
    await Promise.all(urls.map(url => this.offlineStore.cacheMedia(
      this.offlineSync.partition,
      this.auth.canonicalImageUrl(url),
      this.auth.authenticatedImageUrl(url)
    )));
  }

  private async hydrateOfflineNoteMedia(note: NoteI) {
    if (!this.offlineSync.partition) return note;
    const replacements = new Map<string, string>();
    for (const url of this.noteImageUrls(note)) {
      const canonical = this.auth.canonicalImageUrl(url);
      const offline = await this.offlineStore.offlineMediaUrl(this.offlineSync.partition, canonical);
      if (offline !== canonical) replacements.set(canonical, offline);
    }
    if (!replacements.size) return note;
    const replace = (value: string) => {
      let next = value || '';
      replacements.forEach((offline, canonical) => {
        next = next.split(canonical).join(offline);
        next = next.split(this.auth.authenticatedImageUrl(canonical)).join(offline);
      });
      return next;
    };
    return {
      ...note,
      noteBody: replace(note.noteBody || ''),
      images: (note.images || []).map(image => ({ ...image, dataUrl: replace(image.dataUrl) }))
    };
  }

  private noteImageUrls(note: NoteI) {
    const urls = new Set((note.images || []).map(image => image.dataUrl).filter(Boolean));
    for (const match of String(note.noteBody || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
      if (match[1]) urls.add(match[1]);
    }
    return [...urls].filter(url => !url.startsWith('data:') && !url.startsWith('blob:'));
  }

  async updateAllLabels(labelId: number, labelValue: string) {
    try {
      await firstValueFrom(this.http.patch(
        `${this.apiUrl}/labels/${labelId}`,
        { name: labelValue },
        { headers: this.auth.authHeaders() }
      ));
      await this.load();
    } catch (error) {
      console.log(error)
    }
  }
}
