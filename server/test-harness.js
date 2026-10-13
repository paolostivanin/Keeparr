// A throwaway Keeparr server on a temporary data directory, for tests that need the real HTTP surface.
const childProcess = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

function createHarness({ env = {} } = {}) {
  let port = 0;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeparr-test-'));
  const serverEnv = {
    ...process.env, DATA_DIR: dataDir, SQLITE_PATH: path.join(dataDir, 'test.sqlite'),
    UPLOAD_DIR: path.join(dataDir, 'uploads'), ATTACHMENT_DIR: path.join(dataDir, 'attachments'),
    TAKEOUT_TMP_DIR: path.join(dataDir, 'imports', 'tmp'), KEEPARR_TEST_MODE: '1', ...env
  };
  let base = '';
  let child = null;
  let output = '';

  async function start(extraEnv = {}) {
    if (!port) { port = await freePort(); base = `http://127.0.0.1:${port}`; }
    child = childProcess.spawn(process.execPath, ['server/server.js'], { cwd: root, env: { ...serverEnv, PORT: String(port), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    for (let attempt = 0; ; attempt++) {
      try { await fetch(`${base}/api/setup/status`); return; } catch { if (attempt > 300) throw new Error(`server did not start:\n${output}`); await sleep(100); }
    }
  }
  async function stop() {
    if (!child) return;
    const running = child;
    child = null;
    await new Promise(resolve => { if (running.exitCode !== null) return resolve(); running.once('exit', resolve); running.kill('SIGKILL'); });
  }
  async function call(pathname, { token, method = 'GET', body, headers = {}, raw = false } = {}) {
    const response = await fetch(`${base}/api${pathname}`, {
      method,
      headers: { ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : (body instanceof FormData ? body : JSON.stringify(body))
    });
    if (raw) return response;
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    return { status: response.status, body: parsed };
  }
  async function setupAdmin(username = 'admin1', password = 'admin-pass-123') {
    const created = await call('/setup/admin', { method: 'POST', body: { username, displayName: username, password } });
    if (created.status !== 201) throw new Error(`setup failed: ${JSON.stringify(created)}`);
    return login(username, password);
  }
  async function login(username, password) {
    const result = await call('/auth/login', { method: 'POST', body: { username, password } });
    if (result.status !== 200) throw new Error(`login failed: ${JSON.stringify(result)}`);
    return result.body.token;
  }
  function cleanup() { fs.rmSync(dataDir, { recursive: true, force: true }); }
  return { get port() { return port; }, get base() { return base; }, dataDir, sqlitePath: serverEnv.SQLITE_PATH, uploadDir: serverEnv.UPLOAD_DIR, attachmentDir: serverEnv.ATTACHMENT_DIR,
    start, stop, call, setupAdmin, login, cleanup, output: () => output };
}

module.exports = { createHarness, sleep };
