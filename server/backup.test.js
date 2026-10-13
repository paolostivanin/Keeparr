// Backups hold the database and the files its rows point at, old automated ones are pruned, and restore brings it all back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const unzipper = require('unzipper');
const { createHarness, sleep } = require('./test-harness');

const form = (buffer, name) => { const data = new FormData(); data.append('backup', new Blob([buffer]), name); return data; };
const entryNames = async file => (await unzipper.Open.file(file)).files.map(entry => entry.path).sort();

test('a backup is a zip with the database, images, attachments, vapid key and a manifest', { timeout: 90_000 }, async t => {
  const harness = createHarness();
  t.after(async () => { await harness.stop(); harness.cleanup(); });
  await harness.start();
  const token = await harness.setupAdmin();
  fs.mkdirSync(harness.uploadDir, { recursive: true });
  fs.mkdirSync(harness.attachmentDir, { recursive: true });
  fs.writeFileSync(path.join(harness.uploadDir, 'picture.png'), 'png-bytes');
  fs.writeFileSync(path.join(harness.attachmentDir, 'report.bin'), 'attachment-bytes');

  const made = await harness.call('/admin/backup/now', { method: 'POST', token });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.match(made.body.filename, /^backup-.*-manual\.zip$/);

  const download = await harness.call(`/admin/backup/download/${made.body.filename}`, { token, raw: true });
  assert.equal(download.status, 200);
  const file = path.join(harness.dataDir, 'downloaded.zip');
  fs.writeFileSync(file, Buffer.from(await download.arrayBuffer()));
  assert.deepEqual(await entryNames(file), ['attachments/report.bin', 'db/keeparr.sqlite', 'manifest.json', 'uploads/picture.png', 'vapid.json']);

  assert.equal((await harness.call(`/admin/backup/download/${made.body.filename}?token=${token}`)).status, 401, 'no header, no download');
  const status = (await harness.call('/admin/backup/status', { token })).body;
  assert.equal(status.keepCount, 7);
  assert.equal(status.files.length, 1);
  assert.ok(status.totalSize > 0 && !('absolutePath' in status));
  assert.equal((await harness.call('/admin/backup/schedule', { method: 'POST', token, body: { backupTime: '25:99' } })).status, 400);
  assert.equal((await harness.call('/admin/backup/schedule', { method: 'POST', token, body: { keepCount: 0 } })).status, 400);
  assert.ok(!fs.readdirSync(path.join(harness.dataDir, 'backups')).some(name => /\.partial$|^\.snapshot-/.test(name)), 'no temporary files are left behind');
});

test('automated backups beyond the keep count are pruned, manual ones never', { timeout: 90_000 }, async t => {
  const harness = createHarness({ env: { KEEPARR_BACKUP_CHECK_MS: '500' } });
  t.after(async () => { await harness.stop(); harness.cleanup(); });
  await harness.start();
  const token = await harness.setupAdmin();
  const directory = path.join(harness.dataDir, 'backups');
  fs.mkdirSync(directory, { recursive: true });
  const plant = (name, daysAgo) => {
    const file = path.join(directory, name);
    fs.writeFileSync(file, 'old');
    const time = new Date(Date.now() - daysAgo * 86_400_000);
    fs.utimesSync(file, time, time);
  };
  ['backup-2020-01-01T00-00-00-000Z.zip', 'backup-2020-01-02T00-00-00-000Z.zip', 'backup-2020-01-03T00-00-00-000Z.sqlite', 'backup-2020-01-04T00-00-00-000Z.zip']
    .forEach((name, index) => plant(name, 40 - index));
  plant('backup-2020-01-01T12-00-00-000Z-manual.zip', 60);

  await harness.call('/admin/backup/schedule', { method: 'POST', token, body: { schedule: 'daily', backupTime: '00:00', keepCount: 2 } });
  let files = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    files = (await harness.call('/admin/backup/status', { token })).body.files.map(file => file.filename);
    if (files.some(name => !name.includes('-manual') && !name.startsWith('backup-2020-'))) break;
    await sleep(500);
  }
  const automated = files.filter(name => !name.includes('-manual'));
  assert.equal(automated.length, 2, `kept the newest two automated backups: ${files.join(', ')}`);
  assert.ok(files.includes('backup-2020-01-01T12-00-00-000Z-manual.zip'), 'the manual backup is untouched');
  assert.ok(automated.includes('backup-2020-01-04T00-00-00-000Z.zip'), 'the newest old one survives');
});

test('restore brings back the database and files and refuses unsafe archives', { timeout: 120_000 }, async t => {
  const source = createHarness();
  t.after(async () => { await source.stop(); source.cleanup(); });
  await source.start();
  const token = await source.setupAdmin('keeper', 'keeper-pass-123');
  fs.mkdirSync(source.uploadDir, { recursive: true });
  fs.mkdirSync(source.attachmentDir, { recursive: true });
  fs.writeFileSync(path.join(source.uploadDir, 'picture.png'), 'png-bytes');
  fs.writeFileSync(path.join(source.attachmentDir, 'report.bin'), 'attachment-bytes');
  const made = (await source.call('/admin/backup/now', { method: 'POST', token })).body.filename;
  const zipBuffer = fs.readFileSync(path.join(source.dataDir, 'backups', made));
  await source.stop();

  // Restore stays off until the operator opts in.
  const closed = createHarness();
  t.after(async () => { await closed.stop(); closed.cleanup(); });
  await closed.start();
  assert.equal((await closed.call('/setup/restore', { method: 'POST', body: form(zipBuffer, 'b.zip') })).status, 403);
  await closed.stop();

  const target = createHarness({ env: { KEEPARR_ALLOW_RESTORE: '1' } });
  t.after(async () => { await target.stop(); target.cleanup(); });
  await target.start();

  const database = new AdmZip(path.join(source.dataDir, 'backups', made)).readFile('db/keeparr.sqlite');
  const manifest = Buffer.from(JSON.stringify({ format: 1, appVersion: 'test', createdAt: new Date().toISOString(), counts: {} }));
  const craft = entries => { const zip = new AdmZip(); for (const [name, data] of entries) zip.addFile(name, data); return zip.toBuffer(); };
  const outside = path.join(path.dirname(target.dataDir), 'evil.txt');
  for (const [label, entries] of [
    ['a path that climbs out', [['manifest.json', manifest], ['db/keeparr.sqlite', database], ['uploads/../../evil.txt', Buffer.from('x')]]],
    ['an unknown top-level entry', [['manifest.json', manifest], ['db/keeparr.sqlite', database], ['etc/passwd', Buffer.from('x')]]],
    ['a missing manifest', [['db/keeparr.sqlite', database]]],
    ['a database that is not SQLite', [['manifest.json', manifest], ['db/keeparr.sqlite', Buffer.from('not a database at all, just text')]]]
  ]) {
    const refused = await target.call('/setup/restore', { method: 'POST', body: form(craft(entries), 'bad.zip') });
    assert.equal(refused.status, 400, `${label}: ${JSON.stringify(refused.body)}`);
  }
  assert.ok(!fs.existsSync(outside), 'nothing was written outside the data directory');
  assert.equal((await target.call('/setup/status')).body.hasUsers, false, 'refused restores leave the instance untouched');

  const restored = await target.call('/setup/restore', { method: 'POST', body: form(zipBuffer, 'good.zip') });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.equal(await target.login('keeper', 'keeper-pass-123').then(() => true), true, 'the restored account signs in');
  assert.equal(fs.readFileSync(path.join(target.uploadDir, 'picture.png'), 'utf8'), 'png-bytes');
  assert.equal(fs.readFileSync(path.join(target.attachmentDir, 'report.bin'), 'utf8'), 'attachment-bytes');
  assert.ok(!fs.existsSync(`${target.sqlitePath}.pre-restore`), 'no rollback file is left after success');
  assert.equal((await target.call('/setup/restore', { method: 'POST', body: form(zipBuffer, 'again.zip') })).status, 403, 'a second restore is refused');
});

test('a database-only .sqlite backup from an older version still restores', { timeout: 90_000 }, async t => {
  const source = createHarness();
  t.after(async () => { await source.stop(); source.cleanup(); });
  await source.start();
  const token = await source.setupAdmin('legacy', 'legacy-pass-123');
  const made = (await source.call('/admin/backup/now', { method: 'POST', token })).body.filename;
  const sqlite = new AdmZip(path.join(source.dataDir, 'backups', made)).readFile('db/keeparr.sqlite');
  await source.stop();

  const target = createHarness({ env: { KEEPARR_ALLOW_RESTORE: '1' } });
  t.after(async () => { await target.stop(); target.cleanup(); });
  await target.start();
  const restored = await target.call('/setup/restore', { method: 'POST', body: form(sqlite, 'old.sqlite') });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  await target.login('legacy', 'legacy-pass-123');
});
