// Scale regression for accounts larger than SQLite's bound-variable limit (32,766): bootstrap must still work and one
// reorder must only write and publish the notes that moved. Seeds the database directly, so it takes seconds.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const root = path.join(__dirname, '..');
const port = 5300 + Math.floor(Math.random() * 500);
const dbPath = path.join(os.tmpdir(), `kept-large-account-${process.pid}.sqlite`);
const base = `http://127.0.0.1:${port}/api`;
const NOTES = 33000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(pathname, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + pathname, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${pathname}: ${response.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const startServer = () => childProcess.spawn('node', ['server/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath }, stdio: 'ignore' });
async function waitReady() { for (let i = 0; i < 300; i++) { try { await fetch(`${base}/setup/status`); return; } catch { await sleep(100); } } throw new Error('server did not start'); }
const stop = child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode) return resolve(); child.once('exit', resolve); child.kill('SIGKILL'); });

test('a 33,000-note account bootstraps and stores a move by writing only the moved note', { timeout: 180_000 }, async () => {
  fs.rmSync(dbPath, { force: true });
  let server = startServer();
  try {
    await waitReady();
    await request('/setup/admin', { method: 'POST', body: { username: 'scale-owner', displayName: 'Scale', password: 'scale-password-1' } });
    await stop(server);

    const db = new sqlite3.Database(dbPath);
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
    await run('BEGIN');
    const now = Date.now();
    for (let i = 0; i < NOTES; i++) {
      await run(`INSERT INTO notes (ownerUserId, noteTitle, noteBody, sortOrder, createdAt, updatedAt, syncId, lwwPhysicalMs, lwwOperationId)
        VALUES (1, ?, '<p>x</p>', ?, 'x', 'x', ?, ?, ?)`, [`n${i}`, now - (NOTES - i), `note-${crypto.randomUUID()}`, now, crypto.randomUUID()]);
    }
    await run(`INSERT INTO note_attachments (noteId, storedFilename, originalName, fileSize, mimeType, uploadedAt, syncId) VALUES (?, 'a.txt', 'a.txt', 1, 'text/plain', 'x', 'attachment-scale')`, [NOTES]);
    await run('COMMIT');
    await new Promise(resolve => db.close(resolve));

    server = startServer();
    await waitReady();
    const { token } = await request('/auth/login', { method: 'POST', body: { username: 'scale-owner', password: 'scale-password-1' } });

    const snapshot = await request('/sync/bootstrap', { token });
    assert.equal(snapshot.notes.length, NOTES, 'bootstrap must not fail on the bound-variable limit');
    assert.equal(snapshot.attachments.length, 1);
    assert.equal(snapshot.notes.filter(note => note.attachments.length).length, 1);

    const order = snapshot.notes.map(note => note.syncId); // newest first, exactly what the clients send back
    const reorder = async payload => request('/sync/mutations', { token, method: 'POST', body: { includeSnapshot: false, mutations: [{ type: 'note.reorder', syncId: 'order', operationId: crypto.randomUUID(), payload }] } });
    const position = syncId => snapshot.notes.find(note => note.syncId === syncId).sortOrder;

    // A client that moved one note sends the whole order (for older servers) and the one position it computed.
    const target = order[5000];
    const newPosition = (position(order[100]) + position(order[101])) / 2;
    const started = performance.now();
    const moved = await reorder({ syncIds: order, positions: [{ syncId: target, sortOrder: newPosition }] });
    assert.equal(moved.results[0].ok, true, JSON.stringify(moved.results[0]));
    assert.equal(moved.results[0].updated, 1);
    assert.ok(performance.now() - started < 5000, 'moving one note must not cost O(account)');
    assert.equal(moved.serverCursor - snapshot.cursor, 1, `one move published ${moved.serverCursor - snapshot.cursor} changes instead of ${NOTES}`);
    const changes = await request(`/sync/changes?cursor=${snapshot.cursor}`, { token });
    assert.deepEqual(changes.changes.map(change => change.resourceSyncId), [target]);
    assert.equal(changes.changes[0].payload.sortOrder, newPosition);

    const same = await reorder({ syncIds: order, positions: [{ syncId: target, sortOrder: newPosition }] });
    assert.equal(same.results[0].updated, 0, 'storing the position a note already has writes nothing');
    assert.equal(same.serverCursor, moved.serverCursor);

    const rejected = await reorder({ positions: [{ syncId: target, sortOrder: 'high' }] });
    assert.equal(rejected.results[0].ok, false);
    assert.equal(rejected.results[0].status, 400);
    const unknown = await reorder({ positions: [{ syncId: 'note-not-mine', sortOrder: 1 }] });
    assert.equal(unknown.results[0].updated, 0, 'positions for notes the user cannot access are ignored');

    // The web client's online path sends the same two things over REST.
    const cursorBeforeRest = (await request('/sync/changes?cursor=0&limit=1', { token })).serverCursor;
    const restTarget = snapshot.notes[9000];
    await request('/notes/reorder', { token, method: 'PATCH', body: { ids: snapshot.notes.map(note => note.id), positions: [{ id: restTarget.id, sortOrder: restTarget.sortOrder + 0.25 }] } });
    assert.equal((await request('/sync/changes?cursor=0&limit=1', { token })).serverCursor - cursorBeforeRest, 1, 'REST reorder with positions publishes only the moved note');

    const after = await request('/sync/bootstrap', { token });
    const expected = [...order];
    expected.splice(expected.indexOf(target), 1);
    expected.splice(101, 0, target);
    assert.deepEqual(after.notes.slice(98, 104).map(note => note.syncId), expected.slice(98, 104), 'the new order is what the next snapshot returns');
  } finally {
    await stop(server);
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});
