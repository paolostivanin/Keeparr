import type { ReminderRepeatRule } from '../interfaces/reminder';

/**
 * Next occurrence of a repeating reminder, in the reminder's own time zone. This is the same algorithm as
 * `server/reminder-recurrence.js` and the Android `Recurrence` (shared fixtures: `test-fixtures/native-contract.json`),
 * so a reminder advanced on any client lands on the same instant: the anchor's wall-clock time is kept across DST changes, a missing
 * local time moves forward, a repeated one takes the earlier instant, and monthly repeats keep the anchor's day of
 * month (clamped to short months) instead of overflowing into the next one.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

function partsAt(epochMs: number, timezone: string): LocalParts {
  let formatter = formatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    formatters.set(timezone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(epochMs)).map(part => [part.type, part.value]));
  return {
    year: Number(parts['year']), month: Number(parts['month']), day: Number(parts['day']),
    hour: Number(parts['hour']), minute: Number(parts['minute']), second: Number(parts['second'])
  };
}

function localScalar(parts: LocalParts, milliseconds = 0) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, milliseconds);
}

// Resolve wall-clock time like java.time.ZonedDateTime: move forward through a DST gap and choose the earlier instant
// when a wall time occurs twice.
function instantAt(parts: LocalParts, milliseconds: number, timezone: string) {
  const target = localScalar(parts, milliseconds);
  const offsets = new Set<number>();
  for (let hours = -48; hours <= 48; hours += 6) {
    const sample = target + hours * 60 * 60 * 1000;
    offsets.add(localScalar(partsAt(sample, timezone), new Date(sample).getUTCMilliseconds()) - sample);
  }
  const candidates = [...offsets].map(offset => target - offset).map(epochMs => ({
    epochMs, wall: localScalar(partsAt(epochMs, timezone), new Date(epochMs).getUTCMilliseconds())
  }));
  const exact = candidates.filter(candidate => candidate.wall === target).sort((a, b) => a.epochMs - b.epochMs);
  if (exact.length) return new Date(exact[0].epochMs);
  const afterGap = candidates.filter(candidate => candidate.wall > target).sort((a, b) => a.wall - b.wall || a.epochMs - b.epochMs);
  if (afterGap.length) return new Date(afterGap[0].epochMs);
  throw new RangeError(`Cannot resolve local reminder time in ${timezone}`);
}

export function nextRepeatDueAt(
  dueAtUtc: string | null,
  repeatRule: ReminderRepeatRule | null | undefined,
  timezone = 'UTC',
  nowMs = Date.now(),
  anchorAtUtc: string | null | undefined = dueAtUtc
): string | null {
  if (!dueAtUtc || !repeatRule || repeatRule.type === 'none') return null;
  if (!Number.isFinite(nowMs)) nowMs = Date.now();
  const due = new Date(dueAtUtc);
  if (Number.isNaN(due.getTime())) return null;
  const anchor = new Date(anchorAtUtc || dueAtUtc);
  const scheduleAnchor = Number.isNaN(anchor.getTime()) ? due : anchor;
  let zone = String(timezone || 'UTC');
  try { partsAt(due.getTime(), zone); } catch { zone = 'UTC'; }
  let local = partsAt(due.getTime(), zone);
  const anchorLocal = partsAt(scheduleAnchor.getTime(), zone);
  const milliseconds = scheduleAnchor.getUTCMilliseconds();
  const type = repeatRule.type;
  if (!['daily', 'weekly', 'monthly', 'custom_days'].includes(type)) return null;
  const interval = type === 'daily' ? 1 : type === 'weekly' ? 7 : type === 'custom_days'
    ? Math.max(1, Math.floor(Number(repeatRule.intervalDays) || 1)) : 0;
  // Every occurrence is a calendar date plus the schedule anchor's own time of day, so the occurrences that are certainly
  // in the past can be skipped in one step instead of walked one by one.
  local = skipPastOccurrences(local, type, interval, partsAt(nowMs, zone));
  for (let guard = 0; guard < 1000; guard += 1) {
    if (type === 'monthly') {
      const firstOfNextMonth = new Date(Date.UTC(local.year, local.month, 1));
      const lastDay = new Date(Date.UTC(firstOfNextMonth.getUTCFullYear(), firstOfNextMonth.getUTCMonth() + 1, 0)).getUTCDate();
      local = {
        ...local, year: firstOfNextMonth.getUTCFullYear(), month: firstOfNextMonth.getUTCMonth() + 1,
        day: Math.min(anchorLocal.day, lastDay)
      };
    } else {
      const nextDate = new Date(Date.UTC(local.year, local.month - 1, local.day + interval));
      local = { ...local, year: nextDate.getUTCFullYear(), month: nextDate.getUTCMonth() + 1, day: nextDate.getUTCDate() };
    }
    // The time of day always comes from the anchor, not from the previous occurrence: a time skipped by a DST change
    // moves that one day only and the schedule returns to its own time afterwards.
    local = { ...local, hour: anchorLocal.hour, minute: anchorLocal.minute, second: anchorLocal.second };
    const next = instantAt(local, milliseconds, zone);
    if (next.getTime() > nowMs) return next.toISOString();
  }
  throw new RangeError('Reminder recurrence exceeded the catch-up limit.');
}

// Moves `local` forward to just before `now` in whole repeat steps, never past an occurrence that is still in the future:
// the skipped date is at least one calendar day (or one month) before today's local date.
function skipPastOccurrences(local: LocalParts, type: string, interval: number, nowLocal: LocalParts): LocalParts {
  if (type === 'monthly') {
    const months = (nowLocal.year - local.year) * 12 + (nowLocal.month - local.month) - 1;
    if (months <= 0) return local;
    const target = new Date(Date.UTC(local.year, local.month - 1 + months, 1));
    return { ...local, year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: 1 };
  }
  const days = Math.floor((localScalar(nowLocal) - localScalar(local)) / 86400000);
  const steps = Math.floor(days / interval) - 1;
  if (steps <= 0) return local;
  const target = new Date(Date.UTC(local.year, local.month - 1, local.day + steps * interval));
  return { ...local, year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate() };
}
