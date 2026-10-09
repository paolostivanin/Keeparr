import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { BehaviorSubject, firstValueFrom, Subject } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';
import { CalDavSettingsI, GoogleCalendarStatusI, IcsFeedI, ReminderFiredPayload, ReminderI, ReminderRepeatRule, ReminderStatus } from '../interfaces/reminder';
import { PushNotificationService } from './push-notification.service';
import { OfflineStoreService } from './offline-store.service';
import { OfflineSyncService } from './offline-sync.service';
import { NoteI } from '../interfaces/notes';
import { UserPreferencesService } from './user-preferences.service';
import { planNoteOrder } from '../utils/note-order';
import { nextRepeatDueAt } from '../utils/reminder-recurrence';

type ReminderCreateData = {
  noteId?: number;
  noteSyncId?: string;
  dueAtUtc?: string;
  timezone?: string;
  title?: string;
  body?: string;
  imageUrl?: string;
  repeatRule?: string | ReminderRepeatRule | null;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  locationTrigger?: 'arrive' | 'leave';
};

type ReminderUpdateData = {
  status?: ReminderStatus;
  dueAtUtc?: string;
  repeatRule?: string | ReminderRepeatRule | null;
  locationName?: string;
  latitude?: number;
  longitude?: number;
  radiusMeters?: number;
  locationTrigger?: 'arrive' | 'leave';
};

type AndroidLocationPermissionStatus = {
  foregroundGranted: boolean;
  backgroundGranted: boolean;
  status: 'granted' | 'foregroundOnly' | 'denied' | 'notDetermined';
};

type AndroidNotificationPermissionStatus = {
  granted: boolean;
  status: 'granted' | 'denied' | 'notDetermined';
};

type AndroidNativeGeofenceReminder = {
  id: string;
  noteId: string;
  savedPlaceId?: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  triggerType: 'arrive' | 'leave';
  status: 'pending';
  notificationTitle: string;
  notificationBody: string;
  deepLink: string;
  createdAt: string;
  updatedAt: string;
};

type AndroidTriggeredGeofenceEvent = {
  eventId: string;
  reminderId: string;
  noteId: string;
  transitionType: 'arrive' | 'leave' | 'dwell';
  triggeredAt: number;
};

interface KeeparrGeofencePlugin {
  getPermissionStatus(): Promise<AndroidLocationPermissionStatus>;
  requestForegroundLocationPermission(): Promise<AndroidLocationPermissionStatus>;
  openBackgroundLocationSettings(): Promise<void>;
  getNotificationPermissionStatus(): Promise<AndroidNotificationPermissionStatus>;
  requestNotificationPermission(): Promise<AndroidNotificationPermissionStatus>;
  syncGeofences(input: { reminders: AndroidNativeGeofenceReminder[] }): Promise<{
    registered: string[];
    failed: { reminderId: string; reason: string }[];
  }>;
  registerGeofence(reminder: AndroidNativeGeofenceReminder): Promise<void>;
  unregisterGeofence(input: { reminderId: string }): Promise<void>;
  getPendingTriggeredEvents(): Promise<{ events: AndroidTriggeredGeofenceEvent[] }>;
  acknowledgeTriggeredEvents(input: { eventIds: string[] }): Promise<void>;
}

const isAndroid = Capacitor.getPlatform() === 'android';
const KeeparrGeofence = isAndroid ? registerPlugin<KeeparrGeofencePlugin>('KeeparrGeofence') : null;

@Injectable({ providedIn: 'root' })
export class ReminderService {
  reminders$ = new BehaviorSubject<ReminderI[]>([]);
  firedReminder$ = new Subject<ReminderFiredPayload>();

  private readonly apiUrl = environment.apiUrl;
  private reminderTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private androidGeofenceSyncQueued = false;
  private androidGeofenceSyncRunning = false;
  private androidTriggeredEventsRunning = false;
  private androidResumeHandler?: () => void;
  private androidFocusHandler?: () => void;
  private inactiveNoteIds = new Set<number>();
  private displayedNotifications = new Map<number, Notification>();
  private lifecycleUserId?: number;
  private readonly reminderTimerChunkMs = 24 * 60 * 60 * 1000;

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private push: PushNotificationService,
    private offlineStore: OfflineStoreService,
    private offlineSync: OfflineSyncService,
    private userPreferences: UserPreferencesService
  ) {
    this.offlineSync.cacheChanged$.subscribe(change => {
      if (!change.remindersChanged) return;
      if (change.fullSnapshot || (!change.reminderSyncIds?.length && !change.removedReminderSyncIds?.length)) {
        this.loadCachedReminders().catch(console.error);
      } else {
        this.applyCachedReminderChanges(change.reminderSyncIds || [], change.removedReminderSyncIds || []).catch(console.error);
      }
    });
    this.auth.currentUser$.subscribe(user => {
      if (user?.id !== this.lifecycleUserId) {
        this.inactiveNoteIds.clear();
        this.lifecycleUserId = user?.id;
      }
      if (user) {
        this.loadCachedReminders().catch(console.error);
        this.load().catch(console.error);
      }
      else this.setReminders([]);
    });
    this.listenForServiceWorkerMessages();
    this.listenForAndroidResume();
  }

  async load() {
    // The response belongs to the profile that requested it; a slow request must not show or cache it for the next one.
    const partition = this.offlineSync.partition;
    try {
      const reminders = await firstValueFrom(
        this.http.get<ReminderI[]>(`${this.apiUrl}/reminders`, { headers: this.auth.authHeaders() })
      );
      if (this.offlineSync.partition !== partition) return;
      if (partition) {
        for (const reminder of reminders) {
          if (this.offlineSync.partition !== partition) return;
          await this.offlineStore.putReminder(partition, reminder);
        }
        if (this.offlineSync.partition !== partition) return;
      }
      this.setReminders(reminders);
      this.offlineSync.syncNow({ bootstrapIfEmpty: true }).catch(console.error);
    } catch (error) {
      await this.loadCachedReminders();
      if (navigator.onLine) throw error;
    }
  }

  async create(data: ReminderCreateData) {
    if (data.noteId && data.noteId < 0 && this.offlineSync.partition) {
      const note = await this.offlineStore.getNote(this.offlineSync.partition, data.noteId);
      data = { ...data, noteSyncId: note?.syncId };
    }
    const payload = { ...data, repeatRule: this.serializeRepeatRule(data.repeatRule) };
    const now = new Date().toISOString();
    let localId = -Date.now();
    if (this.offlineSync.partition) {
      const reminders = await this.offlineStore.listReminders(this.offlineSync.partition);
      const usedIds = new Set(reminders.map(reminder => reminder.id));
      while (usedIds.has(localId)) localId -= 1;
    }
    const local = {
      ...data,
      id: localId,
      userId: this.auth.currentUser?.id || 0,
      dueAtUtc: data.dueAtUtc || null,
      timezone: data.timezone || 'UTC',
      repeatRule: this.serializeRepeatRule(data.repeatRule),
      status: 'pending' as ReminderStatus,
      title: data.title || null,
      body: data.body || null,
      imageUrl: data.imageUrl || null,
      locationName: data.locationName || null,
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      radiusMeters: data.radiusMeters ?? null,
      locationTrigger: data.locationTrigger || 'arrive',
      createdAt: now,
      updatedAt: now
    } as ReminderI & { noteSyncId?: string };
    this.offlineStore.ensureReminderIdentity(local);
    if (this.offlineSync.partition) await this.offlineStore.putReminder(this.offlineSync.partition, local);
    this.setReminders([local, ...this.reminders$.value.filter(item => item.noteId !== local.noteId)]);
    if (!navigator.onLine || (data.noteId || 0) < 0) {
      await this.offlineSync.enqueue('reminder.upsert', local.syncId!, local);
      return local;
    }
    try {
      const reminder = await firstValueFrom(
        this.http.post<ReminderI>(`${this.apiUrl}/reminders`, { ...payload, syncId: local.syncId }, { headers: this.auth.authHeaders() })
      );
      if (this.offlineSync.partition) await this.offlineStore.putReminder(this.offlineSync.partition, reminder);
      await this.load();
      return reminder;
    } catch (error: any) {
      if (!navigator.onLine || error?.status === 0) {
        await this.offlineSync.enqueue('reminder.upsert', local.syncId!, local);
        return local;
      }
      console.warn('Reminder create failed (non-fatal):', error?.message || error);
      return null;
    }
  }

  async update(id: number, data: ReminderUpdateData) {
    const payload: ReminderUpdateData = { ...data };
    if (Object.prototype.hasOwnProperty.call(data, 'repeatRule')) {
      payload.repeatRule = this.serializeRepeatRule(data.repeatRule);
    }
    const existing = this.reminders$.value.find(reminder => reminder.id === id);
    if (existing) {
      const local: ReminderI = { ...existing, ...payload, repeatRule: payload.repeatRule === undefined ? existing.repeatRule : payload.repeatRule as string | null, updatedAt: new Date().toISOString() };
      if (this.offlineSync.partition) await this.offlineStore.putReminder(this.offlineSync.partition, local);
      this.setReminders(this.reminders$.value.map(reminder => reminder.id === id ? local : reminder));
      if (id < 0 || !navigator.onLine) {
        await this.offlineSync.enqueue('reminder.upsert', local.syncId!, local);
        return local;
      }
    }
    let reminder: ReminderI;
    try {
      reminder = await firstValueFrom(
        this.http.patch<ReminderI>(`${this.apiUrl}/reminders/${id}`, payload, { headers: this.auth.authHeaders() })
      );
    } catch (error) {
      // navigator.onLine stays true when the network is up but the server is not. The change is already in the local
      // cache, so keep it durable and let the outbox deliver it instead of losing it on the next refresh.
      const local = this.reminders$.value.find(item => item.id === id);
      if (this.isUnreachable(error) && local?.syncId) {
        await this.offlineSync.enqueue('reminder.upsert', local.syncId, local);
        return local;
      }
      throw error;
    }
    await this.load();
    return reminder;
  }

  /** No answer from the server: the connection failed (0) or a reverse proxy in front of it reported that it is down. */
  private isUnreachable(error: unknown) {
    const status = (error as { status?: number } | null)?.status;
    return status === 0 || status === 502 || status === 503 || status === 504;
  }

  async delete(id: number) {
    const existing = this.reminders$.value.find(reminder => reminder.id === id);
    if (existing?.syncId && this.offlineSync.partition) {
      await this.offlineStore.deleteReminder(this.offlineSync.partition, existing.syncId);
      this.setReminders(this.reminders$.value.filter(reminder => reminder.id !== id));
    }
    if (id < 0 || !navigator.onLine) {
      if (existing?.syncId) await this.offlineSync.enqueue('reminder.delete', existing.syncId, existing);
      return;
    }
    try {
      await firstValueFrom(
        this.http.delete(`${this.apiUrl}/reminders/${id}`, { headers: this.auth.authHeaders() })
      );
    } catch (error) {
      // Removed locally above; deliver the removal once the server is reachable again.
      if (this.isUnreachable(error) && existing?.syncId) {
        await this.offlineSync.enqueue('reminder.delete', existing.syncId, existing);
        return;
      }
      throw error;
    }
    await this.load();
  }

  private async loadCachedReminders() {
    if (!this.offlineSync.partition) return;
    const reminders = await this.offlineStore.listReminders(this.offlineSync.partition);
    this.setReminders(reminders);
  }

  private async applyCachedReminderChanges(syncIds: readonly string[], removedSyncIds: readonly string[]) {
    const partition = this.offlineSync.partition;
    if (!partition) return;
    const removed = new Set(removedSyncIds);
    const next = this.reminders$.value.filter(reminder => !removed.has(reminder.syncId || ''));
    let changed = next.length !== this.reminders$.value.length;
    for (const syncId of syncIds) {
      const reminder = await this.offlineStore.getReminder(partition, syncId);
      const index = next.findIndex(candidate => candidate.syncId === syncId);
      if (!reminder) {
        if (index >= 0) {
          next.splice(index, 1);
          changed = true;
        }
      } else if (index < 0) {
        next.push(reminder);
        changed = true;
      } else if (JSON.stringify(next[index]) !== JSON.stringify(reminder)) {
        next[index] = reminder;
        changed = true;
      }
    }
    if (changed) this.setReminders(next);
  }

  getActiveForNote(noteId: number): ReminderI | undefined {
    return this.reminders$.value.find(r => r.noteId === noteId && r.status === 'pending');
  }

  getFiredForNote(noteId: number): ReminderI | undefined {
    return this.reminders$.value.find(r => r.noteId === noteId && r.status === 'fired');
  }

  updateNoteLifecycle(notes: Array<{ id?: number; archived?: boolean; trashed?: boolean }>) {
    let changed = false;
    for (const note of notes) {
      const noteId = Number(note.id || 0);
      if (!noteId) continue;
      const inactive = !!note.archived || !!note.trashed;
      if (inactive && !this.inactiveNoteIds.has(noteId)) {
        this.inactiveNoteIds.add(noteId);
        this.cancelReminderTimersForNote(noteId);
        this.closeDisplayedNotificationsForNote(noteId).catch(console.error);
        changed = true;
      } else if (!inactive && this.inactiveNoteIds.delete(noteId)) {
        changed = true;
      }
    }
    if (changed) {
      this.schedulePendingReminders(this.reminders$.value);
      this.syncAndroidGeofences(this.reminders$.value);
    }
  }

  markNoteInactive(noteId: number) {
    if (!noteId) return;
    this.inactiveNoteIds.add(noteId);
    this.cancelReminderTimersForNote(noteId);
    this.closeDisplayedNotificationsForNote(noteId).catch(console.error);
    this.syncAndroidGeofences(this.reminders$.value);
  }

  async refreshNoteContent(note: NoteI) {
    if (!note.id || note.locked) return;
    const matching = this.reminders$.value.filter(reminder => reminder.noteId === note.id);
    if (!matching.length) return;
    const title = this.plainText(note.noteTitle || '');
    const bodyText = this.plainText(note.noteBody || '');
    const checklistText = (note.checkBoxes || [])
      .map(item => this.plainText(item.data || ''))
      .filter(Boolean)
      .join(' ');
    const body = (bodyText || checklistText).slice(0, 500);

    const changedIds = new Set<number>();
    const now = new Date().toISOString();
    const next = this.reminders$.value.map(reminder => {
      if (reminder.noteId !== note.id || ((reminder.title || '') === title && (reminder.body || '') === body)) return reminder;
      changedIds.add(reminder.id);
      return { ...reminder, title: title || null, body: body || null, updatedAt: now };
    });
    if (!changedIds.size) return;

    if (this.offlineSync.partition) {
      for (const reminder of next) {
        if (changedIds.has(reminder.id)) await this.offlineStore.putReminder(this.offlineSync.partition, reminder);
      }
    }
    this.setReminders(next);
  }

  trackDisplayedNotification(reminderId: number, notification: Notification) {
    if (!reminderId) return;
    this.displayedNotifications.get(reminderId)?.close();
    this.displayedNotifications.set(reminderId, notification);
    notification.addEventListener('close', () => {
      if (this.displayedNotifications.get(reminderId) === notification) this.displayedNotifications.delete(reminderId);
    }, { once: true });
  }

  handleFired(payload: ReminderFiredPayload) {
    const reminder = this.reminders$.value.find(r => r.id === payload.reminderId);
    if (reminder?.status === 'fired') return;
    this.firedReminder$.next(payload);
    const repeat = this.parseRepeatRule(reminder?.repeatRule);
    if (this.isRepeatingRule(repeat)) {
      this.load().catch(console.error);
      return;
    }
    const updated = this.reminders$.value.map(r =>
      r.id === payload.reminderId ? { ...r, status: 'fired' as ReminderStatus } : r
    );
    this.setReminders(updated);
  }

  async dismissFiredReminder(reminderId: number) {
    const reminder = this.reminders$.value.find(r => r.id === reminderId);
    if (this.isRepeatingRule(this.parseRepeatRule(reminder?.repeatRule))) {
      if (navigator.onLine) await this.load().catch(console.error);
      return reminder || null;
    }
    if (this.userPreferences.value.showPastReminders) {
      return reminder || null;
    }
    return this.update(reminderId, { status: 'dismissed' });
  }

  debugFireReminder(title = 'Debug reminder', body = 'This is a manual test reminder.') {
    this.firedReminder$.next({
      reminderId: -Date.now(),
      noteId: null,
      title,
      body,
      imageUrl: null
    });
  }

  requestBrowserNotifications() {
    this.push.ensureSubscribed().catch(console.error);
  }

  /**
   * Call from inside a user-gesture handler (click) to request notification
   * permission. Required for iOS Safari, which only allows the prompt
   * synchronously from a gesture. Resolves when the permission decision is made.
   */
  async requestNotificationPermissionInGesture() {
    return this.push.requestPermissionFromGesture();
  }

  async ensureAndroidLocationReminderPermissions(): Promise<boolean> {
    if (!this.isAndroidGeofenceAvailable()) return true;
    try {
      let location = await KeeparrGeofence!.getPermissionStatus();
      if (!location.foregroundGranted) {
        location = await KeeparrGeofence!.requestForegroundLocationPermission();
      }
      if (!location.foregroundGranted) return false;

      if (!location.backgroundGranted) {
        return false;
      }

      let notifications = await KeeparrGeofence!.getNotificationPermissionStatus();
      if (!notifications.granted) {
        notifications = await KeeparrGeofence!.requestNotificationPermission();
      }
      return notifications.granted;
    } catch (error) {
      console.warn('Android location reminder permissions failed', error);
      this.showSnackbar('Location reminder permissions could not be checked.', 4500);
      return false;
    }
  }

  async getAndroidLocationPermissionStatus(): Promise<AndroidLocationPermissionStatus | null> {
    if (!this.isAndroidGeofenceAvailable()) return null;
    return KeeparrGeofence!.getPermissionStatus();
  }

  async requestAndroidForegroundLocationPermission(): Promise<AndroidLocationPermissionStatus | null> {
    if (!this.isAndroidGeofenceAvailable()) return null;
    return KeeparrGeofence!.requestForegroundLocationPermission();
  }

  async openAndroidBackgroundLocationSettings(): Promise<void> {
    if (!this.isAndroidGeofenceAvailable()) return;
    await KeeparrGeofence!.openBackgroundLocationSettings();
  }

  async ensureAndroidGeofenceNotificationPermission(): Promise<boolean> {
    if (!this.isAndroidGeofenceAvailable()) return true;
    let notifications = await KeeparrGeofence!.getNotificationPermissionStatus();
    if (!notifications.granted) {
      notifications = await KeeparrGeofence!.requestNotificationPermission();
    }
    return notifications.granted;
  }

  iosNeedsHomeScreenInstall() {
    return this.push.iosNeedsHomeScreenInstall();
  }

  isIos() { return this.push.isIos(); }
  isStandalone() { return this.push.isStandalone(); }

  private setReminders(reminders: ReminderI[]) {
    this.reminders$.next(reminders);
    this.schedulePendingReminders(reminders);
    this.syncAndroidGeofences(reminders);
    this.processAndroidTriggeredEvents();
  }

  private schedulePendingReminders(reminders: ReminderI[]) {
    this.reminderTimers.forEach(timer => clearTimeout(timer));
    this.reminderTimers.clear();

    reminders
      .filter(reminder => reminder.status === 'pending' && reminder.dueAtUtc && !this.inactiveNoteIds.has(Number(reminder.noteId)))
      .forEach(reminder => {
        const dueAt = new Date(reminder.dueAtUtc!).getTime();
        if (!Number.isFinite(dueAt)) return;
        const dueIn = dueAt - Date.now();
        const delay = Math.max(0, Math.min(dueIn, this.reminderTimerChunkMs));
        const timer = setTimeout(() => this.handleReminderTimer(reminder.id), delay);
        this.reminderTimers.set(reminder.id, timer);
      });
  }

  private handleReminderTimer(reminderId: number) {
    const reminder = this.reminders$.value.find(r => r.id === reminderId);
    if (!reminder || reminder.status !== 'pending' || !reminder.dueAtUtc) {
      this.reminderTimers.delete(reminderId);
      return;
    }

    const dueAt = new Date(reminder.dueAtUtc).getTime();
    if (!Number.isFinite(dueAt)) {
      this.reminderTimers.delete(reminderId);
      return;
    }

    const dueIn = dueAt - Date.now();
    if (dueIn > 0) {
      const delay = Math.min(dueIn, this.reminderTimerChunkMs);
      const timer = setTimeout(() => this.handleReminderTimer(reminderId), delay);
      this.reminderTimers.set(reminderId, timer);
      return;
    }

    this.fireLocalReminder(reminderId);
  }

  private cancelReminderTimersForNote(noteId: number) {
    for (const reminder of this.reminders$.value) {
      if (reminder.noteId !== noteId) continue;
      const timer = this.reminderTimers.get(reminder.id);
      if (timer) clearTimeout(timer);
      this.reminderTimers.delete(reminder.id);
    }
  }

  private async closeDisplayedNotificationsForNote(noteId: number) {
    const reminderIds = new Set(
      this.reminders$.value
        .filter(reminder => reminder.noteId === noteId)
        .map(reminder => reminder.id)
    );
    for (const reminderId of reminderIds) {
      this.displayedNotifications.get(reminderId)?.close();
      this.displayedNotifications.delete(reminderId);
    }

    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      const getNotifications = (registration as any).getNotifications;
      if (typeof getNotifications !== 'function') continue;
      const notifications: Notification[] = await getNotifications.call(registration);
      notifications.forEach(notification => {
        const notificationReminderId = Number(notification.data?.reminderId || 0);
        const notificationNoteId = Number(notification.data?.noteId || 0);
        if (notificationNoteId === noteId || reminderIds.has(notificationReminderId)) notification.close();
      });
    }
  }

  private plainText(value: string) {
    if (typeof document !== 'undefined') {
      const div = document.createElement('div');
      div.innerHTML = value;
      return (div.textContent || '').replace(/\s+/g, ' ').trim();
    }
    return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private async fireLocalReminder(reminderId: number) {
    this.reminderTimers.delete(reminderId);
    const reminder = this.reminders$.value.find(r => r.id === reminderId);
    if (!reminder || reminder.status !== 'pending') return;
    const repeat = this.parseRepeatRule(reminder.repeatRule);
    let nextDueAtUtc: string | null = null;
    if (repeat) {
      try {
        nextDueAtUtc = nextRepeatDueAt(reminder.dueAtUtc, repeat, reminder.timezone, Date.now(), (reminder as ReminderI & { scheduleAnchorAtUtc?: string }).scheduleAnchorAtUtc || reminder.dueAtUtc);
      } catch (error) {
        // An unresolvable schedule must not stop this occurrence from being shown.
        console.error('Could not compute the next reminder occurrence', error);
      }
    }

    this.firedReminder$.next({
      reminderId: reminder.id,
      noteId: reminder.noteId,
      title: reminder.title,
      body: reminder.body,
      imageUrl: reminder.imageUrl,
      source: 'local'
    });

    if (repeat && nextDueAtUtc) {
      const local = { ...reminder, dueAtUtc: nextDueAtUtc, status: 'pending' as ReminderStatus, updatedAt: new Date().toISOString() };
      if (this.offlineSync.partition) await this.offlineStore.putReminder(this.offlineSync.partition, local);
      this.setReminders(this.reminders$.value.map(r => r.id === reminderId ? local : r));
      if (repeat.moveToTopOnTrigger) await this.floatNoteToTop(reminder.noteId).catch(console.error);
      this.update(reminderId, { dueAtUtc: nextDueAtUtc, status: 'pending', repeatRule: reminder.repeatRule }).catch(console.error);
      return;
    }

    if (repeat?.moveToTopOnTrigger) await this.floatNoteToTop(reminder.noteId).catch(console.error);

    this.setReminders(this.reminders$.value.map(r =>
      r.id === reminderId ? { ...r, status: 'fired' as ReminderStatus } : r
    ));
    this.update(reminderId, { status: 'fired' }).catch(console.error);
  }

  private parseRepeatRule(value: string | ReminderRepeatRule | null | undefined): ReminderRepeatRule | null {
    if (!value) return null;
    let parsed: any = value;
    if (typeof value === 'string') {
      try { parsed = JSON.parse(value); } catch { return null; }
    }
    const type = parsed?.type;
    if (!['none', 'daily', 'weekly', 'monthly', 'custom_days'].includes(type)) return null;
    const intervalDays = Number(parsed.intervalDays || 0);
    if (type === 'none' && !parsed.moveToTopOnTrigger) return null;
    return {
      type,
      intervalDays: type === 'custom_days' && Number.isFinite(intervalDays) && intervalDays > 0 ? Math.floor(intervalDays) : undefined,
      moveToTopOnTrigger: !!parsed.moveToTopOnTrigger
    };
  }

  private serializeRepeatRule(value: string | ReminderRepeatRule | null | undefined) {
    const parsed = this.parseRepeatRule(value);
    return parsed ? JSON.stringify(parsed) : null;
  }

  private isRepeatingRule(repeat: ReminderRepeatRule | null) {
    return !!repeat && repeat.type !== 'none';
  }

  private async floatNoteToTop(noteId: number | null) {
    if (!noteId || !this.offlineSync.partition) return;
    const notes = await this.offlineStore.listNotes(this.offlineSync.partition);
    const note = notes.find(item => item.id === noteId);
    if (!note?.syncId) return;
    const sorted = notes
      .filter(item => item.id && item.syncId && item.id !== noteId)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Number(b.sortOrder || 0) - Number(a.sortOrder || 0));
    const ids = [noteId, ...sorted.map(item => item.id!)];
    const byId = new Map(notes.map(item => [item.id!, item]));
    // Only the floated note (and anything it must be reordered against) gets a new position.
    const plan = planNoteOrder({
      desired: ids,
      current: new Map(ids.map(id => [id, Number(byId.get(id)?.sortOrder || 0)])),
      pinned: new Set(ids.filter(id => byId.get(id)?.pinned))
    });
    if (!plan.length) return;
    for (const [id, sortOrder] of plan) {
      const current = byId.get(id);
      if (!current?.syncId) continue;
      await this.offlineStore.putNote(this.offlineSync.partition, { ...current, sortOrder, updatedAt: new Date().toISOString() });
    }
    await this.offlineSync.enqueue('note.reorder', `order-${this.auth.currentUser?.id || 0}`, {
      syncIds: ids.map(id => byId.get(id)?.syncId).filter(Boolean),
      positions: plan.filter(([id]) => byId.get(id)?.syncId).map(([id, sortOrder]) => ({ syncId: byId.get(id)!.syncId!, sortOrder }))
    });
  }

  private listenForServiceWorkerMessages() {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data?.type === 'push-reminder-fired' && event.data.payload) {
        this.handleFired({ ...event.data.payload, source: 'sw-push' });
      }
    });
  }

  private listenForAndroidResume() {
    if (!this.isAndroidGeofenceAvailable() || typeof document === 'undefined') return;
    this.androidResumeHandler = () => {
      if (document.visibilityState === 'visible') {
        this.load().catch(console.error);
      }
    };
    this.androidFocusHandler = () => {
      this.load().catch(console.error);
    };
    document.addEventListener('visibilitychange', this.androidResumeHandler);
    window.addEventListener('focus', this.androidFocusHandler);
  }

  private isAndroidGeofenceAvailable() {
    return isAndroid && !!KeeparrGeofence;
  }

  private nativeLocationReminders(reminders: ReminderI[]): AndroidNativeGeofenceReminder[] {
    return reminders
      .filter(r =>
        r.status === 'pending' &&
        r.noteId &&
        !this.inactiveNoteIds.has(Number(r.noteId)) &&
        r.locationName &&
        r.latitude != null &&
        r.longitude != null
      )
      .map(r => ({
        id: String(r.id),
        noteId: String(r.noteId),
        savedPlaceId: r.savedPlaceId ? String(r.savedPlaceId) : undefined,
        latitude: Number(r.latitude),
        longitude: Number(r.longitude),
        radiusMeters: Number(r.radiusMeters ?? 120),
        triggerType: r.locationTrigger === 'leave' ? 'leave' : 'arrive',
        status: 'pending',
        notificationTitle: r.title || 'Keeparr reminder',
        notificationBody: r.body || '',
        deepLink: `keeparr://note/${r.noteId}`,
        createdAt: r.createdAt || '',
        updatedAt: r.updatedAt || '',
      }));
  }

  private syncAndroidGeofences(reminders: ReminderI[]) {
    if (!this.isAndroidGeofenceAvailable()) return;
    if (this.androidGeofenceSyncRunning) {
      this.androidGeofenceSyncQueued = true;
      return;
    }
    this.androidGeofenceSyncRunning = true;
    const nativeReminders = this.nativeLocationReminders(reminders);
    KeeparrGeofence!.syncGeofences({ reminders: nativeReminders })
      .then(result => {
        if (result.failed?.length) {
          console.warn('Some Android geofences failed to sync', result.failed);
        }
      })
      .catch(error => console.warn('Android geofence sync failed', error))
      .finally(() => {
        this.androidGeofenceSyncRunning = false;
        if (this.androidGeofenceSyncQueued) {
          this.androidGeofenceSyncQueued = false;
          this.syncAndroidGeofences(this.reminders$.value);
        }
      });
  }

  private async processAndroidTriggeredEvents() {
    if (!this.isAndroidGeofenceAvailable() || this.androidTriggeredEventsRunning) return;
    this.androidTriggeredEventsRunning = true;
    try {
      const response = await KeeparrGeofence!.getPendingTriggeredEvents();
      const events = response.events || [];
      if (!events.length) return;

      const acknowledged: string[] = [];
      for (const event of events) {
        const reminderId = Number(event.reminderId);
        if (!Number.isFinite(reminderId)) continue;
        try {
          await this.update(reminderId, { status: 'fired' });
          acknowledged.push(event.eventId);
        } catch (error) {
          console.warn('Could not mark Android geofence reminder fired', event, error);
        }
      }
      if (acknowledged.length) {
        await this.load();
        await KeeparrGeofence!.acknowledgeTriggeredEvents({ eventIds: acknowledged });
      }
    } catch (error) {
      console.warn('Android geofence triggered event handling failed', error);
    } finally {
      this.androidTriggeredEventsRunning = false;
    }
  }

  private showSnackbar(text: string, duration = 4500) {
    try {
      (window as any).Snackbar?.show({ pos: 'bottom-left', text, duration });
    } catch {}
  }

  // ── CalDAV ──────────────────────────────────────────────────────────────

  async getCalDavSettings(): Promise<CalDavSettingsI | null> {
    return await firstValueFrom(
      this.http.get<CalDavSettingsI | null>(`${this.apiUrl}/caldav/settings`, { headers: this.auth.authHeaders() })
    );
  }

  async saveCalDavSettings(data: CalDavSettingsI & { password: string }): Promise<CalDavSettingsI> {
    return await firstValueFrom(
      this.http.put<CalDavSettingsI>(`${this.apiUrl}/caldav/settings`, data, { headers: this.auth.authHeaders() })
    );
  }

  async deleteCalDavSettings() {
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}/caldav/settings`, { headers: this.auth.authHeaders() })
    );
  }

  async testCalDavConnection(data: { calendarUrl: string; username: string; password: string }) {
    return await firstValueFrom(
      this.http.post<{ ok: boolean; httpStatus?: number; error?: string }>(
        `${this.apiUrl}/caldav/test`, data, { headers: this.auth.authHeaders() }
      )
    );
  }

  async importIcs(icsContent: string) {
    return await firstValueFrom(
      this.http.post<{ imported: number }>(
        `${this.apiUrl}/reminders/import`, { icsContent }, { headers: this.auth.authHeaders() }
      )
    );
  }

  // ── ICS Feed ─────────────────────────────────────────────────────────────

  async getIcsFeedToken(): Promise<IcsFeedI> {
    return await firstValueFrom(
      this.http.get<IcsFeedI>(`${this.apiUrl}/reminders/ics-token`, { headers: this.auth.authHeaders() })
    );
  }

  async regenerateIcsFeedToken(): Promise<IcsFeedI> {
    return await firstValueFrom(
      this.http.post<IcsFeedI>(`${this.apiUrl}/reminders/ics-token`, {}, { headers: this.auth.authHeaders() })
    );
  }

  // ── Google Calendar ───────────────────────────────────────────────────────

  async getGoogleCalendarStatus(): Promise<GoogleCalendarStatusI> {
    return await firstValueFrom(
      this.http.get<GoogleCalendarStatusI>(`${this.apiUrl}/google-calendar/status`, { headers: this.auth.authHeaders() })
    );
  }

  async saveGoogleCredentials(data: { clientId: string; clientSecret: string; enabled: boolean }): Promise<void> {
    await firstValueFrom(
      this.http.put(`${this.apiUrl}/google-calendar/credentials`, data, { headers: this.auth.authHeaders() })
    );
  }

  async initiateGoogleAuth(): Promise<{ url: string }> {
    return await firstValueFrom(
      this.http.post<{ url: string }>(`${this.apiUrl}/auth/google/initiate`, {}, { headers: this.auth.authHeaders() })
    );
  }

  async disconnectGoogleCalendar(): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}/google-calendar/disconnect`, { headers: this.auth.authHeaders() })
    );
  }

  async removeGoogleCredentials(): Promise<void> {
    await firstValueFrom(
      this.http.delete(`${this.apiUrl}/google-calendar/credentials`, { headers: this.auth.authHeaders() })
    );
  }
}
