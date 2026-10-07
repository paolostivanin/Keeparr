import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, NgZone } from '@angular/core';
import { BehaviorSubject, firstValueFrom, Subject } from 'rxjs';
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import { AuthService } from './auth.service';
import { OfflineResourceChange, OfflineStoreService, OutboxEntry } from './offline-store.service';
import { changedNoteFields, mergeGuardedNote, overlayNoteFields, pickGuardFields } from '../utils/note-merge';

export type OfflineSyncState = 'offline' | 'syncing' | 'saved' | 'error' | 'auth-required';

/** A saved change the server rejected; it stays on this device until the user resolves it. */
export interface SyncAttentionItem {
  key: string;
  syncId: string;
  reason: 'conflict' | 'access-revoked';
  message: string;
  conflictFields: string[];
  noteTitle: string;
  canKeepMine: boolean;
}

export type SyncResolution = 'mine' | 'theirs';

type MutationResult = {
  ok: boolean; syncId?: string; id?: number; skipped?: boolean; error?: string; status?: number;
  resourceType?: string; revision?: number; latest?: NoteI | null; payload?: NoteI | ReminderI | NoteAttachmentI;
};

export interface OfflineCacheChange {
  notesChanged: boolean;
  remindersChanged: boolean;
  attachmentsChanged: boolean;
  noteSyncIds?: readonly string[];
  removedNoteSyncIds?: readonly string[];
  reminderSyncIds?: readonly string[];
  removedReminderSyncIds?: readonly string[];
  attachmentSyncIds?: readonly string[];
  fullSnapshot?: boolean;
}

type SyncSnapshot = {
  notes: NoteI[];
  reminders: ReminderI[];
  attachments: NoteAttachmentI[];
  cursor: number;
  serverTime: number;
};

type SyncChange = OfflineResourceChange & {
  sequence: number;
};

@Injectable({ providedIn: 'root' })
export class OfflineSyncService {
  readonly state$ = new BehaviorSubject<OfflineSyncState>(navigator.onLine ? 'saved' : 'offline');
  readonly cacheChanged$ = new Subject<OfflineCacheChange>();
  readonly attention$ = new BehaviorSubject<SyncAttentionItem[]>([]);
  private guardedNotes?: { partition: string; supported: boolean };
  private readonly apiUrl = environment.apiUrl;
  private readonly syncRequestTimeoutMs = 12000;
  private degradedUntil = 0;
  private degradedRetryTimers: ReturnType<typeof setTimeout>[] = [];
  private running = false;
  private rerun = false;
  private currentPartition = '';
  private readonly repairedPartitions = new Set<string>();

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private store: OfflineStoreService,
    private zone: NgZone
  ) {
    this.auth.currentUser$.subscribe(user => {
      const previous = this.currentPartition;
      this.currentPartition = user?.id ? this.store.partition(user.id) : '';
      this.attention$.next([]);
      this.guardedNotes = undefined;
      if (!user && previous) this.store.purgePartition(previous).catch(console.error);
      if (user) {
        const partition = this.currentPartition;
        if (this.repairedPartitions.has(partition)) {
          this.syncNow({ bootstrapIfEmpty: true }).catch(console.error);
        } else {
          this.store.repairDuplicateNoteIdentities(partition).then(repaired => {
            this.repairedPartitions.add(partition);
            if (repaired) this.cacheChanged$.next({ notesChanged: true, remindersChanged: false, attachmentsChanged: false, fullSnapshot: true });
          }).catch(console.error).finally(() => {
            if (this.currentPartition === partition) this.syncNow({ bootstrapIfEmpty: true }).catch(console.error);
          });
        }
      }
    });
    window.addEventListener('online', () => this.zone.run(() => this.syncNow().catch(console.error)));
    window.addEventListener('offline', () => this.zone.run(() => this.state$.next('offline')));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        this.zone.run(() => this.syncNow().catch(console.error));
      }
    });
  }

  get partition() {
    return this.currentPartition;
  }

  isConnectionDegraded() {
    return Date.now() < this.degradedUntil;
  }

  markConnectionDegraded(durationMs = 10000) {
    this.degradedUntil = Math.max(this.degradedUntil, Date.now() + durationMs);
    this.scheduleDegradedRetries();
  }

  clearConnectionDegraded() {
    this.degradedUntil = 0;
  }

  async enqueue(type: OutboxEntry['type'], syncId: string, payload: unknown) {
    if (!this.currentPartition) throw new Error('No active offline partition.');
    const syncState = await this.store.getSyncState(this.currentPartition);
    const stamp = this.store.nextStamp(syncState.serverOffsetMs);
    await this.store.enqueue(this.currentPartition, type, syncId, payload, stamp);
    this.state$.next(navigator.onLine ? 'syncing' : 'offline');
    if (navigator.onLine) this.syncNow().catch(console.error);
    return stamp;
  }

  async persistNote(note: NoteI) {
    if (!this.currentPartition) throw new Error('No active offline partition.');
    const syncState = await this.store.getSyncState(this.currentPartition);
    const { note: persisted, entry } = await this.store.persistNoteMutation(
      this.currentPartition,
      note,
      this.store.nextStamp(syncState.serverOffsetMs)
    );
    this.state$.next(navigator.onLine ? 'syncing' : 'offline');
    if (navigator.onLine) this.syncNow().catch(console.error);
    return { note: persisted, entry };
  }

  async persistNotePatch(note: NoteI, patch: Partial<NoteI>) {
    if (!this.currentPartition) throw new Error('No active offline partition.');
    const syncState = await this.store.getSyncState(this.currentPartition);
    const result = await this.store.persistNotePatchMutation(
      this.currentPartition,
      note,
      patch,
      this.store.nextStamp(syncState.serverOffsetMs)
    );
    this.state$.next(navigator.onLine ? 'syncing' : 'offline');
    if (navigator.onLine) this.syncNow().catch(console.error);
    return result;
  }

  async persistNoteMerge(note: NoteI, sourceNotes: NoteI[]) {
    const partition = this.currentPartition;
    if (!partition) throw new Error('No active offline partition.');
    const persist = async () => {
      if (this.currentPartition !== partition) throw new Error('The active profile changed before the merge could be saved.');
      const syncState = await this.store.getSyncState(partition);
      return this.store.persistNoteMergeMutation(partition, note, sourceNotes, this.store.nextStamp(syncState.serverOffsetMs));
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    const result = locks
      ? await locks.request(`kept-offline-sync:${partition}`, { mode: 'exclusive' }, persist)
      : await persist();
    this.state$.next(navigator.onLine ? 'syncing' : 'offline');
    this.cacheChanged$.next({ notesChanged: true, remindersChanged: true, attachmentsChanged: true, fullSnapshot: true });
    if (navigator.onLine) this.syncNow().catch(console.error);
    return result;
  }

  async persistAttachmentUpload(
    blobKey: string,
    blob: Blob,
    attachment: NoteAttachmentI,
    note: NoteI,
    payload: { noteSyncId: string; filename: string; syncId: string }
  ) {
    if (!this.currentPartition) throw new Error('No active offline partition.');
    const syncState = await this.store.getSyncState(this.currentPartition);
    const persisted = await this.store.persistAttachmentUpload(
      this.currentPartition,
      blobKey,
      blob,
      attachment,
      note,
      payload,
      this.store.nextStamp(syncState.serverOffsetMs)
    );
    this.state$.next(navigator.onLine ? 'syncing' : 'offline');
    if (navigator.onLine) this.syncNow().catch(console.error);
    return persisted;
  }

  async syncNow(options: { bootstrapIfEmpty?: boolean } = {}) {
    const partition = this.currentPartition;
    if (!this.auth.currentUser || !partition) return;
    const run = () => {
      if (this.currentPartition !== partition) return Promise.resolve();
      return this.syncCycle(options);
    };
    // Web Locks coordinates tabs sharing the same IndexedDB partition. On
    // browsers without it, immutable server operation receipts make replay
    // safe if two tabs race to flush the same outbox entry.
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks) return run();
    return locks.request(`kept-offline-sync:${partition}`, { mode: 'exclusive' }, run);
  }

  private async syncCycle(options: { bootstrapIfEmpty?: boolean } = {}) {
    if (!this.auth.currentUser || !this.currentPartition) return;
    if (!navigator.onLine) {
      this.state$.next('offline');
      return;
    }
    if (this.running) {
      this.rerun = true;
      return;
    }
    this.running = true;
    this.state$.next('syncing');
    try {
      const state = await this.store.getSyncState(this.currentPartition);
      const cachedNotes = options.bootstrapIfEmpty ? await this.store.listNotes(this.currentPartition) : [];
      const pending = await this.store.listOutbox(this.currentPartition);
      if (!pending.length && (state.cursor === 0 || (options.bootstrapIfEmpty && cachedNotes.length === 0))) {
        await this.bootstrap();
      }
      await this.flushOutbox();
      await this.pullChanges();
      // A newly created local note receives its positive server ID while
      // pulling the acknowledgement. Retry dependent uploads once after that
      // remapping so they can proceed in the same sync cycle.
      const pendingUploads = (await this.store.listOutbox(this.currentPartition))
        .filter(entry => entry.type === 'attachment.upload');
      if (pendingUploads.length) await this.flushAttachmentUploads(pendingUploads);
      this.clearConnectionDegraded();
      this.state$.next('saved');
    } catch (error) {
      if (this.isOfflineError(error)) {
        this.markConnectionDegraded();
        this.state$.next('offline');
      } else if (this.auth.isAuthExpiredError(error)) {
        // Pending changes stay durable; syncing resumes after the user signs in again.
        this.state$.next('auth-required');
      } else {
        this.state$.next('error');
        console.error('Offline sync failed', error);
      }
    } finally {
      this.running = false;
      await this.refreshAttention().catch(console.error);
      if (this.rerun) {
        this.rerun = false;
        queueMicrotask(() => this.syncNow().catch(console.error));
      }
    }
  }

  async bootstrap() {
    if (!this.currentPartition) return;
    const snapshot = await this.withTimeout(
      firstValueFrom(this.http.get<SyncSnapshot>(`${this.apiUrl}/sync/bootstrap`, {
        headers: this.auth.authHeaders()
      })),
      this.syncRequestTimeoutMs
    );
    await this.store.replaceSnapshot(
      this.currentPartition,
      snapshot.notes || [],
      snapshot.reminders || [],
      snapshot.attachments || [],
      snapshot.cursor || 0,
      snapshot.serverTime || Date.now()
    );
    await this.cacheSnapshotMedia(snapshot.notes || []);
    this.cacheChanged$.next({ notesChanged: true, remindersChanged: true, attachmentsChanged: true, fullSnapshot: true });
  }

  private async flushOutbox() {
    if (!this.currentPartition) return;
    const entries = await this.store.listOutbox(this.currentPartition);
    if (!entries.length) return;
    const uploads = entries.filter(entry => entry.type === 'attachment.upload');
    const mutations = entries.filter(entry => entry.type !== 'attachment.upload');
    const merges = mutations.filter(entry => entry.type === 'note.merge');
    if (!merges.length) {
      if (mutations.length) await this.flushMutations(mutations);
      if (uploads.length) await this.flushAttachmentUploads(uploads);
      return;
    }

    const mergeSourceSyncIds = new Set<string>();
    const mergeSyncIds = new Set<string>();
    const mergeLocalIds = new Set<number>();
    for (const merge of merges) {
      const payload = merge.payload as { orderedSourceSyncIds?: string[]; mergeSyncId?: string; localMergeId?: number };
      (payload.orderedSourceSyncIds || []).forEach(syncId => mergeSourceSyncIds.add(syncId));
      mergeSyncIds.add(payload.mergeSyncId || merge.syncId);
      if (payload.localMergeId != null) mergeLocalIds.add(payload.localMergeId);
    }
    const isDeferredAfterMerge = (entry: OutboxEntry) => {
      if (entry.type === 'note.delete') return mergeSourceSyncIds.has(entry.syncId) || mergeSyncIds.has(entry.syncId);
      if (entry.type === 'attachment.delete') {
        const payload = entry.payload as { noteId?: number };
        return payload.noteId != null && mergeLocalIds.has(payload.noteId);
      }
      if (!entry.type.startsWith('reminder.')) return false;
      const payload = entry.payload as { noteSyncId?: string; noteId?: number };
      return mergeSyncIds.has(payload.noteSyncId || '') || (payload.noteId != null && mergeLocalIds.has(payload.noteId));
    };
    const deferredMutations = mutations.filter(entry => entry.type !== 'note.merge' && isDeferredAfterMerge(entry));
    const beforeMergeMutations = mutations.filter(entry => entry.type !== 'note.merge' && !isDeferredAfterMerge(entry));
    const sourceUploads = uploads.filter(entry => mergeSourceSyncIds.has(
      String((entry.payload as { noteSyncId?: string }).noteSyncId || '')
    ));
    const afterMergeUploads = uploads.filter(entry => !sourceUploads.includes(entry));

    if (beforeMergeMutations.length) await this.flushMutations(beforeMergeMutations);
    // New local source notes need their accepted positive IDs before dependent
    // attachment uploads can run. The merge remains queued during this pull.
    if (beforeMergeMutations.length || sourceUploads.length) await this.pullChanges();
    if (sourceUploads.length) await this.flushAttachmentUploads(sourceUploads);
    await this.flushMutations(merges);
    // Apply the server's merged ID/resource projections before commands that
    // target the merged note and its newly re-parented attachments.
    await this.pullChanges();
    if (deferredMutations.length) await this.flushMutations(deferredMutations);
    if (afterMergeUploads.length) await this.flushAttachmentUploads(afterMergeUploads);
  }

  /** Negotiated once per profile: older servers keep last-writer-wins full-document saves. */
  private async supportsGuardedNotes() {
    if (this.guardedNotes?.partition === this.currentPartition) return this.guardedNotes.supported;
    let supported = false;
    try {
      const capabilities = await this.withTimeout(
        firstValueFrom(this.http.get<{ noteRevisions?: boolean }>(`${this.apiUrl}/client/capabilities`, { headers: this.auth.authHeaders() })),
        this.syncRequestTimeoutMs
      );
      supported = capabilities?.noteRevisions === true;
    } catch (error) {
      if (!(error instanceof HttpErrorResponse) || ![404, 405].includes(error.status)) throw error;
    }
    this.guardedNotes = { partition: this.currentPartition, supported };
    return supported;
  }

  private async flushMutations(entries: OutboxEntry[], depth = 0): Promise<void> {
    const partition = this.currentPartition;
    if (!partition || !entries.length) return;
    const guardedServer = entries.some(entry => entry.guard) ? await this.supportsGuardedNotes() : false;
    const outboxIds = guardedServer
      ? new Set((await this.store.listOutbox(partition)).map(entry => entry.operationId))
      : new Set<string>();
    // A save that follows a possibly-applied operation waits for its acknowledgement
    // so its base revision is the accepted one rather than a guess.
    const isDeferred = (entry: OutboxEntry) => guardedServer && !!entry.guard?.after && outboxIds.has(entry.guard.after);
    const candidates = entries.filter(entry => !entry.blocked);
    const deferred = candidates.filter(isDeferred);
    const sendable = candidates.filter(entry => !isDeferred(entry));
    if (!sendable.length) return;
    if (guardedServer) {
      // A chained save normally inherits its predecessor's acknowledged revision. If that
      // acknowledgement carried none, the cached revision is the best available base. Either
      // way the base is fixed before the first send so a lost-response replay is byte-identical.
      for (const entry of sendable) {
        if (entry.guard && entry.guard.baseRevision == null && entry.deliveryState !== 'sent') {
          const cached = await this.store.getNoteBySyncId(partition, entry.syncId);
          if (cached?.revision != null) await this.store.setGuardBaseRevision(entry.key, cached.revision);
        }
      }
    }
    const sendEntries = await this.store.claimOutboxForSend(sendable.map(entry => entry.key));
    if (!sendEntries.length) return;
    const response = await this.withTimeout(firstValueFrom(this.http.post<{
      results: MutationResult[];
      serverTime: number;
      snapshot?: SyncSnapshot;
    }>(`${this.apiUrl}/sync/mutations`, {
      includeSnapshot: false,
      mutations: sendEntries.map(entry => ({
        type: entry.type,
        syncId: entry.syncId,
        operationId: entry.operationId,
        payload: entry.payload,
        lww: entry.lww,
        ...(guardedServer && entry.guard?.baseRevision != null ? { baseRevision: entry.guard.baseRevision } : {})
      }))
    }, { headers: this.auth.authHeaders() })), this.syncRequestTimeoutMs);
    const handled = new Set<number>();
    const rebased: OutboxEntry[] = [];
    for (let index = 0; index < sendEntries.length; index++) {
      const entry = sendEntries[index];
      const result = response.results?.[index];
      if (!result || result.ok) continue;
      const outcome = await this.handleRejectedNoteSave(entry, result);
      if (!outcome) continue;
      handled.add(index);
      if (outcome !== 'blocked') rebased.push(outcome);
    }
    const completed = sendEntries.filter((entry, index) => response.results?.[index]?.ok);
    const acknowledged = guardedServer
      ? sendEntries.flatMap((entry, index) => {
        const result = response.results?.[index];
        const revision = (result?.payload as NoteI | undefined)?.revision ?? result?.revision;
        return result?.ok && revision != null ? [{ operationId: entry.operationId, revision }] : [];
      })
      : [];
    await (acknowledged.length
      ? this.store.removeOutbox(completed.map(entry => entry.key), acknowledged)
      : this.store.removeOutbox(completed.map(entry => entry.key)));
    const failed = response.results?.find((result, index) => !result.ok && !handled.has(index));
    if (!failed && response.snapshot) {
      await this.store.replaceSnapshot(
        partition,
        response.snapshot.notes || [],
        response.snapshot.reminders || [],
        response.snapshot.attachments || [],
        response.snapshot.cursor || 0,
        response.snapshot.serverTime || response.serverTime || Date.now()
      );
      await this.cacheSnapshotMedia(response.snapshot.notes || []);
      if (completed.length) this.cacheChanged$.next({ notesChanged: true, remindersChanged: true, attachmentsChanged: true, fullSnapshot: true });
    } else if (response.serverTime) {
      const state = await this.store.getSyncState(partition);
      await this.store.setSyncState(partition, state.cursor, response.serverTime);
    }
    if (failed) throw new Error(failed.error || 'A queued change could not be synchronized.');
    if (handled.size) this.cacheChanged$.next({ notesChanged: true, remindersChanged: false, attachmentsChanged: false, noteSyncIds: sendEntries.filter((_, index) => handled.has(index)).map(entry => entry.syncId) });
    // Continue chains: rebased saves resend at once; deferred ones now carry their
    // predecessor's acknowledged revision as their base.
    if (depth >= 4 || (!rebased.length && !(deferred.length && completed.length))) return;
    const next: OutboxEntry[] = [...rebased];
    for (const entry of deferred) {
      const fresh = await this.store.getOutboxEntry(entry.key);
      if (fresh) next.push(fresh);
    }
    await this.flushMutations(next, depth + 1);
  }

  /**
   * A guarded save the server rejected is not an error to retry: concurrent edits to other
   * fields are merged and resent; true conflicts and revoked access are parked for the user.
   * Returns the rebased entry, 'blocked', or undefined when the rejection is not of that kind.
   */
  private async handleRejectedNoteSave(entry: OutboxEntry, result: MutationResult): Promise<OutboxEntry | 'blocked' | undefined> {
    const partition = this.currentPartition;
    if (entry.type !== 'note.upsert' && entry.type !== 'note.patch') return undefined;
    if (result.status === 403 || result.status === 404) {
      await this.store.blockOutboxEntry(entry.key, {
        reason: 'access-revoked',
        message: result.status === 404 ? 'This note is no longer available.' : 'You no longer have access to this note.',
        at: Date.now()
      });
      return 'blocked';
    }
    if (result.status !== 409 || entry.type !== 'note.upsert' || !entry.guard || result.resourceType !== 'note') return undefined;
    const local = entry.payload as NoteI;
    const latest = result.latest ?? null;
    if (!latest) {
      await this.store.blockOutboxEntry(entry.key, {
        reason: 'conflict', message: 'This note was deleted on another device.', at: Date.now(), latest: null, conflictFields: []
      });
      return 'blocked';
    }
    const { merged, conflicts } = mergeGuardedNote(entry.guard.baseFields, local, latest);
    if (conflicts.length) {
      await this.store.blockOutboxEntry(entry.key, {
        reason: 'conflict',
        message: 'This note was changed on another device.',
        at: Date.now(),
        latest,
        conflictFields: conflicts
      });
      return 'blocked';
    }
    const state = await this.store.getSyncState(partition);
    const { entry: rebased } = await this.store.replaceRejectedNoteUpsert(
      partition, entry.key, merged,
      { baseRevision: latest.revision, baseFields: pickGuardFields(latest) },
      this.store.nextStamp(state.serverOffsetMs)
    );
    return rebased;
  }

  async refreshAttention() {
    const partition = this.currentPartition;
    if (!partition) return;
    const blocked = await this.store.listBlockedOutbox(partition);
    if (this.currentPartition !== partition) return;
    this.attention$.next(blocked.map(entry => ({
      key: entry.key,
      syncId: entry.syncId,
      reason: entry.blocked!.reason,
      message: entry.blocked!.message,
      conflictFields: entry.blocked!.conflictFields || [],
      noteTitle: String((entry.payload as NoteI | undefined)?.noteTitle || '').replace(/<[^>]*>/g, '').trim(),
      canKeepMine: entry.blocked!.reason === 'conflict'
    })));
  }

  /** The document the user saved locally for a parked change, for recovery (e.g. saving a copy). */
  async blockedLocalNote(key: string) {
    const entry = await this.store.getOutboxEntry(key);
    return entry?.blocked ? entry.payload as NoteI : undefined;
  }

  async resolveBlockedNote(key: string, choice: SyncResolution) {
    const partition = this.currentPartition;
    const entry = partition ? await this.store.getOutboxEntry(key) : undefined;
    if (!partition || !entry?.blocked) return;
    const { latest, reason } = entry.blocked;
    if (choice === 'theirs') {
      await this.store.discardPendingNoteUpserts(partition, entry.syncId, latest || undefined);
      if (!latest) await this.store.deleteNote(partition, entry.syncId);
    } else {
      if (reason !== 'conflict') return;
      const local = entry.payload as NoteI;
      const state = await this.store.getSyncState(partition);
      const stamp = this.store.nextStamp(state.serverOffsetMs);
      if (latest && entry.guard) {
        const mine = overlayNoteFields(latest, local, changedNoteFields(entry.guard.baseFields, local));
        await this.store.replaceRejectedNoteUpsert(partition, key, mine, { baseRevision: latest.revision, baseFields: pickGuardFields(latest) }, stamp);
      } else {
        // Deleted elsewhere: recreate it from the local document.
        await this.store.replaceRejectedNoteUpsert(partition, key, { ...local, revision: undefined }, { baseRevision: 0, baseFields: {} }, stamp);
      }
    }
    this.cacheChanged$.next({ notesChanged: true, remindersChanged: false, attachmentsChanged: false, noteSyncIds: [entry.syncId] });
    await this.refreshAttention();
    if (navigator.onLine) this.syncNow().catch(console.error);
  }

  private async flushAttachmentUploads(entries: OutboxEntry[]) {
    if (!this.currentPartition) return;
    for (const queued of entries) {
      const [entry] = await this.store.claimOutboxForSend([queued.key]);
      if (!entry) continue;
      const payload = entry.payload as {
        noteSyncId: string;
        blobKey: string;
        filename: string;
        syncId: string;
      };
      const note = await this.store.getNoteBySyncId(this.currentPartition, payload.noteSyncId);
      if (!note?.id || note.id < 0) continue;
      const blob = await this.store.getBlob(this.currentPartition, payload.blobKey);
      if (!blob) {
        await this.store.removeOutbox([entry.key]);
        continue;
      }
      const formData = new FormData();
      formData.append('file', blob, payload.filename || 'attachment');
      formData.append('syncId', payload.syncId);
      const attachment = await this.withTimeout(
        firstValueFrom(this.http.post<NoteAttachmentI>(
          `${this.apiUrl}/notes/${note.id}/attachments?syncId=${encodeURIComponent(payload.syncId)}`,
          formData,
          { headers: this.auth.authHeaders() }
        )),
        this.syncRequestTimeoutMs
      );
      await this.store.putAttachment(this.currentPartition, attachment);
      const updatedNote = {
        ...note,
        attachments: [attachment, ...(note.attachments || []).filter(item => item.syncId !== payload.syncId)]
      };
      await this.store.putNote(this.currentPartition, updatedNote);
      await this.store.deleteBlob(this.currentPartition, payload.blobKey);
      await this.store.removeOutbox([entry.key]);
      this.cacheChanged$.next({
        notesChanged: true,
        remindersChanged: false,
        attachmentsChanged: true,
        noteSyncIds: [payload.noteSyncId],
        attachmentSyncIds: [attachment.syncId || payload.syncId]
      });
    }
  }

  private async pullChanges() {
    if (!this.currentPartition) return;
    let state = await this.store.getSyncState(this.currentPartition);
    let hasMore = true;
    const changed: OfflineCacheChange = { notesChanged: false, remindersChanged: false, attachmentsChanged: false };
    const noteSyncIds = new Set<string>();
    const removedNoteSyncIds = new Set<string>();
    const reminderSyncIds = new Set<string>();
    const removedReminderSyncIds = new Set<string>();
    const attachmentSyncIds = new Set<string>();
    while (hasMore) {
      const response = await this.withTimeout(firstValueFrom(this.http.get<{
        changes: SyncChange[];
        cursor: number;
        hasMore: boolean;
        serverTime: number;
      }>(`${this.apiUrl}/sync/changes`, {
        headers: this.auth.authHeaders(),
        params: { cursor: String(state.cursor), limit: '500' }
      })), this.syncRequestTimeoutMs);
      const summary = await this.store.applyChangePage(
        this.currentPartition,
        response.changes || [],
        response.cursor || state.cursor,
        response.serverTime
      );
      summary.noteSyncIds.forEach(syncId => noteSyncIds.add(syncId));
      summary.removedNoteSyncIds.forEach(syncId => removedNoteSyncIds.add(syncId));
      summary.reminderSyncIds.forEach(syncId => reminderSyncIds.add(syncId));
      summary.removedReminderSyncIds.forEach(syncId => removedReminderSyncIds.add(syncId));
      summary.attachmentSyncIds.forEach(syncId => attachmentSyncIds.add(syncId));
      changed.notesChanged ||= summary.noteSyncIds.length > 0 || summary.removedNoteSyncIds.length > 0;
      changed.remindersChanged ||= summary.reminderSyncIds.length > 0 || summary.removedReminderSyncIds.length > 0;
      changed.attachmentsChanged ||= summary.attachmentSyncIds.length > 0;
      state = await this.store.getSyncState(this.currentPartition);
      hasMore = !!response.hasMore;
    }
    if (changed.notesChanged || changed.remindersChanged || changed.attachmentsChanged) {
      this.cacheChanged$.next({
        ...changed,
        noteSyncIds: [...noteSyncIds],
        removedNoteSyncIds: [...removedNoteSyncIds],
        reminderSyncIds: [...reminderSyncIds],
        removedReminderSyncIds: [...removedReminderSyncIds],
        attachmentSyncIds: [...attachmentSyncIds]
      });
    }
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

  private scheduleDegradedRetries() {
    if (!navigator.onLine) return;
    if (this.degradedRetryTimers.length) return;
    for (const delay of [1500, 5000, 10000]) {
      const timer = setTimeout(() => {
        this.degradedRetryTimers = this.degradedRetryTimers.filter(item => item !== timer);
        if (navigator.onLine && this.currentPartition) this.syncNow().catch(console.error);
      }, delay);
      this.degradedRetryTimers.push(timer);
    }
  }

  private async cacheSnapshotMedia(notes: NoteI[]) {
    if (!this.currentPartition || !navigator.onLine) return;
    const urls = new Set<string>();
    for (const note of notes) {
      (note.images || []).forEach(image => {
        if (image.dataUrl) urls.add(image.dataUrl);
      });
      for (const match of String(note.noteBody || '').matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) {
        if (match[1]) urls.add(match[1]);
      }
    }
    await Promise.all([...urls]
      .filter(url => !url.startsWith('data:') && !url.startsWith('blob:'))
      .map(url => this.store.cacheMedia(
        this.currentPartition,
        this.auth.canonicalImageUrl(url),
        this.auth.authenticatedImageUrl(url)
      )));
  }
}
