import { Injectable } from '@angular/core';
import { environment } from 'src/environments/environment';
import { NoteAttachmentI, NoteI } from '../interfaces/notes';
import { ReminderI } from '../interfaces/reminder';
import type { LocationSavedPlace } from './location-saved-places.service';
import type { EditorSessionRecord } from '../utils/editor-session';
import { pickGuardFields, type GuardFields } from '../utils/note-merge';

/** The server revision and field values an editor's content actually derives from, when that is older than the cache. */
export interface EditBase { revision: number; fields: GuardFields }

export type SyncResourceType = 'note' | 'reminder' | 'attachment';
export type SyncMutationType =
  | 'note.upsert'
  | 'note.patch'
  | 'note.merge'
  | 'note.delete'
  | 'note.reorder'
  | 'reminder.upsert'
  | 'reminder.delete'
  | 'attachment.upload'
  | 'attachment.delete';

export interface LwwStamp {
  physicalMs: number;
  logical: number;
  deviceId: string;
  operationId: string;
}

export interface OutboxEntry {
  key: string;
  partition: string;
  operationId: string;
  type: SyncMutationType;
  syncId: string;
  payload: unknown;
  lww: LwwStamp;
  createdAt: number;
  deliveryState?: 'unsent' | 'sent';
  sentAt?: number;
  attempts: number;
  /** Optimistic-concurrency context for a full-document note save. */
  guard?: NoteGuard;
  /** Set once the server definitively rejected the operation; it is not resent until resolved. */
  blocked?: BlockedOperation;
}

export interface NoteGuard {
  /** Server revision the edit started from. Chained operations resolve it from the cache when sent. */
  baseRevision?: number;
  /** Server-side field values the edit started from: the base of the three-way merge. */
  baseFields: GuardFields;
  /** Earlier operation for the same note that may still be applied; this one waits for its acknowledgement. */
  after?: string;
}

export interface BlockedOperation {
  reason: 'conflict' | 'access-revoked';
  message: string;
  at: number;
  latest?: NoteI | null;
  conflictFields?: string[];
}

type StoredResource<T> = {
  key: string;
  partition: string;
  syncId: string;
  value: T;
};

type SyncState = {
  key: string;
  partition: string;
  cursor: number;
  serverOffsetMs: number;
};

export interface OfflineResourceChange {
  resourceType: SyncResourceType;
  resourceSyncId: string;
  operation: 'upsert' | 'delete';
  payload: NoteI | ReminderI | NoteAttachmentI | null;
}

export interface AppliedChangeSummary {
  noteSyncIds: string[];
  removedNoteSyncIds: string[];
  reminderSyncIds: string[];
  removedReminderSyncIds: string[];
  attachmentSyncIds: string[];
}

@Injectable({ providedIn: 'root' })
export class OfflineStoreService {
  private readonly databaseName = 'keeparr-offline-v1';
  private readonly databaseVersion = 3;
  // Editor drafts live in their own database so that adding them neither bumps
  // the main schema version (older builds could not open it after a rollback)
  // nor lets a draft write contend with sync transactions.
  private readonly sessionDatabaseName = 'keeparr-editor-sessions-v1';
  private database?: Promise<IDBDatabase>;
  private sessionDatabase?: Promise<IDBDatabase>;
  private lastStampPhysicalMs = 0;
  private lastStampLogical = 0;

  partition(userId: number) {
    const api = environment.apiUrl || '/api';
    let server = api;
    try {
      server = new URL(api, window.location.origin).origin + new URL(api, window.location.origin).pathname;
    } catch {}
    return `${server}|${userId}`;
  }

  deviceId() {
    const key = 'keeparr_offline_device_id';
    let value = localStorage.getItem(key);
    if (!value) {
      value = crypto.randomUUID();
      localStorage.setItem(key, value);
    }
    return value;
  }

  nextStamp(serverOffsetMs = 0): LwwStamp {
    const now = Date.now() + serverOffsetMs;
    if (now > this.lastStampPhysicalMs) {
      this.lastStampPhysicalMs = now;
      this.lastStampLogical = 0;
    } else {
      this.lastStampLogical += 1;
    }
    return {
      physicalMs: this.lastStampPhysicalMs,
      logical: this.lastStampLogical,
      deviceId: this.deviceId(),
      operationId: crypto.randomUUID()
    };
  }

  ensureNoteIdentity(note: NoteI) {
    if (!note.syncId) note.syncId = `note-${crypto.randomUUID()}`;
    return note.syncId;
  }

  ensureReminderIdentity(reminder: Partial<ReminderI>) {
    if (!reminder.syncId) reminder.syncId = `reminder-${crypto.randomUUID()}`;
    return reminder.syncId;
  }

  async replaceSnapshot(partition: string, notes: NoteI[], reminders: ReminderI[], attachments: NoteAttachmentI[], cursor: number, serverTime: number) {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['notes', 'reminders', 'attachments', 'outbox', 'syncState'], 'readwrite');
      const stores = {
        notes: transaction.objectStore('notes'),
        reminders: transaction.objectStore('reminders'),
        attachments: transaction.objectStore('attachments'),
        outbox: transaction.objectStore('outbox'),
        syncState: transaction.objectStore('syncState')
      };
      const localNotes = new Map<string, NoteI>();
      const localReminders = new Map<string, ReminderI>();
      const localAttachments = new Map<string, NoteAttachmentI>();
      const latestPending = new Map<string, OutboxEntry>();
      const pendingNotePatches = new Map<string, OutboxEntry[]>();
      const pendingNoteMerges: OutboxEntry[] = [];
      let cursorsRemaining = 4;
      const writeSnapshot = () => {
        const snapshotNotes = new Map<string, NoteI>();
        notes.forEach(note => {
          const syncId = this.ensureNoteIdentity(note);
          snapshotNotes.set(syncId, note);
        });
        const snapshotReminders = new Map<string, ReminderI>();
        reminders.forEach(reminder => {
          const syncId = this.ensureReminderIdentity(reminder);
          snapshotReminders.set(syncId, reminder);
        });
        const snapshotAttachments = new Map<string, NoteAttachmentI>();
        attachments.forEach(attachment => {
          if (attachment.syncId) snapshotAttachments.set(attachment.syncId, attachment);
        });
        for (const entry of latestPending.values()) {
          if (entry.type === 'note.delete') {
            snapshotNotes.delete(entry.syncId);
          } else if (entry.type === 'note.upsert' || entry.type === 'note.merge') {
            const serverNote = snapshotNotes.get(entry.syncId);
            const pendingNote = localNotes.get(entry.syncId)
              || (entry.type === 'note.upsert' ? entry.payload as NoteI : undefined);
            if (!pendingNote) continue;
            snapshotNotes.set(entry.syncId, serverNote ? {
              ...serverNote,
              ...pendingNote,
              id: serverNote.id ?? pendingNote.id,
              revision: serverNote.revision ?? pendingNote.revision,
              syncId: entry.syncId
            } : { ...pendingNote, syncId: entry.syncId });
          } else if (entry.type === 'reminder.delete') {
            snapshotReminders.delete(entry.syncId);
          } else if (entry.type === 'reminder.upsert') {
            const serverReminder = snapshotReminders.get(entry.syncId);
            const pendingReminder = localReminders.get(entry.syncId) || entry.payload as ReminderI;
            snapshotReminders.set(entry.syncId, serverReminder ? {
              ...serverReminder,
              ...pendingReminder,
              id: serverReminder.id ?? pendingReminder.id,
              noteId: pendingReminder.noteId != null && pendingReminder.noteId < 0
                ? serverReminder.noteId ?? pendingReminder.noteId
                : pendingReminder.noteId,
              syncId: entry.syncId
            } : { ...pendingReminder, syncId: entry.syncId });
          } else if (entry.type === 'attachment.delete') {
            snapshotAttachments.delete(entry.syncId);
          } else if (entry.type === 'attachment.upload') {
            const localAttachment = localAttachments.get(entry.syncId);
            if (!localAttachment) continue;
            const payload = entry.payload as { noteSyncId?: string };
            const noteSyncId = payload.noteSyncId || '';
            const note = snapshotNotes.get(noteSyncId)
              || [...snapshotNotes.values()].find(item => item.id === localAttachment.noteId);
            const attachment = note?.id != null ? { ...localAttachment, noteId: note.id } : localAttachment;
            snapshotAttachments.set(entry.syncId, attachment);
            if (note?.syncId) {
              const currentAttachments = note.attachments || [];
              snapshotNotes.set(note.syncId, {
                ...note,
                attachments: [attachment, ...currentAttachments.filter(item => item.syncId !== entry.syncId)]
              });
            }
          }
        }
        for (const [syncId, entries] of pendingNotePatches) {
          const latestFullMutation = latestPending.get(`note|${syncId}`);
          if (latestFullMutation?.type === 'note.delete') continue;
          const serverNote = snapshotNotes.get(syncId);
          const localNote = localNotes.get(syncId);
          const base = serverNote || localNote;
          if (!base) continue;
          const patches = entries
            .filter(entry => latestFullMutation?.type !== 'note.upsert'
              || this.compareLwwStamp(entry.lww, latestFullMutation.lww) > 0)
            .sort((left, right) => this.compareLwwStamp(left.lww, right.lww));
          const value = this.applyPendingNotePatches(base, syncId, patches);
          snapshotNotes.set(syncId, {
            ...value,
            id: serverNote?.id ?? value.id,
            revision: serverNote?.revision ?? value.revision,
            syncId
          });
        }
        for (const entry of pendingNoteMerges) {
          const payload = entry.payload as {
            orderedSourceSyncIds?: string[];
            sourceIds?: number[];
            localMergeId?: number;
            keptReminderSyncId?: string;
            removedReminderSyncIds?: string[];
          };
          const mergeNote = snapshotNotes.get(entry.syncId);
          const targetId = mergeNote?.id ?? payload.localMergeId;
          const sourceIds = new Set<number>(payload.sourceIds || []);
          for (const syncId of payload.orderedSourceSyncIds || []) {
            const serverSource = snapshotNotes.get(syncId);
            const localSource = localNotes.get(syncId);
            if (serverSource) sourceIds.add(serverSource.id ?? 0);
            if (localSource) sourceIds.add(localSource.id ?? 0);
            if (!serverSource || !localSource) continue;
            snapshotNotes.set(syncId, {
              ...serverSource,
              trashed: localSource.trashed,
              trashedAt: localSource.trashedAt,
              pinned: false,
              updatedAt: localSource.updatedAt,
              lastEditorUserId: localSource.lastEditorUserId
            });
          }
          if (targetId != null) {
            for (const [syncId, attachment] of snapshotAttachments) {
              const localAttachment = localAttachments.get(syncId);
              if (attachment.noteId != null && sourceIds.has(attachment.noteId)
                  || localAttachment?.noteId === payload.localMergeId) {
                snapshotAttachments.set(syncId, { ...(localAttachment || attachment), noteId: targetId });
              }
            }
            for (const [syncId, reminder] of snapshotReminders) {
              if ((payload.removedReminderSyncIds || []).includes(syncId)) {
                snapshotReminders.delete(syncId);
              } else if (syncId === payload.keptReminderSyncId) {
                snapshotReminders.set(syncId, { ...reminder, noteId: targetId });
              }
            }
            const currentMergeNote = snapshotNotes.get(entry.syncId);
            if (currentMergeNote) {
              snapshotNotes.set(entry.syncId, {
                ...currentMergeNote,
                attachments: [...snapshotAttachments.values()].filter(attachment => attachment.noteId === targetId)
              });
            }
          }
        }
        // Dependents kept alive by pending work still point at a local note ID that the
        // server snapshot has since replaced with a positive one.
        const remappedNoteIds = new Map<number, number>();
        snapshotNotes.forEach((note, syncId) => {
          const localId = localNotes.get(syncId)?.id;
          if (localId != null && localId < 0 && note.id != null && note.id > 0) remappedNoteIds.set(localId, note.id);
        });
        if (remappedNoteIds.size) {
          snapshotReminders.forEach((reminder, syncId) => {
            const to = reminder.noteId != null ? remappedNoteIds.get(reminder.noteId) : undefined;
            if (to != null) snapshotReminders.set(syncId, { ...reminder, noteId: to });
          });
          snapshotAttachments.forEach((attachment, syncId) => {
            const to = attachment.noteId != null ? remappedNoteIds.get(attachment.noteId) : undefined;
            if (to != null) snapshotAttachments.set(syncId, { ...attachment, noteId: to });
          });
          snapshotNotes.forEach((note, syncId) => {
            if (!note.attachments?.some(attachment => attachment.noteId != null && remappedNoteIds.has(attachment.noteId))) return;
            snapshotNotes.set(syncId, {
              ...note,
              attachments: note.attachments.map(attachment => {
                const to = attachment.noteId != null ? remappedNoteIds.get(attachment.noteId) : undefined;
                return to != null ? { ...attachment, noteId: to } : attachment;
              })
            });
          });
        }
        snapshotNotes.forEach((note, syncId) => {
          stores.notes.put({ key: this.resourceKey(partition, syncId), partition, syncId, value: note });
        });
        snapshotReminders.forEach((reminder, syncId) => {
          stores.reminders.put({ key: this.resourceKey(partition, syncId), partition, syncId, value: reminder });
        });
        for (const attachment of snapshotAttachments.values()) {
          if (!attachment.syncId) continue;
          stores.attachments.put({
            key: this.resourceKey(partition, attachment.syncId),
            partition,
            syncId: attachment.syncId,
            value: attachment
          });
        }
        stores.syncState.put({
        key: partition,
        partition,
        cursor,
        serverOffsetMs: Number(serverTime || Date.now()) - Date.now()
        } satisfies SyncState);
      };
      for (const store of [stores.notes, stores.reminders, stores.attachments]) {
        const request = store.index('partition').openKeyCursor(IDBKeyRange.only(partition));
        request.onerror = () => transaction.abort();
        request.onsuccess = () => {
          const keyCursor = request.result;
          if (keyCursor) {
            const recordRequest = store.get(keyCursor.primaryKey);
            recordRequest.onsuccess = () => {
               const record = recordRequest.result as StoredResource<NoteI | ReminderI | NoteAttachmentI> | undefined;
               if (record && store === stores.notes) localNotes.set(record.syncId, record.value as NoteI);
               if (record && store === stores.reminders) localReminders.set(record.syncId, record.value as ReminderI);
               if (record && store === stores.attachments) localAttachments.set(record.syncId, record.value as NoteAttachmentI);
            };
            store.delete(keyCursor.primaryKey);
            keyCursor.continue();
            return;
          }
          cursorsRemaining--;
          if (cursorsRemaining === 0) writeSnapshot();
        };
      }
      const outboxRequest = stores.outbox.index('partition').openCursor(IDBKeyRange.only(partition));
      outboxRequest.onerror = () => transaction.abort();
      outboxRequest.onsuccess = () => {
        const cursor = outboxRequest.result;
        if (cursor) {
          const entry = cursor.value as OutboxEntry;
          if (entry.type === 'note.patch') {
            const patches = pendingNotePatches.get(entry.syncId) || [];
            patches.push(entry);
            pendingNotePatches.set(entry.syncId, patches);
            cursor.continue();
            return;
          }
          if (entry.type === 'note.merge') pendingNoteMerges.push(entry);
          const resource = entry.type.startsWith('note.') ? 'note'
            : entry.type.startsWith('reminder.') ? 'reminder'
              : entry.type.startsWith('attachment.') ? 'attachment' : '';
          if (resource) {
            const key = `${resource}|${entry.syncId}`;
            const previous = latestPending.get(key);
            if (!previous || this.compareLwwStamp(entry.lww, previous.lww) > 0) {
              latestPending.set(key, entry);
            }
          }
          cursor.continue();
          return;
        }
        cursorsRemaining--;
        if (cursorsRemaining === 0) writeSnapshot();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not replace the offline snapshot.'));
      transaction.onabort = () => reject(transaction.error || new Error('Offline snapshot replacement was aborted.'));
    });
  }

  async applyChangePage(partition: string, changes: readonly OfflineResourceChange[], cursor: number, serverTime: number) {
    const db = await this.open();
    return new Promise<AppliedChangeSummary>((resolve, reject) => {
      const transaction = db.transaction(['notes', 'reminders', 'attachments', 'outbox', 'syncState'], 'readwrite');
      const notes = transaction.objectStore('notes');
      const reminders = transaction.objectStore('reminders');
      const attachments = transaction.objectStore('attachments');
      const outbox = transaction.objectStore('outbox');
      const syncState = transaction.objectStore('syncState');
      const pendingByResource = new Map<string, OutboxEntry>();
      const pendingNotePatches = new Map<string, OutboxEntry[]>();
      const pendingMergesBySourceSyncId = new Map<string, OutboxEntry>();
      const pendingMergesBySourceId = new Map<number, OutboxEntry>();
      const pendingMergesByReminderSyncId = new Map<string, { entry: OutboxEntry; remove: boolean }>();
      const summary: AppliedChangeSummary = {
        noteSyncIds: [],
        removedNoteSyncIds: [],
        reminderSyncIds: [],
        removedReminderSyncIds: [],
        attachmentSyncIds: []
      };
      let changesStarted = false;
      let remaining = changes.length;
      const advanceCursor = () => {
        syncState.put({
          key: partition,
          partition,
          cursor,
          serverOffsetMs: Number(serverTime || Date.now()) - Date.now()
        } satisfies SyncState);
      };
      const resourceKeyForEntry = (entry: OutboxEntry) => entry.type.startsWith('note.') ? 'note'
        : entry.type.startsWith('reminder.') ? 'reminder'
          : entry.type.startsWith('attachment.') ? 'attachment' : '';
      const recordChange = (change: OfflineResourceChange, changed: boolean, removed: boolean) => {
        if (changed) {
          if (change.resourceType === 'note') (removed ? summary.removedNoteSyncIds : summary.noteSyncIds).push(change.resourceSyncId);
          else if (change.resourceType === 'reminder') (removed ? summary.removedReminderSyncIds : summary.reminderSyncIds).push(change.resourceSyncId);
          else summary.attachmentSyncIds.push(change.resourceSyncId);
        }
        remaining--;
        if (remaining === 0) advanceCursor();
      };
      const applyLoadedChange = (change: OfflineResourceChange) => {
        const store = change.resourceType === 'note' ? notes
          : change.resourceType === 'reminder' ? reminders : attachments;
        const key = this.resourceKey(partition, change.resourceSyncId);
        const getRequest = store.get(key);
        getRequest.onerror = () => transaction.abort();
        getRequest.onsuccess = () => {
          const existing = getRequest.result as StoredResource<NoteI | ReminderI | NoteAttachmentI> | undefined;
          const previous = existing?.value;
          const pending = pendingByResource.get(`${change.resourceType}|${change.resourceSyncId}`);
          const pendingDelete = pending?.type === `${change.resourceType}.delete`;
          const pendingUpsert = pending?.type === `${change.resourceType}.upsert`
            || (change.resourceType === 'attachment' && pending?.type === 'attachment.upload')
            || (change.resourceType === 'note' && pending?.type === 'note.merge');
          let desired: NoteI | ReminderI | NoteAttachmentI | undefined;
          if (change.operation === 'delete') {
            if (pendingUpsert) {
              desired = previous || pending.payload as NoteI | ReminderI | NoteAttachmentI;
            }
          } else if (!pendingDelete && change.payload) {
            const serverValue = change.payload;
            if (pendingUpsert) {
              const localValue = change.resourceType === 'attachment'
                ? previous || serverValue
                : previous || (pending?.type === 'note.merge'
                  ? serverValue
                  : pending?.payload as NoteI | ReminderI | NoteAttachmentI);
              if (change.resourceType === 'note') {
                const serverNote = serverValue as NoteI;
                const localNote = localValue as NoteI;
                desired = {
                  ...serverNote,
                  ...localNote,
                  id: serverNote.id ?? localNote.id,
                  revision: serverNote.revision ?? localNote.revision,
                  syncId: change.resourceSyncId
                };
              } else if (change.resourceType === 'reminder') {
                const serverReminder = serverValue as ReminderI;
                const localReminder = localValue as ReminderI;
                desired = {
                  ...serverReminder,
                  ...localReminder,
                  id: serverReminder.id ?? localReminder.id,
                  noteId: localReminder.noteId != null && localReminder.noteId < 0
                    ? serverReminder.noteId ?? localReminder.noteId
                    : localReminder.noteId,
                  syncId: change.resourceSyncId
                };
              } else desired = localValue as NoteAttachmentI;
            } else desired = serverValue;
          }
          if (change.resourceType === 'note' && desired && !pendingDelete) {
            const patches = pendingNotePatches.get(change.resourceSyncId) || [];
            const pendingFullMutation = pendingByResource.get(`note|${change.resourceSyncId}`);
            const applicablePatches = patches
              .filter(entry => pendingFullMutation?.type !== 'note.upsert'
                || this.compareLwwStamp(entry.lww, pendingFullMutation.lww) > 0)
              .sort((left, right) => this.compareLwwStamp(left.lww, right.lww));
            desired = this.applyPendingNotePatches(desired as NoteI, change.resourceSyncId, applicablePatches);
          }
          const sourceMerge = pendingMergesBySourceSyncId.get(change.resourceSyncId);
          if (change.resourceType === 'note' && desired && !pendingDelete && sourceMerge) {
            const localSource = previous as NoteI | undefined;
            if (localSource) {
              desired = {
                ...(desired as NoteI),
                trashed: localSource.trashed,
                trashedAt: localSource.trashedAt,
                pinned: false,
                updatedAt: localSource.updatedAt,
                lastEditorUserId: localSource.lastEditorUserId
              };
            }
          }
          if (change.resourceType === 'attachment' && desired) {
            const merge = pendingMergesBySourceId.get((desired as NoteAttachmentI).noteId || 0);
            if (merge) {
              const mergePayload = merge.payload as { localMergeId?: number };
              desired = { ...(desired as NoteAttachmentI), noteId: mergePayload.localMergeId };
            }
          }
          if (change.resourceType === 'reminder') {
            const mergeState = pendingMergesByReminderSyncId.get(change.resourceSyncId);
            if (mergeState?.remove) desired = undefined;
            else if (mergeState) {
              const mergePayload = mergeState.entry.payload as { localMergeId?: number };
              desired = desired ? { ...(desired as ReminderI), noteId: mergePayload.localMergeId ?? null } : desired;
            }
          }
          if (!desired) {
            if (!existing) {
              recordChange(change, false, false);
              return;
            }
            store.delete(key);
            recordChange(change, true, true);
            return;
          }
          if (previous && JSON.stringify(previous) === JSON.stringify(desired)) {
            recordChange(change, false, false);
            return;
          }
          const write = () => {
            store.put({ key, partition, syncId: change.resourceSyncId, value: desired });
            // A locally created note just received its server ID: its reminders and
            // attachments must follow it, in the same transaction.
            if (change.resourceType === 'note') {
              const from = (previous as NoteI | undefined)?.id;
              const to = (desired as NoteI).id;
              if (from != null && from < 0 && to != null && to > 0) this.remapNoteDependents(reminders, attachments, partition, from, to);
            }
            recordChange(change, true, false);
          };
          if (change.resourceType !== 'note' || (desired as NoteI).id == null) {
            write();
            return;
          }
          const duplicates = notes.index('partitionAndId').openKeyCursor(
            IDBKeyRange.only([partition, (desired as NoteI).id!])
          );
          duplicates.onerror = () => transaction.abort();
          duplicates.onsuccess = () => {
            const duplicate = duplicates.result;
            if (duplicate) {
              if (duplicate.primaryKey !== key) notes.delete(duplicate.primaryKey);
              duplicate.continue();
            } else write();
          };
        };
      };
      const beginChanges = () => {
        if (changesStarted) return;
        changesStarted = true;
        if (!changes.length) {
          advanceCursor();
          return;
        }
        changes.forEach(applyLoadedChange);
      };
      const pendingRequest = outbox.index('partition').openCursor(IDBKeyRange.only(partition));
      pendingRequest.onerror = () => transaction.abort();
      pendingRequest.onsuccess = () => {
        const cursorRecord = pendingRequest.result;
        if (cursorRecord) {
          const entry = cursorRecord.value as OutboxEntry;
          if (entry.type === 'note.merge') {
            const payload = entry.payload as {
              orderedSourceSyncIds?: string[];
              sourceIds?: number[];
              keptReminderSyncId?: string;
              removedReminderSyncIds?: string[];
            };
            for (const syncId of payload.orderedSourceSyncIds || []) pendingMergesBySourceSyncId.set(syncId, entry);
            for (const id of payload.sourceIds || []) pendingMergesBySourceId.set(id, entry);
            for (const change of changes) {
              if (change.resourceType !== 'note' || !payload.orderedSourceSyncIds?.includes(change.resourceSyncId)) continue;
              const serverId = (change.payload as NoteI | null)?.id;
              if (serverId != null) pendingMergesBySourceId.set(serverId, entry);
            }
            if (payload.keptReminderSyncId) {
              pendingMergesByReminderSyncId.set(payload.keptReminderSyncId, { entry, remove: false });
            }
            for (const syncId of payload.removedReminderSyncIds || []) {
              pendingMergesByReminderSyncId.set(syncId, { entry, remove: true });
            }
          }
          if (entry.type === 'note.patch') {
            const patches = pendingNotePatches.get(entry.syncId) || [];
            patches.push(entry);
            pendingNotePatches.set(entry.syncId, patches);
            cursorRecord.continue();
            return;
          }
          const family = resourceKeyForEntry(entry);
          if (family) {
            const key = `${family}|${entry.syncId}`;
            const existing = pendingByResource.get(key);
            if (!existing || this.compareLwwStamp(entry.lww, existing.lww) > 0) pendingByResource.set(key, entry);
          }
          cursorRecord.continue();
          return;
        }
        beginChanges();
      };
      transaction.oncomplete = () => resolve(summary);
      transaction.onerror = () => reject(transaction.error || new Error('Could not apply the offline change page.'));
      transaction.onabort = () => reject(transaction.error || new Error('Offline change page was aborted.'));
    });
  }

  private remapNoteDependents(reminders: IDBObjectStore, attachments: IDBObjectStore, partition: string, from: number, to: number) {
    for (const store of [reminders, attachments]) {
      const cursor = store.index('partition').openCursor(IDBKeyRange.only(partition));
      cursor.onsuccess = () => {
        const record = cursor.result;
        if (!record) return;
        const stored = record.value as StoredResource<ReminderI | NoteAttachmentI>;
        if (stored.value.noteId === from) record.update({ ...stored, value: { ...stored.value, noteId: to } });
        record.continue();
      };
    }
  }

  async listNotes(partition: string) {
    const records = await this.listRecords<NoteI>('notes', partition);
    const byIdentity = new Map<string, NoteI>();
    for (const record of records) {
      const identity = record.value.id != null ? `id:${record.value.id}` : `sync:${record.syncId}`;
      const existing = byIdentity.get(identity);
      byIdentity.set(identity, existing ? this.preferNote(existing, record.value) : record.value);
    }
    return [...byIdentity.values()];
  }

  /** IDs stored under more than one sync identity, found from index keys alone (no record is deserialized). */
  private async duplicateNoteIds(partition: string) {
    const db = await this.open();
    return new Promise<number[]>((resolve, reject) => {
      const index = db.transaction('notes').objectStore('notes').index('partitionAndId');
      const request = index.openKeyCursor(IDBKeyRange.bound([partition, -Infinity], [partition, Infinity]));
      const duplicates = new Set<number>();
      let previous: number | undefined;
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return resolve([...duplicates]);
        const id = (cursor.key as [string, number])[1];
        if (id === previous) duplicates.add(id);
        previous = id;
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async repairDuplicateNoteIdentities(partition: string) {
    const duplicateIds = await this.duplicateNoteIds(partition);
    if (!duplicateIds.length) return 0;
    const duplicateGroups = (await Promise.all(duplicateIds.map(id => this.noteRecordsWithId(partition, id))))
      .filter(matches => matches.length > 1);
    if (!duplicateGroups.length) return 0;

    const repairs = duplicateGroups.map(matches => {
      const preferred = matches.slice(1).reduce(
        (best, record) => this.preferNote(best, record.value),
        matches[0].value
      );
      const retained = matches.find(record => record.syncId === preferred.syncId) || matches[matches.length - 1];
      const syncId = preferred.syncId || retained.syncId;
      return {
        records: matches,
        record: { key: this.resourceKey(partition, syncId), partition, syncId, value: { ...preferred, syncId } }
      };
    });
    const db = await this.open();
    await this.transaction(db, ['notes'], 'readwrite', stores => {
      for (const repair of repairs) {
        repair.records.forEach(record => stores['notes'].delete(record.key));
        stores['notes'].put(repair.record);
      }
    });
    return duplicateGroups.reduce((count, matches) => count + matches.length - 1, 0);
  }

  async listReminders(partition: string) {
    return this.listValues<ReminderI>('reminders', partition);
  }

  async listAttachments(partition: string) {
    return this.listValues<NoteAttachmentI>('attachments', partition);
  }

  async getNote(partition: string, id: number) {
    const matches = await this.notesWithId(partition, id);
    return matches.reduce<NoteI | undefined>((best, note) => best ? this.preferNote(best, note) : note, undefined);
  }

  async getNoteBySyncId(partition: string, syncId: string) {
    return this.getResourceValue<NoteI>('notes', partition, syncId);
  }

  async putNote(partition: string, note: NoteI) {
    const syncId = this.ensureNoteIdentity(note);
    const existing = note.id != null ? await this.noteRecordsWithId(partition, note.id) : [];
    const preferred = existing.reduce<NoteI | undefined>((best, record) => {
      if (!best) return record.value;
      return this.preferNote(best, record.value);
    }, undefined);
    const value = preferred ? this.preferNote(preferred, note) : note;
    const db = await this.open();
    await this.transaction(db, ['notes'], 'readwrite', stores => {
      existing
        .filter(record => record.syncId !== syncId)
        .forEach(record => stores['notes'].delete(record.key));
      stores['notes'].put({ key: this.resourceKey(partition, syncId), partition, syncId, value });
    });
  }

  async overwriteNoteMetadata(partition: string, note: NoteI) {
    const syncId = this.ensureNoteIdentity(note);
    const existing = note.id != null ? await this.noteRecordsWithId(partition, note.id) : [];
    const db = await this.open();
    await this.transaction(db, ['notes'], 'readwrite', stores => {
      existing
        .filter(record => record.syncId !== syncId)
        .forEach(record => stores['notes'].delete(record.key));
      stores['notes'].put({ key: this.resourceKey(partition, syncId), partition, syncId, value: note });
    });
  }

  async deleteNote(partition: string, syncId: string) {
    await this.deleteResource('notes', partition, syncId);
  }

  async putReminder(partition: string, reminder: ReminderI) {
    const syncId = this.ensureReminderIdentity(reminder);
    await this.putResource('reminders', partition, syncId, reminder);
  }

  async getReminder(partition: string, syncId: string) {
    return this.getResourceValue<ReminderI>('reminders', partition, syncId);
  }

  async deleteReminder(partition: string, syncId: string) {
    await this.deleteResource('reminders', partition, syncId);
  }

  async putAttachment(partition: string, attachment: NoteAttachmentI) {
    if (!attachment.syncId) return;
    await this.putResource('attachments', partition, attachment.syncId, attachment);
  }

  async getAttachment(partition: string, syncId: string) {
    return this.getResourceValue<NoteAttachmentI>('attachments', partition, syncId);
  }

  async replaceSavedPlaces(partition: string, places: LocationSavedPlace[]) {
    const db = await this.open();
    await this.clearPartitionStore(db, 'savedPlaces', partition);
    await this.transaction(db, ['savedPlaces'], 'readwrite', stores => {
      places.forEach(place => stores['savedPlaces'].put({
        key: `${partition}|${place.id}`,
        partition,
        syncId: String(place.id),
        value: place
      }));
    });
  }

  async listSavedPlaces(partition: string) {
    return this.listValues<LocationSavedPlace>('savedPlaces', partition);
  }

  async deleteAttachment(partition: string, syncId: string) {
    await this.deleteResource('attachments', partition, syncId);
  }

  async enqueue(partition: string, type: SyncMutationType, syncId: string, payload: unknown, stamp: LwwStamp) {
    const entry: OutboxEntry = {
      key: `${partition}|${stamp.operationId}`,
      partition,
      operationId: stamp.operationId,
      type,
      syncId,
      payload,
      lww: stamp,
      createdAt: Date.now(),
      attempts: 0
    };
    const db = await this.open();
    await this.request(db.transaction('outbox', 'readwrite').objectStore('outbox').put(entry));
    return entry;
  }

  async persistNoteMutation(partition: string, note: NoteI, stamp: LwwStamp, base?: EditBase) {
    const syncId = this.ensureNoteIdentity(note);
    const persisted: NoteI = {
      ...note,
      lwwPhysicalMs: stamp.physicalMs,
      lwwLogical: stamp.logical,
      lwwDeviceId: stamp.deviceId,
      lwwOperationId: stamp.operationId
    };
    const entry: OutboxEntry = {
      key: `${partition}|${stamp.operationId}`,
      partition,
      operationId: stamp.operationId,
      type: 'note.upsert',
      syncId,
      payload: persisted,
      lww: stamp,
      createdAt: Date.now(),
      deliveryState: 'unsent',
      attempts: 0
    };
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['notes', 'outbox'], 'readwrite');
      const notes = transaction.objectStore('notes');
      const outbox = transaction.objectStore('outbox');
      let cachedNote: NoteI | undefined;
      let failure: unknown;
      const cachedRequest = notes.get(this.resourceKey(partition, syncId));
      cachedRequest.onerror = () => transaction.abort();
      cachedRequest.onsuccess = () => {
        cachedNote = (cachedRequest.result as StoredResource<NoteI> | undefined)?.value;
        scan();
      };
      const scan = () => {
        const pending: OutboxEntry[] = [];
        let coalescedGuard: NoteGuard | undefined;
        let coalesced = false;
        const cursor = outbox.index('partition').openCursor(IDBKeyRange.only(partition));
        cursor.onerror = () => transaction.abort();
        cursor.onsuccess = this.abortOnThrow(transaction, () => {
          const queued = cursor.result;
          if (queued) {
            const previous = queued.value as OutboxEntry;
            if (previous.type === 'note.upsert' && previous.syncId === syncId && previous.deliveryState === 'unsent' && !previous.blocked) {
              coalescedGuard = previous.guard;
              coalesced = true;
              outbox.delete(queued.primaryKey);
            } else if ((previous.type === 'note.upsert' || previous.type === 'note.patch') && previous.syncId === syncId) {
              pending.push(previous);
            }
            queued.continue();
            return;
          }
          const guard = this.noteGuardFor(cachedNote, pending, coalesced, coalescedGuard, base);
          if (guard) entry.guard = guard;
          notes.put({
            key: this.resourceKey(partition, syncId),
            partition,
            syncId,
            value: persisted
          });
          outbox.put(entry);
        }, error => { failure = error; });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Could not persist the note and outbox entry.'));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Note persistence was aborted.'));
    });
    return { note: persisted, entry };
  }

  /**
   * Guard for a full-document save of an existing server note. A coalesced
   * unsent save keeps the original base; otherwise a save behind a possibly
   * applied operation chains after it; otherwise it is based on the accepted
   * cached note. Notes that do not exist on the server yet are unguarded.
   */
  private noteGuardFor(cached: NoteI | undefined, pending: OutboxEntry[], coalesced: boolean, coalescedGuard?: NoteGuard, base?: EditBase): NoteGuard | undefined {
    const last = [...pending].sort((left, right) => this.compareLwwStamp(left.lww, right.lww)).pop();
    if (coalesced) {
      // The cache already holds the replaced save's edits, so only its own base is a valid merge base.
      if (!coalescedGuard) return undefined;
      return last ? { ...coalescedGuard, after: coalescedGuard.after ?? last.operationId } : coalescedGuard;
    }
    if (!cached || cached.id == null || cached.id <= 0 || cached.revision == null) return undefined;
    const baseFields = pickGuardFields(cached);
    if (last) return { baseFields, after: last.operationId };
    // An editor still showing an older version than the cache must be judged against that version: the server then
    // reports the newer revision and the three-way merge uses the editor's real base, instead of treating the
    // newer server values as unchanged and silently overwriting them.
    if (base && base.revision < cached.revision) return { baseRevision: base.revision, baseFields: base.fields };
    return { baseRevision: cached.revision, baseFields };
  }

  async persistNotePatchMutation(partition: string, note: NoteI, patch: Partial<NoteI>, stamp: LwwStamp) {
    const syncId = this.ensureNoteIdentity(note);
    let persisted: NoteI = { ...note, syncId };
    const patchEntry: OutboxEntry = {
      key: `${partition}|${stamp.operationId}`,
      partition,
      operationId: stamp.operationId,
      type: 'note.patch',
      syncId,
      payload: { id: persisted.id, patch },
      lww: stamp,
      createdAt: Date.now(),
      deliveryState: 'unsent',
      attempts: 0
    };
    const db = await this.open();
    let entry = patchEntry;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['notes', 'outbox'], 'readwrite');
      const notes = transaction.objectStore('notes');
      const outbox = transaction.objectStore('outbox');
      let replacedUnsentUpsert = false;
      let replacedGuard: NoteGuard | undefined;
      let failure: unknown;
      const cursor = outbox.index('partition').openCursor(IDBKeyRange.only(partition));
      cursor.onerror = () => transaction.abort();
      cursor.onsuccess = this.abortOnThrow(transaction, () => {
        const queued = cursor.result;
        if (queued) {
          const previous = queued.value as OutboxEntry;
          if (previous.type === 'note.upsert' && previous.syncId === syncId && previous.deliveryState === 'unsent' && !previous.blocked) {
            replacedUnsentUpsert = true;
            replacedGuard = previous.guard;
            outbox.delete(queued.primaryKey);
          }
          queued.continue();
          return;
        }
        if (replacedUnsentUpsert) {
          persisted = {
            ...persisted,
            lwwPhysicalMs: stamp.physicalMs,
            lwwLogical: stamp.logical,
            lwwDeviceId: stamp.deviceId,
            lwwOperationId: stamp.operationId
          };
          entry = { ...patchEntry, type: 'note.upsert', payload: persisted, ...(replacedGuard ? { guard: replacedGuard } : {}) };
        }
        notes.put({ key: this.resourceKey(partition, syncId), partition, syncId, value: persisted });
        outbox.put(entry);
      }, error => { failure = error; });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('Could not persist the note patch and outbox entry.'));
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Note patch persistence was aborted.'));
    });
    return { note: persisted, entry };
  }

  async persistNoteMergeMutation(partition: string, mergedNote: NoteI, sourceNotes: NoteI[], stamp: LwwStamp) {
    if (sourceNotes.length < 2) throw new Error('At least two source notes are required to merge.');
    const sourceSyncIds = sourceNotes.map(note => this.ensureNoteIdentity(note));
    if (new Set(sourceSyncIds).size !== sourceSyncIds.length) throw new Error('Source note identities must be unique.');
    const sourceIds = sourceNotes.map(note => note.id).filter((id): id is number => id != null);
    const sourceSyncIdSet = new Set(sourceSyncIds);
    const sourceIdSet = new Set(sourceIds);
    const now = new Date().toISOString();
    const updatedSources = sourceNotes.map(note => ({
      ...note,
      trashed: true,
      trashedAt: now,
      updatedAt: now,
      pinned: false
    }));
    const entry: OutboxEntry = {
      key: `${partition}|${stamp.operationId}`,
      partition,
      operationId: stamp.operationId,
      type: 'note.merge',
      syncId: this.ensureNoteIdentity(mergedNote),
      payload: {
        orderedSourceSyncIds: sourceSyncIds,
        sourceIds,
        mergeSyncId: mergedNote.syncId,
        localMergeId: mergedNote.id
      },
      lww: stamp,
      createdAt: Date.now(),
      deliveryState: 'unsent',
      attempts: 0
    };
    const db = await this.open();
    let persistedEntry = entry;
    let persistedMerged = { ...mergedNote, syncId: entry.syncId, attachments: [...(mergedNote.attachments || [])] };
    let keptReminder: ReminderI | undefined;
    const removedReminderSyncIds: string[] = [];
    const updatedAttachments: NoteAttachmentI[] = [];
    let failure: Error | undefined;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['notes', 'reminders', 'attachments', 'outbox'], 'readwrite');
      const notes = transaction.objectStore('notes');
      const reminders = transaction.objectStore('reminders');
      const attachments = transaction.objectStore('attachments');
      const outbox = transaction.objectStore('outbox');
      let scansRemaining = 3;
      const finishScans = () => {
        scansRemaining--;
        if (scansRemaining !== 0 || failure) return;

        for (const source of updatedSources) {
          notes.put({ key: this.resourceKey(partition, source.syncId!), partition, syncId: source.syncId!, value: source });
        }
        const pendingReminders = (reminderRecords || [])
          .filter(record => sourceIdSet.has(record.value.noteId || 0) && record.value.status === 'pending')
          .map(record => record.value)
          .sort((left, right) => {
            const leftDue = left.dueAtUtc ? Date.parse(left.dueAtUtc) : -Infinity;
            const rightDue = right.dueAtUtc ? Date.parse(right.dueAtUtc) : -Infinity;
            return leftDue - rightDue || left.id - right.id;
          });
        if (pendingReminders.length) {
          keptReminder = { ...pendingReminders[0], noteId: persistedMerged.id!, updatedAt: now };
          reminders.put({
            key: this.resourceKey(partition, keptReminder.syncId!),
            partition,
            syncId: keptReminder.syncId!,
            value: keptReminder
          });
          for (const removed of pendingReminders.slice(1)) {
            if (!removed.syncId) continue;
            removedReminderSyncIds.push(removed.syncId);
            reminders.delete(this.resourceKey(partition, removed.syncId));
          }
        }
        persistedMerged = {
          ...persistedMerged,
          attachments: updatedAttachments,
          hasAttachments: updatedAttachments.length > 0,
          attachmentCount: updatedAttachments.length
        };
        notes.put({
          key: this.resourceKey(partition, entry.syncId),
          partition,
          syncId: entry.syncId,
          value: persistedMerged
        });
        persistedEntry = {
          ...entry,
          payload: {
            ...entry.payload as object,
            keptReminderSyncId: keptReminder?.syncId,
            removedReminderSyncIds
          }
        };
        outbox.put(persistedEntry);
      };
      let reminderRecords: StoredResource<ReminderI>[] = [];
      const reminderCursor = reminders.index('partition').openCursor(IDBKeyRange.only(partition));
      reminderCursor.onerror = () => transaction.abort();
      reminderCursor.onsuccess = () => {
        const cursor = reminderCursor.result;
        if (cursor) {
          reminderRecords.push(cursor.value as StoredResource<ReminderI>);
          cursor.continue();
        } else finishScans();
      };
      const attachmentCursor = attachments.index('partition').openCursor(IDBKeyRange.only(partition));
      attachmentCursor.onerror = () => transaction.abort();
      attachmentCursor.onsuccess = () => {
        const cursor = attachmentCursor.result;
        if (cursor) {
          const record = cursor.value as StoredResource<NoteAttachmentI>;
          if (sourceIdSet.has(record.value.noteId || 0)) {
            const updated = { ...record.value, noteId: persistedMerged.id };
            updatedAttachments.push(updated);
            cursor.update({ ...record, value: updated } satisfies StoredResource<NoteAttachmentI>);
          }
          cursor.continue();
        } else finishScans();
      };
      const outboxCursor = outbox.index('partition').openCursor(IDBKeyRange.only(partition));
      outboxCursor.onerror = () => transaction.abort();
      outboxCursor.onsuccess = () => {
        const cursor = outboxCursor.result;
        if (cursor) {
          const queued = cursor.value as OutboxEntry;
          if (queued.type === 'note.merge') {
            const payload = queued.payload as { orderedSourceSyncIds?: string[] };
            if ((payload.orderedSourceSyncIds || []).some(syncId => sourceSyncIdSet.has(syncId))) {
              failure = new Error('A merge involving one or more source notes is already pending.');
              transaction.abort();
              return;
            }
          }
          if (queued.type === 'note.delete' && sourceSyncIdSet.has(queued.syncId)) {
            failure = new Error('A source note is already queued for permanent deletion.');
            transaction.abort();
            return;
          }
          cursor.continue();
        } else finishScans();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure || transaction.error || new Error('Could not persist the note merge and outbox entry.'));
      transaction.onabort = () => reject(failure || transaction.error || new Error('Note merge persistence was aborted.'));
    });
    return { note: persistedMerged, sourceNotes: updatedSources, keptReminder, removedReminderSyncIds, attachments: updatedAttachments, entry: persistedEntry };
  }

  async persistAttachmentUpload(
    partition: string,
    blobKey: string,
    blob: Blob,
    attachment: NoteAttachmentI,
    note: NoteI,
    payload: { noteSyncId: string; filename: string; syncId: string },
    stamp: LwwStamp
  ) {
    const noteSyncId = this.ensureNoteIdentity(note);
    if (!attachment.syncId) throw new Error('An attachment sync identity is required.');
    const entry: OutboxEntry = {
      key: `${partition}|${stamp.operationId}`,
      partition,
      operationId: stamp.operationId,
      type: 'attachment.upload',
      syncId: attachment.syncId,
      payload: { ...payload, noteSyncId, blobKey },
      lww: stamp,
      createdAt: Date.now(),
      deliveryState: 'unsent',
      attempts: 0
    };
    const db = await this.open();
    await this.transaction(db, ['blobs', 'attachments', 'notes', 'outbox'], 'readwrite', stores => {
      stores['blobs'].put({
        key: `${partition}|${blobKey}`,
        partition,
        blobKey,
        value: blob
      });
      stores['attachments'].put({
        key: this.resourceKey(partition, attachment.syncId!),
        partition,
        syncId: attachment.syncId,
        value: attachment
      });
      stores['notes'].put({
        key: this.resourceKey(partition, noteSyncId),
        partition,
        syncId: noteSyncId,
        value: note
      });
      stores['outbox'].put(entry);
    });
    return { note, attachment, entry };
  }

  async listOutbox(partition: string) {
    const priority: Record<SyncMutationType, number> = {
      'note.upsert': 0,
      'note.patch': 0,
      'note.delete': 7,
      'note.reorder': 2,
      'reminder.upsert': 3,
      'reminder.delete': 4,
      'note.merge': 5,
      'attachment.upload': 6,
      'attachment.delete': 8
    };
    return (await this.listByPartition<OutboxEntry>('outbox', partition)).sort((left, right) =>
      left.createdAt - right.createdAt ||
      priority[left.type] - priority[right.type] ||
      // Same-millisecond writes keep their creation order (hybrid logical clock).
      left.lww.physicalMs - right.lww.physicalMs ||
      left.lww.logical - right.lww.logical ||
      left.operationId.localeCompare(right.operationId)
    );
  }

  async getOutboxEntry(key: string) {
    const db = await this.open();
    return this.request<OutboxEntry | undefined>(db.transaction('outbox').objectStore('outbox').get(key));
  }

  /** Park a definitively rejected operation: it stays durable but is not resent until resolved. */
  async blockOutboxEntry(key: string, blocked: BlockedOperation) {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('outbox', 'readwrite');
      const outbox = transaction.objectStore('outbox');
      const request = outbox.get(key);
      request.onsuccess = () => {
        const entry = request.result as OutboxEntry | undefined;
        if (entry) outbox.put({ ...entry, blocked });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  /** Pin the base revision of a chained save so replays send an identical mutation. */
  async setGuardBaseRevision(key: string, baseRevision: number) {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('outbox', 'readwrite');
      const outbox = transaction.objectStore('outbox');
      const request = outbox.get(key);
      request.onsuccess = () => {
        const entry = request.result as OutboxEntry | undefined;
        if (entry?.guard && entry.deliveryState !== 'sent' && entry.guard.baseRevision == null) {
          outbox.put({ ...entry, guard: { ...entry.guard, baseRevision } });
        }
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async listBlockedOutbox(partition: string) {
    return (await this.listOutbox(partition)).filter(entry => !!entry.blocked);
  }

  /**
   * Replace a rejected save with a rebased one (new operation, new base) and
   * the cached note with the merged document, in one transaction. Operations
   * chained behind the replaced one now wait for its replacement.
   */
  async replaceRejectedNoteUpsert(partition: string, rejectedKey: string, note: NoteI, guard: NoteGuard, stamp: LwwStamp) {
    const syncId = this.ensureNoteIdentity(note);
    const persisted: NoteI = {
      ...note, syncId,
      lwwPhysicalMs: stamp.physicalMs, lwwLogical: stamp.logical, lwwDeviceId: stamp.deviceId, lwwOperationId: stamp.operationId
    };
    const entry: OutboxEntry = {
      key: `${partition}|${stamp.operationId}`,
      partition,
      operationId: stamp.operationId,
      type: 'note.upsert',
      syncId,
      payload: persisted,
      lww: stamp,
      createdAt: Date.now(),
      deliveryState: 'unsent',
      attempts: 0,
      guard
    };
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['notes', 'outbox'], 'readwrite');
      const notes = transaction.objectStore('notes');
      const outbox = transaction.objectStore('outbox');
      const rejectedRequest = outbox.get(rejectedKey);
      rejectedRequest.onerror = () => transaction.abort();
      rejectedRequest.onsuccess = () => {
        const rejected = rejectedRequest.result as OutboxEntry | undefined;
        if (!rejected) return; // resolved elsewhere (another tab); nothing to replace
        outbox.delete(rejectedKey);
        const cursor = outbox.index('partition').openCursor(IDBKeyRange.only(partition));
        cursor.onerror = () => transaction.abort();
        cursor.onsuccess = () => {
          const queued = cursor.result;
          if (queued) {
            const other = queued.value as OutboxEntry;
            if (other.guard?.after === rejected.operationId) {
              queued.update({ ...other, guard: { ...other.guard, after: entry.operationId } });
            }
            queued.continue();
            return;
          }
          notes.put({ key: this.resourceKey(partition, syncId), partition, syncId, value: persisted });
          outbox.put(entry);
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return { note: persisted, entry };
  }

  /**
   * Drop every not-yet-delivered or rejected full-document save for a note
   * (the user chose the server version) and cache the given note instead.
   */
  async discardPendingNoteUpserts(partition: string, syncId: string, replacement?: NoteI) {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['notes', 'outbox'], 'readwrite');
      const notes = transaction.objectStore('notes');
      const outbox = transaction.objectStore('outbox');
      const cursor = outbox.index('partition').openCursor(IDBKeyRange.only(partition));
      cursor.onerror = () => transaction.abort();
      cursor.onsuccess = () => {
        const queued = cursor.result;
        if (queued) {
          const entry = queued.value as OutboxEntry;
          if (entry.syncId === syncId && (entry.type === 'note.upsert' || entry.type === 'note.patch') && (entry.blocked || (entry.type === 'note.upsert' && entry.deliveryState === 'unsent'))) {
            queued.delete();
          }
          queued.continue();
          return;
        }
        if (replacement) notes.put({ key: this.resourceKey(partition, syncId), partition, syncId, value: replacement });
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async removeOutbox(keys: string[], acknowledged: ReadonlyArray<{ operationId: string; revision: number }> = []) {
    if (!keys.length) return;
    const db = await this.open();
    if (!acknowledged.length) {
      await this.transaction(db, ['outbox'], 'readwrite', stores => {
        keys.forEach(key => stores['outbox'].delete(key));
      });
      return;
    }
    // Completing an operation and advancing the accepted base of the saves chained
    // behind it is one step, so a successor never keeps a stale base.
    const revisions = new Map(acknowledged.map(item => [item.operationId, item.revision]));
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('outbox', 'readwrite');
      const outbox = transaction.objectStore('outbox');
      keys.forEach(key => outbox.delete(key));
      const cursor = outbox.openCursor();
      cursor.onerror = () => transaction.abort();
      cursor.onsuccess = () => {
        const queued = cursor.result;
        if (!queued) return;
        const entry = queued.value as OutboxEntry;
        const revision = entry.guard?.after ? revisions.get(entry.guard.after) : undefined;
        if (entry.guard && revision != null && !keys.includes(entry.key) && entry.deliveryState !== 'sent') {
          queued.update({ ...entry, guard: { ...entry.guard, baseRevision: revision } });
        }
        queued.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async claimOutboxForSend(keys: readonly string[]) {
    if (!keys.length) return [];
    const db = await this.open();
    return new Promise<OutboxEntry[]>((resolve, reject) => {
      const transaction = db.transaction('outbox', 'readwrite');
      const outbox = transaction.objectStore('outbox');
      const claimed: OutboxEntry[] = [];
      keys.forEach(key => {
        const request = outbox.get(key);
        request.onerror = () => transaction.abort();
        request.onsuccess = () => {
          const entry = request.result as OutboxEntry | undefined;
          if (entry) {
            const claimedEntry = entry.sentAt == null
              ? { ...entry, sentAt: Date.now(), deliveryState: 'sent' as const }
              : entry;
            if (claimedEntry !== entry) outbox.put(claimedEntry);
            claimed.push(claimedEntry);
          }
        };
      });
      transaction.oncomplete = () => resolve(claimed);
      transaction.onerror = () => reject(transaction.error || new Error('Could not claim outbox operations.'));
      transaction.onabort = () => reject(transaction.error || new Error('Outbox claim was aborted.'));
    });
  }

  async cancelPendingAttachmentUpload(partition: string, syncId: string) {
    const entries = await this.listOutbox(partition);
    const matches = entries.filter(entry => entry.type === 'attachment.upload' && entry.syncId === syncId);
    for (const entry of matches) {
      const blobKey = (entry.payload as { blobKey?: string })?.blobKey;
      if (blobKey) await this.deleteBlob(partition, blobKey);
    }
    await this.removeOutbox(matches.map(entry => entry.key));
    return matches.length > 0;
  }

  async putBlob(partition: string, blobKey: string, blob: Blob) {
    const db = await this.open();
    await this.request(db.transaction('blobs', 'readwrite').objectStore('blobs').put({
      key: `${partition}|${blobKey}`,
      partition,
      blobKey,
      value: blob
    }));
  }

  async getBlob(partition: string, blobKey: string) {
    const db = await this.open();
    const record = await this.request<{ value: Blob } | undefined>(
      db.transaction('blobs').objectStore('blobs').get(`${partition}|${blobKey}`)
    );
    return record?.value;
  }

  async cacheMedia(partition: string, canonicalUrl: string, requestUrl: string) {
    if (!canonicalUrl || canonicalUrl.startsWith('data:') || canonicalUrl.startsWith('blob:')) return;
    try {
      const response = await fetch(requestUrl);
      if (!response.ok) return;
      await this.putBlob(partition, `media:${canonicalUrl}`, await response.blob());
    } catch {}
  }

  async offlineMediaUrl(partition: string, canonicalUrl: string) {
    const existing = this.offlineMediaObjectMap().get(`${partition}|${canonicalUrl}`);
    if (existing) return existing;
    const blob = await this.getBlob(partition, `media:${canonicalUrl}`);
    if (!blob) return canonicalUrl;
    const objectUrl = URL.createObjectURL(blob);
    this.offlineMediaCanonicalMap().set(objectUrl, canonicalUrl);
    this.offlineMediaObjectMap().set(`${partition}|${canonicalUrl}`, objectUrl);
    return objectUrl;
  }

  canonicalMediaUrl(value: string) {
    return this.offlineMediaCanonicalMap().get(value) || value;
  }

  async deleteBlob(partition: string, blobKey: string) {
    const db = await this.open();
    await this.request(db.transaction('blobs', 'readwrite').objectStore('blobs').delete(`${partition}|${blobKey}`));
  }

  async getSyncState(partition: string): Promise<SyncState> {
    const db = await this.open();
    return (await this.request<SyncState | undefined>(db.transaction('syncState').objectStore('syncState').get(partition))) || {
      key: partition,
      partition,
      cursor: 0,
      serverOffsetMs: 0
    };
  }

  /**
   * The syncIds of the first notes the user saw, in display order. It lets the next start paint the top of
   * the collection from a few point reads instead of waiting for every stored note to be read. It lives
   * in the existing sync-state store under its own key, so the schema and rollback readability are unchanged.
   */
  async setDisplayWindow(partition: string, syncIds: readonly string[]) {
    const db = await this.open();
    await this.request(db.transaction('syncState', 'readwrite').objectStore('syncState').put({
      key: `${partition}|display-window`, partition, syncIds: [...syncIds], updatedAt: Date.now()
    }));
  }

  async getDisplayWindow(partition: string): Promise<string[]> {
    const db = await this.open();
    const record = await this.request<{ syncIds?: string[] } | undefined>(
      db.transaction('syncState').objectStore('syncState').get(`${partition}|display-window`)
    );
    return Array.isArray(record?.syncIds) ? record!.syncIds : [];
  }

  /** Point reads in one transaction, in the requested order, skipping notes that no longer exist. */
  async getNotesBySyncIds(partition: string, syncIds: readonly string[]) {
    if (!syncIds.length) return [];
    const db = await this.open();
    const store = db.transaction('notes').objectStore('notes');
    const records = await Promise.all(syncIds.map(syncId =>
      this.request<StoredResource<NoteI> | undefined>(store.get(this.resourceKey(partition, syncId)))));
    return records.flatMap(record => record ? [record.value] : []);
  }

  async setSyncState(partition: string, cursor: number, serverTime?: number) {
    const current = await this.getSyncState(partition);
    const next: SyncState = {
      ...current,
      cursor,
      serverOffsetMs: serverTime ? serverTime - Date.now() : current.serverOffsetMs
    };
    const db = await this.open();
    await this.request(db.transaction('syncState', 'readwrite').objectStore('syncState').put(next));
  }

  async putEditorSession(record: EditorSessionRecord) {
    const db = await this.openSessions();
    await this.request(db.transaction('sessions', 'readwrite').objectStore('sessions').put(record));
  }

  async getEditorSession(key: string) {
    const db = await this.openSessions();
    return this.request<EditorSessionRecord | undefined>(db.transaction('sessions').objectStore('sessions').get(key));
  }

  async listEditorSessions(partition: string) {
    const db = await this.openSessions();
    return this.request<EditorSessionRecord[]>(
      db.transaction('sessions').objectStore('sessions').index('partition').getAll(IDBKeyRange.only(partition))
    );
  }

  async deleteEditorSession(key: string) {
    const db = await this.openSessions();
    await this.request(db.transaction('sessions', 'readwrite').objectStore('sessions').delete(key));
  }

  /** True when the profile holds edits that were never delivered: queued operations or unsaved drafts. */
  async hasUnsyncedWork(partition: string) {
    const db = await this.open();
    const queued = await this.request<number>(
      db.transaction('outbox').objectStore('outbox').index('partition').count(IDBKeyRange.only(partition))
    );
    if (queued > 0) return true;
    const sessions = await this.listEditorSessions(partition).catch(() => [] as EditorSessionRecord[]);
    return sessions.some(session => session.dirtyFields.length > 0);
  }

  /** Revokes the object URLs minted for a partition's cached media so their blobs can be released. */
  releaseMediaUrls(partition: string) {
    const prefix = `${partition}|`;
    const objects = this.offlineMediaObjectMap();
    const canonical = this.offlineMediaCanonicalMap();
    for (const [key, objectUrl] of [...objects]) {
      if (!key.startsWith(prefix)) continue;
      objects.delete(key);
      canonical.delete(objectUrl);
      URL.revokeObjectURL(objectUrl);
    }
  }

  async purgePartition(partition: string) {
    this.releaseMediaUrls(partition);
    const db = await this.open();
    await Promise.all(
      ['notes', 'reminders', 'attachments', 'savedPlaces', 'outbox', 'blobs'].map(name => this.clearPartitionStore(db, name, partition))
    );
    await this.request(db.transaction('syncState', 'readwrite').objectStore('syncState').delete(partition));
    await this.request(db.transaction('syncState', 'readwrite').objectStore('syncState').delete(`${partition}|display-window`));
    const sessions = await this.openSessions().catch(() => undefined);
    if (sessions) await this.clearPartitionStore(sessions, 'sessions', partition);
  }

  private resourceKey(partition: string, syncId: string) {
    return `${partition}|${syncId}`;
  }

  private async putResource<T>(storeName: string, partition: string, syncId: string, value: T) {
    const db = await this.open();
    const record: StoredResource<T> = { key: this.resourceKey(partition, syncId), partition, syncId, value };
    await this.request(db.transaction(storeName, 'readwrite').objectStore(storeName).put(record));
  }

  private async getResourceValue<T>(storeName: string, partition: string, syncId: string) {
    const db = await this.open();
    const record = await this.request<StoredResource<T> | undefined>(
      db.transaction(storeName).objectStore(storeName).get(this.resourceKey(partition, syncId))
    );
    return record?.value;
  }

  private async deleteResource(storeName: string, partition: string, syncId: string) {
    const db = await this.open();
    await this.request(db.transaction(storeName, 'readwrite').objectStore(storeName).delete(this.resourceKey(partition, syncId)));
  }

  private async listValues<T>(storeName: string, partition: string) {
    const records = await this.listRecords<T>(storeName, partition);
    return records.map(record => record.value);
  }

  private async noteRecordsWithId(partition: string, id: number) {
    const db = await this.open();
    const records = await this.request<StoredResource<NoteI>[]>(
      db.transaction('notes').objectStore('notes').index('partitionAndId').getAll(IDBKeyRange.only([partition, id]))
    );
    return records.map(record => ({ key: record.key, syncId: record.syncId, value: record.value }));
  }

  private async notesWithId(partition: string, id: number) {
    return (await this.noteRecordsWithId(partition, id)).map(record => record.value);
  }

  private listRecords<T>(storeName: string, partition: string) {
    return this.listByPartition<StoredResource<T>>(storeName, partition);
  }

  private preferNote(left: NoteI, right: NoteI) {
    const leftStamp = Number(left.lwwPhysicalMs || Date.parse(left.updatedAt || '') || 0);
    const rightStamp = Number(right.lwwPhysicalMs || Date.parse(right.updatedAt || '') || 0);
    if (!!left.isCardPreview !== !!right.isCardPreview) {
      const full = left.isCardPreview ? right : left;
      const latest = rightStamp >= leftStamp ? right : left;
      return {
        ...latest,
        ...full,
        sortOrder: latest.sortOrder,
        pinned: latest.pinned,
        updatedAt: latest.updatedAt,
        lwwPhysicalMs: latest.lwwPhysicalMs,
        lwwLogical: latest.lwwLogical,
        lwwDeviceId: latest.lwwDeviceId,
        lwwOperationId: latest.lwwOperationId,
        isCardPreview: false
      };
    }
    if (rightStamp !== leftStamp) return rightStamp > leftStamp ? right : left;
    return { ...left, ...right };
  }

  private compareLwwStamp(left: LwwStamp, right: LwwStamp) {
    return left.physicalMs - right.physicalMs ||
      left.logical - right.logical ||
      left.deviceId.localeCompare(right.deviceId) ||
      left.operationId.localeCompare(right.operationId);
  }

  private applyPendingNotePatches(note: NoteI, syncId: string, entries: readonly OutboxEntry[]) {
    let value = note;
    for (const entry of entries) {
      const payload = entry.payload as { patch?: Partial<NoteI> };
      if (!payload.patch) continue;
      value = {
        ...value,
        ...payload.patch,
        id: note.id ?? value.id,
        revision: note.revision ?? value.revision,
        syncId
      };
    }
    return value;
  }

  private offlineMediaCanonicalMap(): Map<string, string> {
    const global = window as typeof window & { __keeparrOfflineMediaCanonical?: Map<string, string> };
    if (!global.__keeparrOfflineMediaCanonical) global.__keeparrOfflineMediaCanonical = new Map();
    return global.__keeparrOfflineMediaCanonical;
  }

  private offlineMediaObjectMap(): Map<string, string> {
    const global = window as typeof window & { __keeparrOfflineMediaObjects?: Map<string, string> };
    if (!global.__keeparrOfflineMediaObjects) global.__keeparrOfflineMediaObjects = new Map();
    return global.__keeparrOfflineMediaObjects;
  }

  private async listByPartition<T>(storeName: string, partition: string): Promise<T[]> {
    const db = await this.open();
    const index = db.transaction(storeName).objectStore(storeName).index('partition');
    return this.request<T[]>(index.getAll(IDBKeyRange.only(partition)));
  }

  private clearPartitionStore(db: IDBDatabase, storeName: string, partition: string) {
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.index('partition').openKeyCursor(IDBKeyRange.only(partition));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  private async open() {
    if (!this.database) {
      this.database = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.databaseName, this.databaseVersion);
        request.onupgradeneeded = () => {
          const db = request.result;
          for (const name of ['notes', 'reminders', 'attachments', 'savedPlaces', 'outbox', 'blobs']) {
            if (!db.objectStoreNames.contains(name)) {
              const store = db.createObjectStore(name, { keyPath: 'key' });
              store.createIndex('partition', 'partition', { unique: false });
              if (name === 'notes') store.createIndex('partitionAndId', ['partition', 'value.id'], { unique: false });
            }
          }
          const notes = request.transaction?.objectStore('notes');
          if (notes && !notes.indexNames.contains('partitionAndId')) {
            notes.createIndex('partitionAndId', ['partition', 'value.id'], { unique: false });
          }
          if (!db.objectStoreNames.contains('syncState')) db.createObjectStore('syncState', { keyPath: 'key' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this.database;
  }

  private openSessions() {
    if (!this.sessionDatabase) {
      this.sessionDatabase = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(this.sessionDatabaseName, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore('sessions', { keyPath: 'key' });
          store.createIndex('partition', 'partition', { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }).catch(error => {
        // Allow a later attempt to succeed (e.g. storage freed up).
        this.sessionDatabase = undefined;
        throw error;
      });
    }
    return this.sessionDatabase;
  }

  private request<T = unknown>(request: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private transaction(
    db: IDBDatabase,
    storeNames: string[],
    mode: IDBTransactionMode,
    work: (stores: Record<string, IDBObjectStore>) => void
  ) {
    return new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(storeNames, mode);
      const stores = Object.fromEntries(storeNames.map(name => [name, transaction.objectStore(name)]));
      let failure: unknown;
      // A write that throws (e.g. a value that cannot be cloned) must abort the whole
      // transaction; otherwise the writes before it would still commit.
      try {
        work(stores);
      } catch (error) {
        failure = error;
        try { transaction.abort(); } catch { /* already finished */ }
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(failure ?? transaction.error);
      transaction.onabort = () => reject(failure ?? transaction.error);
    });
  }

  /** Wrap an IndexedDB request handler so a thrown error aborts its transaction instead of surfacing as an uncaught error. */
  private abortOnThrow(transaction: IDBTransaction, handler: () => void, fail: (error: unknown) => void) {
    return () => {
      try {
        handler();
      } catch (error) {
        fail(error);
        try { transaction.abort(); } catch { /* already finished */ }
      }
    };
  }
}
