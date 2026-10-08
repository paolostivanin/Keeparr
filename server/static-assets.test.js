const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const compression = require('compression');
const { mountStaticAssets } = require('./static-assets');

async function withApp(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><script src="main-ABCDEF12.js"></script>');
  fs.writeFileSync(path.join(dir, 'main-ABCDEF12.js'), 'console.log("x");'.repeat(200));
  fs.writeFileSync(path.join(dir, 'kept-push-sw.js'), 'self.skipWaiting();');
  fs.writeFileSync(path.join(dir, 'manifest.webmanifest'), '{}');
  const app = express();
  app.use(compression());
  assert.equal(mountStaticAssets(app, dir), true);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('hashed assets are immutable and entry points always revalidate', () => withApp(async origin => {
  const asset = await fetch(`${origin}/main-ABCDEF12.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal(asset.headers.get('content-encoding'), 'gzip', 'responses are compressed for clients that accept gzip');
  for (const entry of ['/', '/kept-push-sw.js', '/manifest.webmanifest', '/settings']) {
    const response = await fetch(origin + entry);
    assert.equal(response.status, 200, entry);
    assert.equal(response.headers.get('cache-control'), 'no-cache', entry);
  }
}));

test('client routes fall back to the shell but missing assets and API paths are 404', () => withApp(async origin => {
  assert.match(await (await fetch(`${origin}/settings/profile`)).text(), /<!doctype html>/);
  for (const missing of ['/chunk-REPLACED1.js', '/styles-OLD12345.css', '/api/not-a-route', '/api/notes/missing/child']) {
    const response = await fetch(origin + missing);
    assert.equal(response.status, 404, missing);
    assert.match(response.headers.get('content-type') || '', /json/, missing);
  }
}));

test('a missing build directory leaves the app unmounted', () => {
  assert.equal(mountStaticAssets(express(), path.join(os.tmpdir(), 'kept-no-such-dir')), false);
});
