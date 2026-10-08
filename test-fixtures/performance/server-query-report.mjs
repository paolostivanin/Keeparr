// Profiles the server's read/mutation paths against a seeded SQLite account.
//   node test-fixtures/performance/server-query-report.mjs --notes=10000 --iterations=25 [--json] [--keep]
// Seeds a representative account directly in SQLite (so seeding 10k notes takes seconds), starts the real server on it
// and reports p50/p95 latency and response bytes per endpoint, plus the realtime messages one edit produces.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sqlite3 = require('sqlite3');
const { WebSocket } = require('ws');
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(arg => { const [k, v = 'true'] = arg.replace(/^--/, '').split('='); return [k, v]; }));
const noteCount = Number(args.notes || 10000);
const iterations = Number(args.iterations || 25);
const port = 4300 + Math.floor(Math.random() * 1000);
const dbPath = path.join(tmpdir(), `kept-server-profile-${process.pid}.sqlite`);
const base = `http://127.0.0.1:${port}/api`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(pathname, { token, method = 'GET', body, raw } = {}) {
  const response = await fetch(base + pathname, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok && !raw) throw new Error(`${method} ${pathname}: ${response.status} ${text.slice(0, 200)}`);
  return { status: response.status, text, json: () => JSON.parse(text), bytes: Buffer.byteLength(text) };
}

function startServer() {
  const child = spawn('node', ['server/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath }, stdio: ['ignore', args.trace ? 'inherit' : 'ignore', 'inherit'] });
  return child;
}
async function waitReady(child) {
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) throw new Error('server exited');
    try { await api('/setup/status'); return; } catch { await sleep(150); }
  }
  throw new Error('server did not start');
}
const stop = child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode) return resolve(); child.once('exit', resolve); child.kill('SIGKILL'); });

const db = () => new sqlite3.Database(dbPath);
const exec = (conn, sql, params = []) => new Promise((resolve, reject) => conn.run(sql, params, function (error) { error ? reject(error) : resolve(this); }));

const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa'];
const sentence = seed => Array.from({ length: 12 }, (_, i) => words[(seed * 7 + i * 3) % words.length]).join(' ');

async function seed(owner, other) {
  const conn = db();
  log('seeding');
  await exec(conn, 'PRAGMA foreign_keys = ON');
  await exec(conn, 'BEGIN');
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const labelsFor = i => i % 5 === 0 ? JSON.stringify([{ name: `label${i % 20}`, added: true }]) : '[]';
  for (let i = 0; i < noteCount; i++) {
    const checklist = i % 5 === 1;
    const syncId = `note-${randomUUID()}`;
    const body = checklist ? '' : Array.from({ length: 6 }, (_, p) => `<p>${sentence(i + p)} ${i % 100 === 0 ? 'needle' : ''}</p>`).join('');
    const items = checklist ? JSON.stringify(Array.from({ length: 8 }, (_, n) => ({ id: n + 1, data: sentence(i + n), done: n % 3 === 0 }))) : '[]';
    const ownerId = i % 20 === 19 ? other : owner;
    const inserted = await exec(conn, `INSERT INTO notes (ownerUserId, noteTitle, noteBody, pinned, checkBoxes, isCbox, labels, sortOrder, createdAt, updatedAt, syncId, lwwPhysicalMs, lwwDeviceId, lwwOperationId, trashed, archived)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?, ?)`,
      [ownerId, `Note ${i} ${words[i % words.length]}`, body, items, checklist ? 1 : 0, labelsFor(i), now - (noteCount - i) * 1000, iso, iso, syncId, now, randomUUID(),
        i % 25 === 3 ? 1 : 0, i % 40 === 7 ? 1 : 0]);
    const id = inserted.lastID;
    if (ownerId === other) await exec(conn, 'INSERT OR IGNORE INTO note_collaborators (noteId, userId, createdAt) VALUES (?, ?, ?)', [id, owner, iso]);
    else if (i % 10 === 5) await exec(conn, 'INSERT OR IGNORE INTO note_collaborators (noteId, userId, createdAt) VALUES (?, ?, ?)', [id, other, iso]);
    if (i % 50 === 0) await exec(conn, 'INSERT OR IGNORE INTO user_pins (userId, noteId) VALUES (?, ?)', [owner, id]);
    if (i % 10 === 2) await exec(conn, 'INSERT OR REPLACE INTO user_note_positions (userId, noteId, sortOrder) VALUES (?, ?, ?)', [owner, id, now - i]);
    if (i % 100 === 4) await exec(conn, `INSERT INTO reminders (noteId, userId, dueAtUtc, timezone, status, title, createdAt, updatedAt, syncId, lwwPhysicalMs, scheduleAnchorAtUtc)
      VALUES (?, ?, ?, 'UTC', 'pending', ?, ?, ?, ?, ?, ?)`, [id, owner, new Date(now + 86400000 + i * 60000).toISOString(), `Note ${i}`, iso, iso, `reminder-${randomUUID()}`, now, iso]);
    if (i % 200 === 6) await exec(conn, `INSERT INTO note_attachments (noteId, storedFilename, originalName, fileSize, mimeType, uploadedAt, syncId) VALUES (?, ?, ?, 1000, 'text/plain', ?, ?)`, [id, `${randomUUID()}.txt`, `file-${i}.txt`, iso, `attachment-${randomUUID()}`])
      .catch(() => {});
    if (i >= noteCount - 200) await exec(conn, `INSERT INTO sync_changes (userId, resourceType, resourceSyncId, operation, payload, lwwPhysicalMs, lwwLogical, lwwDeviceId, lwwOperationId, changedAt)
      VALUES (?, 'note', ?, 'upsert', ?, ?, 0, 'seed', ?, ?)`, [owner, syncId, JSON.stringify({ syncId, noteTitle: `Note ${i}`, noteBody: body }), now, randomUUID(), iso]);
  }
  await exec(conn, 'COMMIT');
  await new Promise(resolve => conn.close(resolve));
}

const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; };

async function measure(label, fn) {
  await fn(); // warm the statement/page caches once; steady state is what the p95 should describe
  const times = []; let bytes = 0; let note = '';
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    const result = await fn(i);
    times.push(performance.now() - start);
    bytes = result?.bytes ?? bytes;
    note = result?.note ?? note;
  }
  return { endpoint: label, p50: +percentile(times, .5).toFixed(1), p95: +percentile(times, .95).toFixed(1), bytes, note };
}

async function realtimeMessagesFor(action, token) {
  const messages = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/realtime?token=${token}`);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.on('message', data => messages.push(JSON.parse(String(data))));
  await sleep(300); messages.length = 0;
  await action();
  await sleep(600);
  socket.close();
  return messages.map(message => message.type + (message.action ? `:${message.action}` : ''));
}

const log = message => console.error(`[profile] ${message}`);
process.on('exit', code => { if (code === 0 && !globalThis.profileDone) console.error('[profile] exited before finishing (an awaited promise never settled)'); });

async function main() {
  rmSync(dbPath, { force: true });
  let server = startServer();
  let owner; let other;
  try {
    await waitReady(server); log('server up');
    await api('/setup/admin', { method: 'POST', body: { username: 'profile-owner', displayName: 'Owner', password: 'profile-password-1' } });
    const login = (await api('/auth/login', { method: 'POST', body: { username: 'profile-owner', password: 'profile-password-1' } })).json();
    await api('/users', { token: login.token, method: 'POST', body: { username: 'profile-other', displayName: 'Other', password: 'profile-password-2' } });
    const otherLogin = (await api('/auth/login', { method: 'POST', body: { username: 'profile-other', password: 'profile-password-2' } })).json();
    owner = login.user.id; other = otherLogin.user.id;
    log('users created'); await stop(server); log('server stopped');
    const seedStart = performance.now();
    await seed(owner, other);
    console.error(`seeded ${noteCount} notes in ${Math.round(performance.now() - seedStart)} ms`);
    server = startServer();
    await waitReady(server); log('server restarted on seeded data');
    const token = (await api('/auth/login', { method: 'POST', body: { username: 'profile-owner', password: 'profile-password-1' } })).json().token;
    const otherToken = otherLogin.token;

    const first = (await api('/notes?view=card&limit=80', { token })).json();
    let cursor = first.nextCursor; let midCursor = null; let pages = 1;
    while (cursor && pages < Math.ceil(noteCount / 80 / 2)) { midCursor = cursor; cursor = (await api(`/notes?view=card&limit=80&cursor=${encodeURIComponent(cursor)}`, { token })).json().nextCursor; pages++; }
    const detailId = first.notes[10].id;
    const head = (await api('/sync/bootstrap', { token })).json().cursor;
    const owned = (await api(`/notes/${detailId}`, { token })).json();
    let revision = owned.revision || 1;

    const results = [];
    const get = (label, url, note) => measure(label, async () => { const r = await api(url, { token }); return { bytes: r.bytes, note: note?.(r) }; });
    results.push(await get('GET notes card page 1 (limit 80)', '/notes?view=card&limit=80', r => `${r.json().notes.length} cards`));
    if (midCursor) results.push(await get('GET notes card page mid-account', `/notes?view=card&limit=80&cursor=${encodeURIComponent(midCursor)}`, r => `${r.json().notes.length} cards`));
    results.push(await get('GET notes card search (selective: needle)', '/notes?view=card&limit=80&q=needle', r => `${r.json().notes.length} cards`));
    results.push(await get('GET notes card search (common: alpha)', '/notes?view=card&limit=80&q=alpha', r => `${r.json().notes.length} cards`));
    results.push(await get('GET notes card operator (!todo)', '/notes?view=card&limit=80&q=!todo', r => `${r.json().notes.length} cards`));
    results.push(await get('GET notes/search (summaries, limit 20)', '/notes/search?q=needle', r => `${r.json().length} notes`));
    results.push(await get('GET note detail', `/notes/${detailId}`));
    results.push(await get('GET sync/bootstrap', '/sync/bootstrap', r => `${r.json().notes.length} notes`));
    results.push(await get('GET sync/changes (50 behind head)', `/sync/changes?cursor=${head - 50}`, r => `${r.json().changes.length} changes`));
    results.push(await get('GET sync/changes (at head)', `/sync/changes?cursor=${head}`));
    results.push(await measure('POST sync/mutations note.upsert (1 op)', async () => {
      const current = (await api(`/notes/${detailId}`, { token })).json();
      const r = await api('/sync/mutations', { token, method: 'POST', body: { includeSnapshot: false, mutations: [{ type: 'note.upsert', syncId: current.syncId, operationId: randomUUID(), baseRevision: current.revision, payload: { ...current, noteTitle: `edit ${Math.random()}` } }] } });
      return { bytes: r.bytes, note: r.json().results[0].ok ? 'ok' : JSON.stringify(r.json().results[0]).slice(0, 80) };
    }));
    // After moving one note a client sends the whole visible order plus the position it computed for the moved note (--legacy-reorder
    // sends only the order, as clients that predate `positions` do: every listed note is then rewritten and published).
    const visible = (await api('/sync/bootstrap', { token })).json().notes.filter(note => !note.archived && !note.trashed);
    const order = visible.map(note => note.syncId);
    const changesBefore = (await api('/sync/bootstrap', { token })).json().cursor;
    let moves = 0;
    results.push(await measure(`POST sync/mutations note.reorder (${args['legacy-reorder'] ? 'whole list only' : 'one position'})`, async () => {
      const ids = [...order];
      const at = 40 + (moves++ % 20) * 2;
      [ids[at], ids[at + 1]] = [ids[at + 1], ids[at]];
      const payload = args['legacy-reorder'] ? { syncIds: ids }
        : { syncIds: ids, positions: [{ syncId: ids[at], sortOrder: (visible[at].sortOrder + visible[at + 1].sortOrder) / 2 + (moves % 2 ? 0.5 : 0) }] };
      const r = await api('/sync/mutations', { token, method: 'POST', body: { includeSnapshot: false, mutations: [{ type: 'note.reorder', syncId: 'order', operationId: randomUUID(), payload }] } });
      const result = r.json().results[0];
      return { bytes: r.bytes, note: result.ok ? `${order.length} ids` : JSON.stringify(result).slice(0, 80) };
    }));
    const changesAfter = (await api('/sync/bootstrap', { token })).json().cursor;
    results.push({ endpoint: 'sync_changes rows appended by those moves', p50: 0, p95: 0, bytes: 0, note: `${changesAfter - changesBefore} rows for ${moves} moves (${order.length} visible notes)` });
    results.push(await measure('PUT notes/:id (web full update)', async () => {
      const current = (await api(`/notes/${detailId}`, { token })).json();
      const r = await api(`/notes/${detailId}`, { token, method: 'PUT', body: { ...current, noteTitle: `put ${Math.random()}` }, raw: true });
      return { bytes: r.bytes, note: String(r.status) };
    }));

    // A note shared with the other account: one edit by the owner, observed by the collaborator and by the owner's other device.
    const sharedId = await new Promise(resolve => { const conn = db(); conn.get('SELECT noteId FROM note_collaborators WHERE userId = ? LIMIT 1', [other], (_e, row) => conn.close(() => resolve(row?.noteId ?? detailId))); });
    const edit = async () => {
      const current = (await api(`/notes/${sharedId}`, { token })).json();
      await api(`/notes/${sharedId}`, { token, method: 'PUT', body: { ...current, noteTitle: 'realtime probe' }, raw: true });
    };
    const realtime = {
      collaborator: await realtimeMessagesFor(edit, otherToken),
      ownersOtherDevice: await realtimeMessagesFor(edit, token)
    };

    const report = { notes: noteCount, iterations, results, realtimeMessagesPerWebEdit: realtime };
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Server profile: ${noteCount} notes (node ${process.version}, ${iterations} iterations after one warm-up)`);
      for (const r of results) console.log(`${r.endpoint.padEnd(46)} p50 ${String(r.p50).padStart(7)} ms  p95 ${String(r.p95).padStart(7)} ms  ${String(r.bytes).padStart(9)} bytes  ${r.note || ''}`);
      console.log(`realtime messages for one web edit of a shared note: ${JSON.stringify(realtime)}`);
    }
  } finally {
    await stop(server);
    if (!args.keep) for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });
  }
}
main().then(() => { globalThis.profileDone = true; }).catch(error => { console.error(error); process.exit(1); });
