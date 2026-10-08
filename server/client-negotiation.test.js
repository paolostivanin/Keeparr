// Old/new client negotiation against a real server process: capability advertisement, clients that predate the
// incremental/positions options, and entries from a future client that this server does not understand.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const port = 5800 + Math.floor(Math.random() * 300);
const dbPath = path.join(os.tmpdir(), `keeparr-negotiation-${process.pid}.sqlite`);
const base = `http://127.0.0.1:${port}/api`;
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

test('older and newer clients negotiate through optional request fields', { timeout: 60_000 }, async () => {
  fs.rmSync(dbPath, { force: true });
  const server = childProcess.spawn('node', ['server/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath }, stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) { try { await fetch(`${base}/setup/status`); break; } catch { if (i > 300) throw new Error('server did not start'); await sleep(100); } }
    await request('/setup/admin', { method: 'POST', body: { username: 'negotiator', displayName: 'N', password: 'negotiation-pass-1' } });
    const { token } = await request('/auth/login', { method: 'POST', body: { username: 'negotiator', password: 'negotiation-pass-1' } });

    const capabilities = await request('/client/capabilities', { token });
    assert.equal(capabilities.idempotentMutations, true);
    assert.equal(capabilities.incrementalMutationResponses, true);
    assert.equal(capabilities.nativeProtocolVersion, 3);

    const ids = [];
    for (const title of ['one', 'two', 'three']) ids.push((await request('/notes', { token, method: 'POST', body: { noteTitle: title, noteBody: '', checkBoxes: [], images: [], labels: [] } })).syncId);
    const mutate = (mutations, extra = {}) => request('/sync/mutations', { token, method: 'POST', body: { mutations, ...extra } });
    const order = async () => (await request('/sync/bootstrap', { token })).notes.map(note => note.syncId);
    const before = await order();
    assert.deepEqual([...before].sort(), [...ids].sort());

    // A client that predates `positions` sends only the full order and still gets it applied, with a full snapshot back.
    const reversed = [...before].reverse();
    const legacy = await mutate([{ type: 'note.reorder', syncId: 'order', operationId: crypto.randomUUID(), payload: { syncIds: reversed } }]);
    assert.equal(legacy.results[0].ok, true, JSON.stringify(legacy.results[0]));
    assert.ok(legacy.snapshot?.notes, 'requests without includeSnapshot=false keep the full-snapshot response');
    assert.deepEqual(await order(), reversed);

    // An operation ID replays instead of applying twice, for clients that retry after a lost response.
    const operationId = crypto.randomUUID();
    const payload = { syncIds: before };
    await mutate([{ type: 'note.reorder', syncId: 'order', operationId, payload }], { includeSnapshot: false });
    const afterFirst = await order();
    await mutate([{ type: 'note.reorder', syncId: 'order', operationId: crypto.randomUUID(), payload: { syncIds: reversed } }], { includeSnapshot: false });
    const replay = await mutate([{ type: 'note.reorder', syncId: 'order', operationId, payload }], { includeSnapshot: false });
    assert.equal(replay.results[0].ok, true);
    assert.deepEqual(await order(), reversed, 'a replayed operation must not re-apply over newer work');
    assert.deepEqual(afterFirst, before);

    // A future client's unknown mutation type fails that entry only; its neighbours still apply.
    const future = await mutate([
      { type: 'note.teleport', syncId: ids[0], operationId: crypto.randomUUID(), payload: {} },
      { type: 'note.view-state', syncId: ids[1], operationId: crypto.randomUUID(), payload: { completedChecklistCollapsed: true } }
    ], { includeSnapshot: false });
    assert.equal(future.results[0].ok, false);
    assert.equal(future.results[0].status, 400);
    assert.equal((await order()).length, ids.length, 'an unknown note type must not create a note');
    assert.equal(future.results[1].ok, true, JSON.stringify(future.results[1]));
    assert.ok(future.serverCursor > 0);
  } finally {
    await new Promise(resolve => { if (server.exitCode !== null) return resolve(); server.once('exit', resolve); server.kill('SIGKILL'); });
    fs.rmSync(dbPath, { force: true });
  }
});
