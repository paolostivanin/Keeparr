// Disabling two-factor authentication needs a current authenticator code or a backup code, not just a session.
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateSync } = require('otplib');

const root = path.join(__dirname, '..');
const port = 6100 + Math.floor(Math.random() * 300);
const dbPath = path.join(os.tmpdir(), `keeparr-2fa-${process.pid}.sqlite`);
const base = `http://127.0.0.1:${port}/api`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(pathname, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + pathname, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('2FA can only be disabled with a current code or a backup code', { timeout: 60_000 }, async () => {
  fs.rmSync(dbPath, { force: true });
  const server = childProcess.spawn('node', ['server/server.js'], { cwd: root, env: { ...process.env, PORT: String(port), SQLITE_PATH: dbPath }, stdio: 'ignore' });
  try {
    for (let i = 0; ; i++) { try { await fetch(`${base}/setup/status`); break; } catch { if (i > 300) throw new Error('server did not start'); await sleep(100); } }
    await call('/setup/admin', { method: 'POST', body: { username: 'twofactor', displayName: 'T', password: 'two-factor-pass-1' } });
    const { token } = (await call('/auth/login', { method: 'POST', body: { username: 'twofactor', password: 'two-factor-pass-1' } })).body;

    const enable = async () => {
      const { secret } = (await call('/auth/2fa/generate', { token })).body;
      const enabled = await call('/auth/2fa/enable', { token, method: 'POST', body: { secret, token: generateSync({ secret }) } });
      assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
      return { secret, backupCodes: enabled.body.backupCodes };
    };
    const stillEnabled = async () => (await call('/users/me/preferences', { token })).body.totpEnabled;

    const first = await enable();
    assert.equal(await stillEnabled(), true);

    const bare = await call('/auth/2fa/disable', { token, method: 'DELETE' });
    assert.equal(bare.status, 401, 'a session alone cannot disable 2FA');
    assert.equal(bare.body.requires2FA, true);
    const wrong = await call('/auth/2fa/disable', { token, method: 'DELETE', body: { token: '000000' } });
    assert.equal(wrong.status, 401);
    assert.equal(await stillEnabled(), true, 'a rejected request leaves 2FA on');

    const withCode = await call('/auth/2fa/disable', { token, method: 'DELETE', body: { token: generateSync({ secret: first.secret }) } });
    assert.equal(withCode.status, 200, JSON.stringify(withCode.body));
    assert.equal(await stillEnabled(), false);

    // A backup code works too, and is the only thing needed when the phone is lost.
    const second = await enable();
    const withBackup = await call('/auth/2fa/disable', { token, method: 'DELETE', body: { token: second.backupCodes[0] } });
    assert.equal(withBackup.status, 200, JSON.stringify(withBackup.body));
    assert.equal(await stillEnabled(), false);
  } finally {
    await new Promise(resolve => { if (server.exitCode !== null) return resolve(); server.once('exit', resolve); server.kill('SIGKILL'); });
    fs.rmSync(dbPath, { force: true });
  }
});
