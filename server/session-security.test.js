// Sessions are stored hashed, never travel in URLs, and are revoked together with the other credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3');
const WebSocket = require('ws');
const { createHarness, sleep } = require('./test-harness');

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const query = (file, sql, params = [], write = false) => new Promise((resolve, reject) => {
  const database = new sqlite3.Database(file, write ? sqlite3.OPEN_READWRITE : sqlite3.OPEN_READONLY, openError => {
    if (openError) return reject(openError);
    database.all(sql, params, (error, rows) => database.close(() => (error ? reject(error) : resolve(rows))));
  });
});
const openSocket = (url, headers) => new Promise(resolve => {
  const socket = new WebSocket(url, { headers });
  let ready = false;
  socket.on('message', () => { ready = true; resolve({ socket, ready: true }); });
  socket.on('close', () => { if (!ready) resolve({ socket, ready: false }); });
  socket.on('error', () => undefined);
});

test('sessions are stored hashed, old ones are converted, and URLs never carry a session', { timeout: 90_000 }, async t => {
  const harness = createHarness();
  t.after(async () => { await harness.stop(); harness.cleanup(); });
  await harness.start();
  const token = await harness.setupAdmin();

  const stored = await query(harness.sqlitePath, 'SELECT token FROM sessions');
  assert.ok(stored.length >= 1);
  assert.ok(!stored.some(row => row.token === token), 'the raw session token is not in the database');
  assert.ok(stored.some(row => row.token === sha256(token)), 'its SHA-256 is');

  // A session row from before hashing (raw token, hashed = 0) is converted on the next start and keeps working.
  await harness.stop();
  const legacy = 'a'.repeat(64);
  await query(harness.sqlitePath, `INSERT INTO sessions (token, userId, createdAt, expiresAt, hashed) VALUES (?, 1, ?, ?, 0)`,
    [legacy, new Date().toISOString(), new Date(Date.now() + 86_400_000).toISOString()], true);
  await harness.start();
  assert.equal((await harness.call('/users/me/preferences', { token: legacy })).status, 200, 'a legacy session survives the conversion');
  assert.ok(!(await query(harness.sqlitePath, 'SELECT token FROM sessions')).some(row => row.token === legacy));

  // The session token in a URL is not accepted anywhere.
  assert.equal((await harness.call(`/notes?token=${token}`)).status, 401);
  assert.equal((await harness.call(`/uploads/images/x.png?token=${token}`)).status, 401);

  // A media ticket opens image reads only.
  const { body: media } = await harness.call('/auth/media-ticket', { method: 'POST', token });
  assert.match(media.ticket, /^\d+\.\d+\.[0-9a-f]{64}$/);
  const image = await harness.call(`/uploads/images/missing.png?ticket=${media.ticket}`);
  assert.ok(![401, 403].includes(image.status), `the ticket authorizes the image route (got ${image.status})`);
  assert.equal((await harness.call(`/notes?ticket=${media.ticket}`)).status, 401, 'a ticket is not a login');
  const forged = media.ticket.slice(0, -1) + (media.ticket.endsWith('0') ? '1' : '0'); // always differs from the real signature
  assert.equal((await harness.call(`/uploads/images/missing.png?ticket=${forged}`)).status, 401, 'a forged ticket is refused');
});

test('realtime accepts a single-use ticket or the header, not a token in the URL', { timeout: 90_000 }, async t => {
  const harness = createHarness();
  t.after(async () => { await harness.stop(); harness.cleanup(); });
  await harness.start();
  const token = await harness.setupAdmin();
  const url = `ws://127.0.0.1:${harness.port}/api/realtime`;

  assert.equal((await openSocket(`${url}?token=${token}`)).ready, false, 'a session token in the URL is refused');
  assert.equal((await openSocket(url, { Authorization: `Bearer ${token}` })).ready, true, 'native clients keep using the header');
  const { body } = await harness.call('/realtime/ticket', { method: 'POST', token });
  const first = await openSocket(`${url}?ticket=${body.ticket}`);
  assert.equal(first.ready, true);
  assert.equal((await openSocket(`${url}?ticket=${body.ticket}`)).ready, false, 'a ticket works once');
  first.socket.close();
});

test('changing the password revokes other sessions, MCP and OAuth access, and other sockets, but not this device', { timeout: 90_000 }, async t => {
  const harness = createHarness();
  t.after(async () => { await harness.stop(); harness.cleanup(); });
  await harness.start();
  const here = await harness.setupAdmin('owner', 'owner-pass-123');
  const elsewhere = await harness.login('owner', 'owner-pass-123');
  const mcp = (await harness.call('/users/me/mcp-access/enable', { method: 'POST', token: here, body: {} })).body.accessToken;
  assert.equal((await harness.call('/notes', { token: mcp })).status, 200);

  const url = `ws://127.0.0.1:${harness.port}/api/realtime`;
  const thisSocket = await openSocket(url, { Authorization: `Bearer ${here}` });
  const otherSocket = await openSocket(url, { Authorization: `Bearer ${elsewhere}` });
  assert.ok(thisSocket.ready && otherSocket.ready);

  const changed = await harness.call('/users/me/password', { method: 'PATCH', token: here, body: { currentPassword: 'owner-pass-123', newPassword: 'owner-pass-456' } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  await sleep(300);

  assert.equal((await harness.call('/notes', { token: here })).status, 200, 'this device stays signed in');
  assert.equal((await harness.call('/notes', { token: elsewhere })).status, 401, 'another session is gone');
  assert.equal((await harness.call('/notes', { token: mcp })).status, 401, 'the MCP token is gone');
  assert.equal(otherSocket.socket.readyState, WebSocket.CLOSED, 'the other device socket was closed');
  assert.equal(thisSocket.socket.readyState, WebSocket.OPEN, 'this device socket stays');
  thisSocket.socket.close();
});

test('a session in use is extended to a full lifetime once less than half is left, an expired one is not', { timeout: 90_000 }, async t => {
  const harness = createHarness();
  t.after(async () => { await harness.stop(); harness.cleanup(); });
  await harness.start();
  const ending = await harness.setupAdmin('owner', 'owner-pass-123');
  const recent = await harness.login('owner', 'owner-pass-123');
  const expired = await harness.login('owner', 'owner-pass-123');
  const day = 24 * 60 * 60 * 1000;
  const expiresAt = async token => (await query(harness.sqlitePath, 'SELECT expiresAt FROM sessions WHERE token = ?', [sha256(token)]))[0]?.expiresAt;
  const setExpiresAt = (token, value) => query(harness.sqlitePath, 'UPDATE sessions SET expiresAt = ? WHERE token = ?', [value, sha256(token)], true);

  await harness.stop();
  const recentExpiresAt = new Date(Date.now() + 29 * day).toISOString();
  await setExpiresAt(ending, new Date(Date.now() + day).toISOString());
  await setExpiresAt(recent, recentExpiresAt);
  await setExpiresAt(expired, new Date(Date.now() - 1000).toISOString());
  await harness.start();

  assert.equal((await harness.call('/users/me/preferences', { token: ending })).status, 200);
  const renewed = Date.parse(await expiresAt(ending));
  assert.ok(Math.abs(renewed - (Date.now() + 30 * day)) < 60_000, `a session with one day left runs for 30 more days (got ${new Date(renewed).toISOString()})`);

  assert.equal((await harness.call('/users/me/preferences', { token: recent })).status, 200);
  assert.equal(await expiresAt(recent), recentExpiresAt, 'a session with more than half its lifetime left is not rewritten');

  assert.equal((await harness.call('/users/me/preferences', { token: expired })).status, 401, 'an expired session stays expired');
  assert.equal(await expiresAt(expired), undefined, 'and is not brought back');
});

test('setting up 2FA needs the current password', { timeout: 60_000 }, async t => {
  const harness = createHarness();
  t.after(async () => { await harness.stop(); harness.cleanup(); });
  await harness.start();
  const token = await harness.setupAdmin('secure', 'secure-pass-123');
  const { generateSync } = require('otplib');
  const { secret } = (await harness.call('/auth/2fa/generate', { token })).body;
  const noPassword = await harness.call('/auth/2fa/enable', { method: 'POST', token, body: { secret, token: generateSync({ secret }) } });
  assert.equal(noPassword.status, 400);
  const withPassword = await harness.call('/auth/2fa/enable', { method: 'POST', token, body: { secret, token: generateSync({ secret }), currentPassword: 'secure-pass-123' } });
  assert.equal(withPassword.status, 200, JSON.stringify(withPassword.body));
});
