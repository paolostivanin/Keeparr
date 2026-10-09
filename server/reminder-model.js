// Reminder input normalization and response shaping. Pure: no database or network access.
const { plainText, notePreviewText } = require('./note-text');
const { isRepeatOccurrence } = require('./reminder-recurrence');

function firstDefined(...values) {
  return values.find(value => value !== undefined);
}

function normalizeLocationTrigger(value) {
  const trigger = String(value || '').trim().toLowerCase();
  return ['leave', 'exit', 'depart', 'departure'].includes(trigger) ? 'leave' : 'arrive';
}

function normalizeRepeatRule(value) {
  if (!value) return null;
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { return null; }
  }
  const type = String(parsed?.type || '').trim();
  if (!['none', 'daily', 'weekly', 'monthly', 'custom_days'].includes(type)) return null;
  const intervalDays = Number(parsed.intervalDays || 0);
  if (type === 'none' && !parsed.moveToTopOnTrigger) return null;
  return JSON.stringify({
    type,
    ...(type === 'custom_days' ? { intervalDays: Number.isFinite(intervalDays) && intervalDays > 0 ? Math.floor(intervalDays) : 1 } : {}),
    moveToTopOnTrigger: !!parsed.moveToTopOnTrigger
  });
}

function normalizeReminderDueAt(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : String(value);
}

function reminderScheduleDefinition(existing = {}) {
  return {
    dueAtUtc: normalizeReminderDueAt(existing.dueAtUtc),
    timezone: String(existing.timezone || 'UTC'),
    repeatRule: normalizeRepeatRule(existing.repeatRule)
  };
}

function reminderScheduleDefinitionChanged(existing, next) {
  const before = reminderScheduleDefinition(existing);
  const after = reminderScheduleDefinition(next);
  return before.dueAtUtc !== after.dueAtUtc || before.timezone !== after.timezone || before.repeatRule !== after.repeatRule;
}

// Like reminderScheduleDefinitionChanged, except that moving a repeating reminder to a later occurrence of its own
// schedule is not an edit: a client rolling it over after it fired keeps the anchor and the version, so a monthly
// reminder on the 31st stays on the 31st instead of settling on the 28th.
function reminderScheduleChanged(existing, next) {
  if (!reminderScheduleDefinitionChanged(existing, next)) return false;
  const before = reminderScheduleDefinition(existing);
  const after = reminderScheduleDefinition(next);
  if (!before.repeatRule || before.repeatRule !== after.repeatRule || before.timezone !== after.timezone) return true;
  if (!(Date.parse(after.dueAtUtc) > Date.parse(before.dueAtUtc))) return true;
  try {
    return !isRepeatOccurrence(existing.scheduleAnchorAtUtc || before.dueAtUtc, after.dueAtUtc, parseRepeatRule(before.repeatRule), before.timezone);
  } catch {
    return true;
  }
}

function parseRepeatRule(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    const normalized = normalizeRepeatRule(parsed);
    return normalized ? JSON.parse(normalized) : null;
  } catch {
    return null;
  }
}

function normalizeReminderPayload(body = {}, existing = {}) {
  const location = body.location && typeof body.location === 'object' ? body.location : {};
  const repeatRuleRaw = Object.prototype.hasOwnProperty.call(body, 'repeatRule') || Object.prototype.hasOwnProperty.call(body, 'repeat_rule')
    ? firstDefined(body.repeatRule, body.repeat_rule)
    : existing.repeatRule;
  const noteIdRaw = firstDefined(body.noteId, body.note_id, body.noteID, body.note?.id, existing.noteId);
  const locationNameRaw = firstDefined(
    body.locationName,
    body.location_name,
    body.triggerLocationName,
    location.displayName,
    location.locationName,
    location.name,
    location.address,
    existing.locationName
  );
  const latitudeRaw = firstDefined(body.latitude, body.lat, location.latitude, location.lat, existing.latitude);
  const longitudeRaw = firstDefined(body.longitude, body.lng, body.lon, location.longitude, location.lng, location.lon, existing.longitude);
  const radiusRaw = firstDefined(body.radiusMeters, body.radius_meters, body.radius, location.radiusMeters, location.radius_meters, location.radius, existing.radiusMeters);
  const triggerRaw = firstDefined(body.locationTrigger, body.location_trigger, body.triggerType, body.geofenceTrigger, location.locationTrigger, location.triggerType, existing.locationTrigger);
  const dueRaw = firstDefined(body.dueAtUtc, body.due_at_utc, body.dueAt, body.datetime, body.dateTime, existing.dueAtUtc);

  const locationName = locationNameRaw ? String(locationNameRaw) : null;
  const latitude = latitudeRaw != null ? Number(latitudeRaw) : null;
  const longitude = longitudeRaw != null ? Number(longitudeRaw) : null;
  const radiusMeters = radiusRaw != null ? Number(radiusRaw) : (locationName ? 120 : null);

  return {
    noteId: Number(noteIdRaw || 0) || null,
    dueAtUtc: normalizeReminderDueAt(dueRaw),
    timezone: String(firstDefined(body.timezone, body.timeZone, existing.timezone, 'UTC') || 'UTC'),
    repeatRule: normalizeRepeatRule(repeatRuleRaw),
    status: firstDefined(body.status, existing.status, 'pending'),
    title: plainText(firstDefined(body.title, body.notificationTitle, existing.title) || '') || null,
    body: plainText(firstDefined(body.body, body.notificationBody, body.text, existing.body) || '') || null,
    imageUrl: String(firstDefined(body.imageUrl, body.image_url, existing.imageUrl) || '') || null,
    locationName,
    latitude,
    longitude,
    radiusMeters,
    locationTrigger: normalizeLocationTrigger(triggerRaw)
  };
}

function reminderResponse(reminder, notesById = new Map()) {
  const noteId = Number(reminder.noteId || 0) || null;
  const note = noteId ? notesById.get(`${Number(reminder.userId)}:${noteId}`) : null;
  const inaccessibleNote = !!noteId && !note;
  const explicitTitle = plainText(reminder.title || '');
  const explicitBody = plainText(reminder.body || '');
  const noteTitle = plainText(note?.noteTitle || '');
  const noteBody = note ? notePreviewText(note).slice(0, 500) : '';
  const useCurrentNoteContent = !!note && !note.locked;
  const latitude = reminder.latitude != null ? Number(reminder.latitude) : null;
  const longitude = reminder.longitude != null ? Number(reminder.longitude) : null;
  const radiusMeters = reminder.radiusMeters != null ? Number(reminder.radiusMeters) : null;
  const locationName = reminder.locationName || null;
  const locationTrigger = normalizeLocationTrigger(reminder.locationTrigger);
  return {
    ...reminder,
    id: Number(reminder.id),
    syncId: reminder.syncId || '',
    noteId,
    dueAtUtc: reminder.dueAtUtc || null,
    title: inaccessibleNote ? null : useCurrentNoteContent ? (noteTitle || null) : (explicitTitle || noteTitle || null),
    body: inaccessibleNote ? null : useCurrentNoteContent ? (noteBody || null) : (explicitBody || noteBody || null),
    imageUrl: inaccessibleNote ? null : (reminder.imageUrl || null),
    locationName,
    latitude,
    longitude,
    radiusMeters,
    locationTrigger,
    location: locationName && latitude != null && longitude != null ? {
      displayName: locationName,
      name: locationName,
      latitude,
      longitude,
      radiusMeters: radiusMeters ?? 120,
      triggerType: locationTrigger,
      locationTrigger
    } : null,
    status: reminder.status || 'pending',
    deepLink: noteId && !inaccessibleNote ? `keeparr://note/${noteId}` : null,
    lwwPhysicalMs: Number(reminder.lwwPhysicalMs || 0),
    lwwLogical: Number(reminder.lwwLogical || 0),
    lwwDeviceId: reminder.lwwDeviceId || 'server',
    lwwOperationId: reminder.lwwOperationId || ''
  };
}

module.exports = { firstDefined, normalizeLocationTrigger, normalizeRepeatRule, normalizeReminderDueAt, reminderScheduleDefinition, reminderScheduleDefinitionChanged, reminderScheduleChanged, parseRepeatRule, normalizeReminderPayload, reminderResponse };
