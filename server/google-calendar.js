// Google Calendar sync: token exchange and refresh, and pushing or removing a reminder's calendar event.
const { run, get } = require('./db');

const oauthStates = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of oauthStates) { if (v.createdAt < cutoff) oauthStates.delete(k); }
}, 5 * 60 * 1000);

function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(String(body), 'utf8');
    const req = require('https').request(
      { hostname, path, method: 'POST', headers: { ...headers, 'Content-Length': buf.length } },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out.')); });
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

function httpsApiCall(method, path, accessToken, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const buf = bodyStr ? Buffer.from(bodyStr, 'utf8') : null;
    const headers = { 'Authorization': `Bearer ${accessToken}` };
    if (buf) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = buf.length; }
    const req = require('https').request(
      { hostname: 'www.googleapis.com', path, method, headers },
      res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out.')); });
    req.on('error', reject);
    if (buf) req.write(buf);
    req.end();
  });
}

async function exchangeGoogleCode(clientId, clientSecret, code, redirectUri) {
  const params = new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  const result = await httpsPost('oauth2.googleapis.com', '/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, params.toString());
  if (result.status !== 200) throw new Error(result.body?.error_description || 'Token exchange failed.');
  return result.body;
}

async function refreshGoogleAccessToken(clientId, clientSecret, refreshToken) {
  const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
  const result = await httpsPost('oauth2.googleapis.com', '/token', { 'Content-Type': 'application/x-www-form-urlencoded' }, params.toString());
  if (result.status !== 200) throw new Error('Token refresh failed.');
  return result.body;
}

async function getValidGoogleToken(userId) {
  const row = await get('SELECT * FROM google_calendar_tokens WHERE userId = ? AND enabled = 1 AND accessToken IS NOT NULL', [userId]);
  if (!row) return null;
  const expiry = row.tokenExpiry ? new Date(row.tokenExpiry) : null;
  if (!expiry || expiry <= new Date(Date.now() + 60000)) {
    if (!row.refreshToken) return null;
    try {
      const refreshed = await refreshGoogleAccessToken(row.clientId, row.clientSecret, row.refreshToken);
      const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
      await run('UPDATE google_calendar_tokens SET accessToken = ?, tokenExpiry = ?, updatedAt = ? WHERE userId = ?',
        [refreshed.access_token, newExpiry, new Date().toISOString(), userId]);
      return refreshed.access_token;
    } catch { return null; }
  }
  return row.accessToken;
}

function buildGCalEvent(reminder) {
  const end = new Date(new Date(reminder.dueAtUtc).getTime() + 30 * 60000).toISOString();
  const body = reminder.body || '';
  const attribution = '— Created by Keeparr ✨';
  const description = body ? `${body}\n\n${attribution}` : attribution;
  return {
    summary: reminder.title || 'Keeparr Reminder',
    description,
    start: { dateTime: reminder.dueAtUtc, timeZone: reminder.timezone || 'UTC' },
    end: { dateTime: end, timeZone: reminder.timezone || 'UTC' },
    colorId: '6',
    extendedProperties: { private: { keptReminderId: String(reminder.id) } }
  };
}

async function gcalCreateAndStore(userId, reminder, token) {
  const result = await httpsApiCall('POST', '/calendar/v3/calendars/primary/events', token, buildGCalEvent(reminder));
  if ((result.status === 200 || result.status === 201) && result.body?.id) {
    await run('UPDATE reminders SET gcalEventId = ? WHERE id = ?', [result.body.id, reminder.id]);
  }
}

async function gcalPushReminder(userId, reminder) {
  const token = await getValidGoogleToken(userId);
  if (!token) return;
  if (reminder.gcalEventId) {
    const result = await httpsApiCall('PUT', `/calendar/v3/calendars/primary/events/${encodeURIComponent(reminder.gcalEventId)}`, token, buildGCalEvent(reminder));
    if (result.status === 404) await gcalCreateAndStore(userId, reminder, token);
  } else {
    await gcalCreateAndStore(userId, reminder, token);
  }
}

async function gcalDeleteReminder(userId, reminder) {
  if (!reminder.gcalEventId) return;
  const token = await getValidGoogleToken(userId);
  if (!token) return;
  await httpsApiCall('DELETE', `/calendar/v3/calendars/primary/events/${encodeURIComponent(reminder.gcalEventId)}`, token, null);
}

module.exports = {
  oauthStates, exchangeGoogleCode, getValidGoogleToken, gcalCreateAndStore, gcalPushReminder, gcalDeleteReminder
};
