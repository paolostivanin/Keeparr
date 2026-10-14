// Reminder routes: list, calendar feed and import, saved places and create, edit and delete.
const crypto = require('crypto');
const { all, get, run } = require('../db');
const { asyncRoute, randomHex, requireAuth } = require('../auth');
const {
  buildIcsFeed, deleteReminderFromCaldav, getOrCreateIcsFeedToken, parseIcalDate, parseIcsContent, pushReminderToCaldav
} = require('../calendar');
const {
  enrichReminderResponse, enrichReminderResponses, recordReminderSyncChange, reminderIsVisibleToUser
} = require('../sync-changes');
const { floatReminderNoteToTop } = require('../notes');
const { gcalDeleteReminder, gcalPushReminder } = require('../google-calendar');
const { getAccessibleNote } = require('../note-data');
const { nextRepeatDueAt } = require('../reminder-recurrence');
const {
  normalizeReminderPayload, parseRepeatRule, reminderScheduleChanged, reminderScheduleDefinitionChanged, visibleReminderJoin, visibleReminderWhere
} = require('../reminder-model');
const { plainText } = require('../note-text');
const { serverLwwStamp } = require('../sync-protocol');

// Shared handler for both ICS feed URL shapes. The "trailing filename"
// variant exists because Thunderbird (and a few other clients) names a
// subscribed calendar after the last URL path segment — putting the token
// at the end means users see the token as the default calendar name.
// Putting keeparr-reminders.ics at the end gives them a friendly default.
const handleIcsFeed = asyncRoute(async (req, res) => {
  const user = await get('SELECT id FROM users WHERE icsFeedToken = ? AND enabled = 1', [req.params.token]);
  if (!user) return res.status(404).type('text').send('Feed not found.');
  const reminders = await all(
    `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ? AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
    [user.id]
  );
  const enrichedReminders = await enrichReminderResponses(reminders);
  res.set({
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Disposition': 'attachment; filename="keeparr-reminders.ics"',
    'Cache-Control': 'no-cache, no-store'
  });
  res.send(buildIcsFeed(enrichedReminders));
});

function locationSavedPlaceResponse(place) {
  return {
    id: Number(place.id),
    userId: Number(place.userId),
    name: String(place.name || ''),
    address: place.address || '',
    placeType: ['home', 'work', 'gym', 'other'].includes(place.placeType) ? place.placeType : 'other',
    latitude: Number(place.latitude),
    longitude: Number(place.longitude),
    radiusMeters: place.radiusMeters != null ? Number(place.radiusMeters) : 100,
    locationTrigger: place.locationTrigger === 'leave' ? 'leave' : 'arrive',
    mapPreviewUrl: place.mapPreviewUrl || null,
    createdAt: place.createdAt,
    updatedAt: place.updatedAt
  };
}

function parseLocationSavedPlacePayload(body, existing = {}) {
  const placeTypes = ['home', 'work', 'gym', 'other'];
  const triggers = ['arrive', 'leave'];
  const name = body.name !== undefined ? plainText(body.name).slice(0, 120) : existing.name;
  const address = body.address !== undefined ? plainText(body.address).slice(0, 240) : (existing.address || '');
  const placeType = placeTypes.includes(body.placeType) ? body.placeType : (existing.placeType || 'other');
  const latitude = body.latitude !== undefined ? Number(body.latitude) : Number(existing.latitude);
  const longitude = body.longitude !== undefined ? Number(body.longitude) : Number(existing.longitude);
  const radiusMeters = body.radiusMeters !== undefined ? Number(body.radiusMeters) : Number(existing.radiusMeters || 100);
  const locationTrigger = triggers.includes(body.locationTrigger) ? body.locationTrigger : (existing.locationTrigger || 'arrive');
  const mapPreviewUrl = body.mapPreviewUrl !== undefined ? (String(body.mapPreviewUrl || '') || null) : (existing.mapPreviewUrl || null);
  if (!name) return { error: 'name is required.' };
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return { error: 'latitude and longitude are required.' };
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) return { error: 'radiusMeters must be positive.' };
  return { name, address, placeType, latitude, longitude, radiusMeters, locationTrigger, mapPreviewUrl };
}

function mountReminderRoutes(app) {
  app.get('/api/reminders', requireAuth, asyncRoute(async (req, res) => {
    const reminders = await all(
      `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ? AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
      [req.user.id]
    );
    res.json(await enrichReminderResponses(reminders));
  }));

  // ─── ICS feed routes ───────────────────────────────────────────────────────

  app.get('/api/reminders/ics-token', requireAuth, asyncRoute(async (req, res) => {
    const token = await getOrCreateIcsFeedToken(req.user.id);
    res.json({ token });
  }));

  app.post('/api/reminders/ics-token', requireAuth, asyncRoute(async (req, res) => {
    const token = randomHex(20);
    await run('UPDATE users SET icsFeedToken = ? WHERE id = ?', [token, req.user.id]);
    res.json({ token });
  }));

  // Friendly route: token in the middle, keeparr-reminders.ics at the end so
  // calendar clients pick up a sensible default name from the URL path.
  app.get('/api/reminders/ics/:token/keeparr-reminders.ics', handleIcsFeed);

  // Legacy route kept so existing subscriptions don't break.
  app.get('/api/reminders/ics/:token', handleIcsFeed);

  app.post('/api/reminders/import', requireAuth, asyncRoute(async (req, res) => {
    const icsContent = String(req.body.icsContent || '');
    if (!icsContent) return res.status(400).json({ error: 'icsContent is required.' });
    const events = parseIcsContent(icsContent);
    const now = new Date().toISOString();
    let imported = 0;
    for (const event of events) {
      if (!event.dtstart) continue;
      try {
        const dueAt = parseIcalDate(event.dtstart);
        if (isNaN(dueAt.getTime())) continue;
        const dueAtUtc = dueAt.toISOString();
        const result = await run(
          `INSERT INTO reminders (noteId, userId, dueAtUtc, timezone, repeatRule, status, title, body,
           scheduleVersion, scheduleAnchorAtUtc, createdAt, updatedAt, syncId)
         VALUES (NULL, ?, ?, 'UTC', NULL, 'pending', ?, ?, 1, ?, ?, ?, ?)`,
          [req.user.id, dueAtUtc, plainText(event.summary) || null, plainText(event.description) || null,
            dueAtUtc, now, now, `reminder-${crypto.randomUUID()}`]
        );
        await recordReminderSyncChange(await get('SELECT * FROM reminders WHERE id = ?', [result.id]), 'upsert');
        imported++;
      } catch {}
    }
    res.json({ imported });
  }));

  app.get('/api/location-saved-places', requireAuth, asyncRoute(async (req, res) => {
    const places = await all(
      `SELECT * FROM location_saved_places WHERE userId = ? ORDER BY updatedAt DESC, id DESC`,
      [req.user.id]
    );
    res.json(places.map(locationSavedPlaceResponse));
  }));

  app.post('/api/location-saved-places', requireAuth, asyncRoute(async (req, res) => {
    const parsed = parseLocationSavedPlacePayload(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const now = new Date().toISOString();
    const result = await run(
      `INSERT INTO location_saved_places
       (userId, name, address, placeType, latitude, longitude, radiusMeters, locationTrigger, mapPreviewUrl, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, parsed.name, parsed.address, parsed.placeType, parsed.latitude, parsed.longitude, parsed.radiusMeters, parsed.locationTrigger, parsed.mapPreviewUrl, now, now]
    );
    const place = await get('SELECT * FROM location_saved_places WHERE id = ? AND userId = ?', [result.id, req.user.id]);
    res.status(201).json(locationSavedPlaceResponse(place));
  }));

  app.patch('/api/location-saved-places/:id', requireAuth, asyncRoute(async (req, res) => {
    const place = await get('SELECT * FROM location_saved_places WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
    if (!place) return res.status(404).json({ error: 'Saved place not found.' });
    const parsed = parseLocationSavedPlacePayload(req.body || {}, place);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const now = new Date().toISOString();
    await run(
      `UPDATE location_saved_places
     SET name = ?, address = ?, placeType = ?, latitude = ?, longitude = ?, radiusMeters = ?, locationTrigger = ?, mapPreviewUrl = ?, updatedAt = ?
     WHERE id = ? AND userId = ?`,
      [parsed.name, parsed.address, parsed.placeType, parsed.latitude, parsed.longitude, parsed.radiusMeters, parsed.locationTrigger, parsed.mapPreviewUrl, now, place.id, req.user.id]
    );
    const updated = await get('SELECT * FROM location_saved_places WHERE id = ? AND userId = ?', [place.id, req.user.id]);
    res.json(locationSavedPlaceResponse(updated));
  }));

  app.delete('/api/location-saved-places/:id', requireAuth, asyncRoute(async (req, res) => {
    const place = await get('SELECT * FROM location_saved_places WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
    if (!place) return res.status(404).json({ error: 'Saved place not found.' });
    await run('DELETE FROM location_saved_places WHERE id = ? AND userId = ?', [place.id, req.user.id]);
    res.status(204).end();
  }));

  app.post('/api/reminders', requireAuth, asyncRoute(async (req, res) => {
    const payload = normalizeReminderPayload(req.body || {});
    if (!payload.dueAtUtc && !payload.locationName) return res.status(400).json({ error: 'Either dueAtUtc or locationName is required.' });
    if (payload.dueAtUtc && !Number.isFinite(Date.parse(payload.dueAtUtc))) return res.status(400).json({ error: 'dueAtUtc must be a valid date.' });
    if (payload.locationName && (payload.latitude == null || payload.longitude == null)) {
      return res.status(400).json({ error: 'Location reminders require locationName, latitude, and longitude.' });
    }
    if (payload.radiusMeters != null && (!Number.isFinite(payload.radiusMeters) || payload.radiusMeters <= 0)) {
      return res.status(400).json({ error: 'radiusMeters must be positive.' });
    }
    const noteIdVal = payload.noteId;
    if (noteIdVal) {
      const note = await getAccessibleNote(noteIdVal, req.user.id);
      if (!note) return res.status(404).json({ error: 'Note not found.' });
    }
    const now = new Date().toISOString();
    const stamp = serverLwwStamp();
    const syncId = String(req.body.syncId || req.body.clientId || `reminder-${crypto.randomUUID()}`);

    const existing = noteIdVal ? await get('SELECT * FROM reminders WHERE noteId = ? AND userId = ?', [noteIdVal, req.user.id]) : null;
    const scheduleChanged = existing ? reminderScheduleDefinitionChanged(existing, payload) : false;
    const scheduleVersion = existing ? Number(existing.scheduleVersion || 1) + (scheduleChanged ? 1 : 0) : 1;
    const scheduleAnchorAtUtc = scheduleChanged ? payload.dueAtUtc : (existing?.scheduleAnchorAtUtc || existing?.dueAtUtc || payload.dueAtUtc);
    const reminder = await get(
      `INSERT INTO reminders (noteId, userId, dueAtUtc, timezone, repeatRule, status, title, body, imageUrl, locationName, latitude, longitude, radiusMeters, locationTrigger, scheduleVersion, scheduleAnchorAtUtc, createdAt, updatedAt, syncId, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(userId, noteId) DO UPDATE SET
       userId = excluded.userId,
       syncId = COALESCE(reminders.syncId, excluded.syncId),
       dueAtUtc = excluded.dueAtUtc,
       timezone = excluded.timezone,
       repeatRule = excluded.repeatRule,
       status = 'pending',
       title = excluded.title,
       body = excluded.body,
       imageUrl = excluded.imageUrl,
       locationName = excluded.locationName,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       radiusMeters = excluded.radiusMeters,
       locationTrigger = excluded.locationTrigger,
       scheduleAnchorAtUtc = CASE
         WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
         THEN excluded.scheduleAnchorAtUtc ELSE COALESCE(reminders.scheduleAnchorAtUtc, reminders.dueAtUtc) END,
       scheduleVersion = reminders.scheduleVersion + CASE
         WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
         THEN 1 ELSE 0 END,
       updatedAt = excluded.updatedAt,
       lwwPhysicalMs = excluded.lwwPhysicalMs,
       lwwLogical = excluded.lwwLogical,
       lwwDeviceId = excluded.lwwDeviceId,
       lwwOperationId = excluded.lwwOperationId
     RETURNING *`,
      [
        noteIdVal,
        req.user.id,
        payload.dueAtUtc,
        payload.timezone,
        payload.repeatRule,
        payload.title,
        payload.body,
        payload.imageUrl,
        payload.locationName,
        payload.latitude,
        payload.longitude,
        payload.radiusMeters,
        payload.locationTrigger,
        scheduleVersion,
        scheduleAnchorAtUtc,
        now,
        now,
        syncId,
        stamp.physicalMs,
        stamp.logical,
        stamp.deviceId,
        stamp.operationId
      ]
    );
    await recordReminderSyncChange(reminder, 'upsert');
    const enrichedReminder = await enrichReminderResponse(reminder);
    const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
    if (caldav) pushReminderToCaldav(caldav, enrichedReminder).catch(err => console.error('CalDAV push failed:', err.message));
    gcalPushReminder(req.user.id, enrichedReminder).catch(err => console.error('GCal push failed:', err.message));
    res.status(existing ? 200 : 201).json(enrichedReminder);
  }));

  app.patch('/api/reminders/:id', requireAuth, asyncRoute(async (req, res) => {
    const reminder = await get('SELECT * FROM reminders WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });
    if (!(await reminderIsVisibleToUser(reminder, req.user.id))) return res.status(404).json({ error: 'Reminder not found.' });
    const now = new Date().toISOString();
    const stamp = serverLwwStamp();
    const validStatuses = ['pending','fired','dismissed','snoozed'];
    const payload = normalizeReminderPayload(req.body || {}, reminder);
    const status = validStatuses.includes(payload.status) ? payload.status : reminder.status;
    const dueAtUtc = payload.dueAtUtc;
    const timezone = payload.timezone || reminder.timezone || 'UTC';
    const locationName = payload.locationName;
    const latitude = payload.latitude;
    const longitude = payload.longitude;
    const radiusMeters = payload.radiusMeters;
    const locationTrigger = payload.locationTrigger;
    const repeatRule = payload.repeatRule;
    if (dueAtUtc && !Number.isFinite(Date.parse(dueAtUtc))) return res.status(400).json({ error: 'dueAtUtc must be a valid date.' });
    const scheduleChanged = reminderScheduleChanged(reminder, { dueAtUtc, timezone, repeatRule });
    const scheduleVersion = Number(reminder.scheduleVersion || 1) + (scheduleChanged ? 1 : 0);
    const scheduleAnchorAtUtc = scheduleChanged ? dueAtUtc : (reminder.scheduleAnchorAtUtc || reminder.dueAtUtc || dueAtUtc);
    const repeat = status === 'fired' ? parseRepeatRule(repeatRule) : null;
    const rolledDueAtUtc = repeat ? nextRepeatDueAt(dueAtUtc, repeat, timezone, Date.now(), reminder.scheduleAnchorAtUtc || dueAtUtc) : null;
    const finalStatus = rolledDueAtUtc ? 'pending' : status;
    const finalDueAtUtc = rolledDueAtUtc || dueAtUtc;

    if (!finalDueAtUtc && !locationName) return res.status(400).json({ error: 'Either dueAtUtc or locationName is required.' });
    if (locationName && (latitude == null || longitude == null)) {
      return res.status(400).json({ error: 'Location reminders require locationName, latitude, and longitude.' });
    }
    if (radiusMeters != null && (!Number.isFinite(radiusMeters) || radiusMeters <= 0)) {
      return res.status(400).json({ error: 'radiusMeters must be positive.' });
    }

    const update = await run(
      `UPDATE reminders SET
       status = ?, dueAtUtc = ?, timezone = ?, repeatRule = ?, locationName = ?, latitude = ?, longitude = ?, radiusMeters = ?, locationTrigger = ?, updatedAt = ?,
       scheduleVersion = ?, scheduleAnchorAtUtc = ?,
       lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?, lwwOperationId = ?,
       syncId = CASE WHEN syncId IS NULL OR syncId = '' THEN ? ELSE syncId END
      WHERE id = ? AND scheduleVersion = ?`,
      [finalStatus, finalDueAtUtc, timezone, repeatRule, locationName, latitude, longitude, radiusMeters, locationTrigger, now,
        scheduleVersion, scheduleAnchorAtUtc, stamp.physicalMs, stamp.logical, stamp.deviceId, stamp.operationId,
        `reminder-${crypto.randomUUID()}`, reminder.id, Number(reminder.scheduleVersion || 1)]
    );
    if (!update.changes) return res.status(409).json({ error: 'Reminder schedule changed. Reload before editing.' });
    const updated = await get('SELECT * FROM reminders WHERE id = ?', [reminder.id]);
    await recordReminderSyncChange(updated, 'upsert');
    const enrichedUpdated = await enrichReminderResponse(updated);
    if ((rolledDueAtUtc || finalStatus === 'fired') && repeat?.moveToTopOnTrigger) await floatReminderNoteToTop(req.user.id, reminder.noteId);
    if (finalStatus === 'pending') {
      const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
      if (caldav) pushReminderToCaldav(caldav, enrichedUpdated).catch(err => console.error('CalDAV push failed:', err.message));
      gcalPushReminder(req.user.id, enrichedUpdated).catch(err => console.error('GCal push failed:', err.message));
    }
    res.json(enrichedUpdated);
  }));

  app.delete('/api/reminders/:id', requireAuth, asyncRoute(async (req, res) => {
    const reminder = await get('SELECT * FROM reminders WHERE id = ? AND userId = ?', [Number(req.params.id), req.user.id]);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found.' });
    const stamp = serverLwwStamp();
    reminder.syncId = reminder.syncId || `reminder-${crypto.randomUUID()}`;
    reminder.lwwPhysicalMs = stamp.physicalMs;
    reminder.lwwLogical = stamp.logical;
    reminder.lwwDeviceId = stamp.deviceId;
    reminder.lwwOperationId = stamp.operationId;
    await run('DELETE FROM reminders WHERE id = ?', [reminder.id]);
    await recordReminderSyncChange(reminder, 'delete');
    const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [req.user.id]);
    if (caldav) deleteReminderFromCaldav(caldav, reminder.id).catch(err => console.error('CalDAV delete failed:', err.message));
    gcalDeleteReminder(req.user.id, reminder).catch(err => console.error('GCal delete failed:', err.message));
    res.status(204).end();
  }));
}

module.exports = {
  mountReminderRoutes
};
