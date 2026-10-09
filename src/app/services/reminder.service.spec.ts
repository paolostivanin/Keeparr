import { BehaviorSubject, Subject, throwError } from 'rxjs';
import { ReminderService } from './reminder.service';
import { ReminderI } from '../interfaces/reminder';

function reminder(id: number, syncId: string, extra: Partial<ReminderI> = {}): ReminderI {
  return {
    id, syncId, noteId: 5, userId: 1, dueAtUtc: '2030-01-01T09:00:00Z', timezone: 'UTC', repeatRule: null, status: 'pending',
    title: 'Title', body: '', imageUrl: null, locationName: null, latitude: null, longitude: null, radiusMeters: null,
    locationTrigger: 'arrive', createdAt: '', updatedAt: ''
  } as ReminderI;
}

function makeService(overrides: Record<string, unknown> = {}) {
  const service = Object.create(ReminderService.prototype) as ReminderService;
  const shown: ReminderI[][] = [];
  Object.assign(service, {
    apiUrl: '/api',
    auth: { authHeaders: () => ({}) },
    reminders$: new BehaviorSubject<ReminderI[]>([]),
    offlineSync: { partition: 'account-A', enqueue: jasmine.createSpy('enqueue').and.resolveTo(undefined), syncNow: () => Promise.resolve() },
    offlineStore: {
      putReminder: jasmine.createSpy('putReminder').and.resolveTo(undefined),
      deleteReminder: jasmine.createSpy('deleteReminder').and.resolveTo(undefined),
      listReminders: () => Promise.resolve([])
    },
    setReminders: (value: ReminderI[]) => { shown.push(value); (service as any).reminders$.next(value); },
    ...overrides
  });
  return { service: service as any, shown };
}

describe('ReminderService profile isolation and durability', () => {
  it('drops a reminder response that arrives after the account changed', async () => {
    const response = new Subject<ReminderI[]>();
    const { service, shown } = makeService({ http: { get: () => response } });

    const loading = service.load();
    service.offlineSync.partition = 'account-B';
    response.next([reminder(1, 'private-A')]);
    response.complete();
    await loading;

    expect(service.offlineStore.putReminder).not.toHaveBeenCalled();
    expect(shown).toEqual([]);
  });

  it('queues a reminder change for retry when the server is unreachable even though the browser is online', async () => {
    const { service } = makeService({ http: { patch: () => throwError(() => ({ status: 0 })) } });
    service.reminders$.next([reminder(15, 'r15')]);

    const result = await service.update(15, { dueAtUtc: '2030-01-02T09:00:00Z' });

    expect(result.dueAtUtc).toBe('2030-01-02T09:00:00Z');
    expect(service.offlineSync.enqueue).toHaveBeenCalledOnceWith('reminder.upsert', 'r15', jasmine.objectContaining({ dueAtUtc: '2030-01-02T09:00:00Z' }));
  });

  it('queues a reminder removal for retry when the server is unreachable', async () => {
    const { service } = makeService({ http: { delete: () => throwError(() => ({ status: 0 })) } });
    service.reminders$.next([reminder(15, 'r15')]);

    await service.delete(15);

    expect(service.offlineSync.enqueue).toHaveBeenCalledOnceWith('reminder.delete', 'r15', jasmine.objectContaining({ id: 15 }));
  });

  for (const status of [502, 503, 504]) {
    it(`queues a reminder change for retry when a reverse proxy answers ${status} because the server is down`, async () => {
      const { service } = makeService({ http: { patch: () => throwError(() => ({ status })) } });
      service.reminders$.next([reminder(15, 'r15')]);

      await service.update(15, { dueAtUtc: '2030-01-02T09:00:00Z' });

      expect(service.offlineSync.enqueue).toHaveBeenCalledOnceWith('reminder.upsert', 'r15', jasmine.objectContaining({ dueAtUtc: '2030-01-02T09:00:00Z' }));
    });
  }

  it('still shows a repeating reminder whose next occurrence cannot be computed', async () => {
    spyOn(console, 'error');
    const fired: unknown[] = [];
    const update = jasmine.createSpy('update').and.resolveTo(undefined);
    const { service } = makeService({ reminderTimers: new Map(), firedReminder$: { next: (value: unknown) => fired.push(value) }, update, floatNoteToTop: () => Promise.resolve() });
    // The latest representable date has no next day, so the recurrence cannot resolve a following occurrence.
    service.reminders$.next([reminder(21, 'r21', { dueAtUtc: '+275760-09-13T00:00:00.000Z', repeatRule: JSON.stringify({ type: 'daily' }) as any })]);

    await service.fireLocalReminder(21);

    expect(fired.length).toBe(1);
    expect(update).toHaveBeenCalledWith(21, { status: 'fired' });
  });

  it('does not hide a real server rejection behind the offline queue', async () => {
    const { service } = makeService({ http: { patch: () => throwError(() => ({ status: 409 })) } });
    service.reminders$.next([reminder(15, 'r15')]);

    await expectAsync(service.update(15, { dueAtUtc: '2030-01-02T09:00:00Z' })).toBeRejected();
    expect(service.offlineSync.enqueue).not.toHaveBeenCalled();
  });
});
