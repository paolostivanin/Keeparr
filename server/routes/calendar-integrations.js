// Per-user CalDAV settings and the Google Calendar connection (credentials, OAuth redirect and disconnect).
const { run, get, all } = require('../db');
const { asyncRoute, requireAuth, randomHex } = require('../auth');
const { pushReminderToCaldav, testCaldavConnection } = require('../calendar');
const { visibleReminderJoin, visibleReminderWhere } = require('../reminder-model');
const { oauthStates, exchangeGoogleCode, getValidGoogleToken, gcalCreateAndStore } = require('../google-calendar');
const { enrichReminderResponses } = require('../sync-changes');

function mountCalendarIntegrationRoutes(app) {
  app.get('/api/caldav/settings', requireAuth, asyncRoute(async (req, res) => {
    const s = await get('SELECT * FROM caldav_settings WHERE userId = ?', [req.user.id]);
    if (!s) return res.json(null);
    res.json({ serverUrl: s.serverUrl, calendarUrl: s.calendarUrl, username: s.username, enabled: Boolean(s.enabled) });
  }));

  app.put('/api/caldav/settings', requireAuth, asyncRoute(async (req, res) => {
    const { serverUrl, calendarUrl, username, password, enabled } = req.body;
    if (!calendarUrl || !username || !password) {
      return res.status(400).json({ error: 'calendarUrl, username, and password are required.' });
    }
    const now = new Date().toISOString();
    const existing = await get('SELECT userId FROM caldav_settings WHERE userId = ?', [req.user.id]);
    const isPlaceholder = password === '••••••••';
    if (existing) {
      if (isPlaceholder) {
        await run(`UPDATE caldav_settings SET serverUrl=?, calendarUrl=?, username=?, enabled=?, updatedAt=? WHERE userId=?`,
          [serverUrl || calendarUrl, calendarUrl, username, enabled ? 1 : 0, now, req.user.id]);
      } else {
        await run(`UPDATE caldav_settings SET serverUrl=?, calendarUrl=?, username=?, password=?, enabled=?, updatedAt=? WHERE userId=?`,
          [serverUrl || calendarUrl, calendarUrl, username, password, enabled ? 1 : 0, now, req.user.id]);
      }
    } else {
      await run(`INSERT INTO caldav_settings (userId, serverUrl, calendarUrl, username, password, enabled, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)`,
        [req.user.id, serverUrl || calendarUrl, calendarUrl, username, password, enabled ? 1 : 0, now, now]);
    }
    const s = await get('SELECT * FROM caldav_settings WHERE userId = ?', [req.user.id]);
    // Backfill: PUT every existing pending reminder to the CalDAV server. The
    // reminder id is the URL key, so re-pushing is idempotent (PUT overwrites).
    // Fire-and-forget so the settings save doesn't wait on N HTTP round-trips.
    if (s && s.enabled) {
      backfillCaldavReminders(s).catch(err =>
        console.error('CalDAV backfill failed:', err.message)
      );
    }
    res.json({ serverUrl: s.serverUrl, calendarUrl: s.calendarUrl, username: s.username, enabled: Boolean(s.enabled) });
  }));

  async function backfillCaldavReminders(settings) {
    const reminders = await all(
      `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ?
     AND reminders.status = 'pending'
     AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
      [settings.userId]
    );
    const enrichedReminders = await enrichReminderResponses(reminders);
    for (const reminder of enrichedReminders) {
      try {
        await pushReminderToCaldav(settings, reminder);
      } catch (err) {
        console.error(`CalDAV backfill failed for reminder ${reminder.id}:`, err.message);
      }
    }
  }

  app.delete('/api/caldav/settings', requireAuth, asyncRoute(async (req, res) => {
    await run('DELETE FROM caldav_settings WHERE userId = ?', [req.user.id]);
    res.status(204).end();
  }));

  app.post('/api/caldav/test', requireAuth, asyncRoute(async (req, res) => {
    const { calendarUrl, username, password } = req.body;
    if (!calendarUrl || !username || !password) {
      return res.status(400).json({ error: 'calendarUrl, username, and password are required.' });
    }
    try {
      const result = await testCaldavConnection({ calendarUrl, username, password });
      res.json({ ok: true, httpStatus: result.status });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  }));


  app.get('/api/google-calendar/status', requireAuth, asyncRoute(async (req, res) => {
    const row = await get('SELECT clientId, accessToken, enabled FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
    res.json({
      hasCredentials: !!row,
      connected: !!(row?.accessToken),
      enabled: !!(row?.enabled),
      clientId: row?.clientId || null
    });
  }));

  app.put('/api/google-calendar/credentials', requireAuth, asyncRoute(async (req, res) => {
    const { clientId, clientSecret, enabled } = req.body;
    if (!clientId || !clientSecret) return res.status(400).json({ error: 'clientId and clientSecret are required.' });
    const now = new Date().toISOString();
    const existing = await get('SELECT userId, clientSecret FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
    const isPlaceholder = clientSecret === '••••••••';
    if (existing) {
      if (isPlaceholder) {
        await run('UPDATE google_calendar_tokens SET clientId = ?, enabled = ?, updatedAt = ? WHERE userId = ?',
          [clientId, enabled ? 1 : 0, now, req.user.id]);
      } else {
        await run('UPDATE google_calendar_tokens SET clientId = ?, clientSecret = ?, enabled = ?, updatedAt = ? WHERE userId = ?',
          [clientId, clientSecret, enabled ? 1 : 0, now, req.user.id]);
      }
    } else {
      if (isPlaceholder) return res.status(400).json({ error: 'Client secret is required.' });
      await run(
        'INSERT INTO google_calendar_tokens (userId, clientId, clientSecret, enabled, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)',
        [req.user.id, clientId, clientSecret, enabled ? 1 : 0, now, now]
      );
    }
    res.json({ ok: true });
  }));

  app.post('/api/auth/google/initiate', requireAuth, asyncRoute(async (req, res) => {
    const row = await get('SELECT clientId FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
    if (!row?.clientId) return res.status(400).json({ error: 'Google credentials not configured.' });
    const state = randomHex(16);
    oauthStates.set(state, { userId: req.user.id, createdAt: Date.now() });
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${baseUrl}/api/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: row.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/calendar.events',
      access_type: 'offline',
      prompt: 'consent',
      state
    });
    res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  }));

  app.get('/api/auth/google/callback', asyncRoute(async (req, res) => {
    const { code, state, error } = req.query;
    if (error || !code || !state) {
      return res.redirect('/settings?google=error&message=' + encodeURIComponent(String(error || 'Authorization cancelled.')));
    }
    const stateData = oauthStates.get(String(state));
    if (!stateData) {
      return res.redirect('/settings?google=error&message=' + encodeURIComponent('Invalid or expired state. Please try again.'));
    }
    oauthStates.delete(String(state));
    const row = await get('SELECT * FROM google_calendar_tokens WHERE userId = ?', [stateData.userId]);
    if (!row) {
      return res.redirect('/settings?google=error&message=' + encodeURIComponent('Credentials not found. Please save them first.'));
    }
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const redirectUri = `${baseUrl}/api/auth/google/callback`;
    try {
      const tokens = await exchangeGoogleCode(row.clientId, row.clientSecret, String(code), redirectUri);
      const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString();
      await run(
        'UPDATE google_calendar_tokens SET accessToken = ?, refreshToken = COALESCE(?, refreshToken), tokenExpiry = ?, enabled = 1, updatedAt = ? WHERE userId = ?',
        [tokens.access_token, tokens.refresh_token || null, expiry, new Date().toISOString(), stateData.userId]
      );
      // Backfill: push any existing pending reminders that haven't been synced
      // yet. Fire-and-forget so the OAuth redirect isn't held up by the
      // calendar API round-trips. gcalCreateAndStore writes the event ID back
      // onto each reminder so future updates/deletes find them.
      backfillGoogleCalendarReminders(stateData.userId).catch(err =>
        console.error('GCal backfill failed:', err.message)
      );
      res.redirect('/settings?google=connected');
    } catch (err) {
      res.redirect('/settings?google=error&message=' + encodeURIComponent(err.message));
    }
  }));

  async function backfillGoogleCalendarReminders(userId) {
    const token = await getValidGoogleToken(userId);
    if (!token) return;
    const reminders = await all(
      `SELECT reminders.* FROM reminders
     ${visibleReminderJoin}
     WHERE reminders.userId = ?
     AND reminders.status = 'pending'
     AND reminders.gcalEventId IS NULL
     AND ${visibleReminderWhere}
     ORDER BY reminders.dueAtUtc`,
      [userId]
    );
    const enrichedReminders = await enrichReminderResponses(reminders);
    for (const reminder of enrichedReminders) {
      try {
        await gcalCreateAndStore(userId, reminder, token);
      } catch (err) {
        console.error(`GCal backfill failed for reminder ${reminder.id}:`, err.message);
      }
    }
  }

  app.delete('/api/google-calendar/disconnect', requireAuth, asyncRoute(async (req, res) => {
    await run(
      'UPDATE google_calendar_tokens SET accessToken = NULL, refreshToken = NULL, tokenExpiry = NULL, updatedAt = ? WHERE userId = ?',
      [new Date().toISOString(), req.user.id]
    );
    res.status(204).end();
  }));

  app.delete('/api/google-calendar/credentials', requireAuth, asyncRoute(async (req, res) => {
    await run('DELETE FROM google_calendar_tokens WHERE userId = ?', [req.user.id]);
    res.status(204).end();
  }));
}

module.exports = { mountCalendarIntegrationRoutes };
