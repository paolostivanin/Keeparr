// iCalendar output and input (reminder feeds, imports) and the CalDAV client that mirrors reminders to a user's calendar.
const { run, get } = require('./db');
const { randomHex } = require('./auth');
const { integrationRequestOptions } = require('./public-network');

function toIcalDate(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function buildVCalendar(reminder) {
  const esc = s => String(s || '').replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
  const dtend = toIcalDate(new Date(new Date(reminder.dueAtUtc).getTime() + 30 * 60000).toISOString());
  const body = (reminder.body || '').trim();
  const attribution = '— Created by Keeparr ✨';
  const description = body ? `${body}\n\n\n${attribution}` : attribution;
  return [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Keeparr//Keeparr//EN',
    'BEGIN:VEVENT',
    `UID:keeparr-reminder-${reminder.id}@keeparr`,
    `DTSTAMP:${toIcalDate(new Date().toISOString())}`,
    `DTSTART:${toIcalDate(reminder.dueAtUtc)}`,
    `DTEND:${dtend}`,
    `SUMMARY:${esc(reminder.title || 'Keeparr Reminder')}`,
    `DESCRIPTION:${esc(description)}`,
    'END:VEVENT','END:VCALENDAR'
  ].join('\r\n');
}

async function caldavRequest(settings, reminderId, method, body) {
  const https = require('https');
  const http = require('http');
  let base = settings.calendarUrl;
  if (!base.endsWith('/')) base += '/';
  const url = new URL(`${base}keeparr-reminder-${reminderId}.ics`);
  const proto = url.protocol === 'https:' ? https : http;
  const auth = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
  const bodyBuf = body ? Buffer.from(body, 'utf8') : null;
  // Resolved once and pinned, so a link-local address cannot be reached by rebinding the name after the check.
  const { lookup } = await integrationRequestOptions(url.href);
  return new Promise((resolve, reject) => {
    const req = proto.request({
      lookup,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method,
      headers: {
        'Authorization': `Basic ${auth}`,
        ...(bodyBuf ? { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Length': bodyBuf.length } : {})
      }
    }, res => {
      res.resume();
      if (res.statusCode < 500) resolve(res.statusCode);
      else reject(new Error(`CalDAV ${method} failed: HTTP ${res.statusCode}`));
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Connection timed out.')); });
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function pushReminderToCaldav(settings, reminder) {
  await caldavRequest(settings, reminder.id, 'PUT', buildVCalendar(reminder));
}

async function deleteReminderFromCaldav(settings, reminderId) {
  await caldavRequest(settings, reminderId, 'DELETE', null);
}

async function testCaldavConnection(settings) {
  const https = require('https');
  const http = require('http');
  const url = new URL(settings.calendarUrl);
  const proto = url.protocol === 'https:' ? https : http;
  const auth = Buffer.from(`${settings.username}:${settings.password}`).toString('base64');
  const { lookup } = await integrationRequestOptions(url.href);
  return new Promise((resolve, reject) => {
    const req = proto.request({
      lookup,
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'PROPFIND',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/xml', 'Depth': '0' }
    }, res => {
      res.resume();
      if (res.statusCode < 500) resolve({ status: res.statusCode });
      else reject(new Error(`HTTP ${res.statusCode}`));
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Connection timed out.')); });
    req.on('error', reject);
    req.end();
  });
}

function buildIcsFeed(reminders, calName = 'Keeparr Reminders') {
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const attribution = '— Created by Keeparr ✨';
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Keeparr//Keeparr//EN',
    `X-WR-CALNAME:${esc(calName)}`,
    'X-WR-CALDESC:Reminders from Keeparr',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'
  ];
  for (const r of reminders) {
    const dtend = toIcalDate(new Date(new Date(r.dueAtUtc).getTime() + 30 * 60000).toISOString());
    const body = (r.body || '').trim();
    const description = body ? `${body}\n\n\n${attribution}` : attribution;
    lines.push('BEGIN:VEVENT',
      `UID:keeparr-reminder-${r.id}@keeparr`,
      `DTSTAMP:${toIcalDate(new Date().toISOString())}`,
      `DTSTART:${toIcalDate(r.dueAtUtc)}`,
      `DTEND:${dtend}`,
      `SUMMARY:${esc(r.title || 'Keeparr Reminder')}`,
      `DESCRIPTION:${esc(description)}`,
      r.status !== 'pending' ? 'STATUS:COMPLETED' : 'STATUS:CONFIRMED',
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

async function getOrCreateIcsFeedToken(userId) {
  const user = await get('SELECT icsFeedToken FROM users WHERE id = ?', [userId]);
  if (user?.icsFeedToken) return user.icsFeedToken;
  const token = randomHex(20);
  await run('UPDATE users SET icsFeedToken = ? WHERE id = ?', [token, userId]);
  return token;
}

function parseIcsContent(icsContent) {
  const lines = icsContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const events = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT' && cur) { events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const ci = line.indexOf(':');
    if (ci < 0) continue;
    const key = line.slice(0, ci).replace(/;[^:]+/g, '').toUpperCase();
    const val = line.slice(ci + 1).replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
    if (key === 'DTSTART') cur.dtstart = val;
    if (key === 'SUMMARY') cur.summary = val;
    if (key === 'DESCRIPTION') cur.description = val;
  }
  return events;
}

function parseIcalDate(dtstr) {
  const s = String(dtstr || '').replace(/[-:]/g, '');
  const isUtc = s.endsWith('Z');
  const clean = s.replace('T', '').replace('Z', '');
  const y = clean.slice(0, 4), mo = clean.slice(4, 6), da = clean.slice(6, 8);
  const hr = clean.slice(8, 10) || '00', mi = clean.slice(10, 12) || '00', sc = clean.slice(12, 14) || '00';
  return new Date(`${y}-${mo}-${da}T${hr}:${mi}:${sc}${isUtc ? 'Z' : 'Z'}`);
}

module.exports = {
  pushReminderToCaldav, deleteReminderFromCaldav, testCaldavConnection,
  buildIcsFeed, getOrCreateIcsFeedToken, parseIcsContent, parseIcalDate
};
