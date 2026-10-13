// Backup archives: one zip holding a consistent database snapshot together with the files its rows point at.
//
//   manifest.json          { format, appVersion, createdAt, counts }
//   db/keeparr.sqlite      VACUUM INTO snapshot
//   uploads/<file>         note images
//   attachments/<file>     note attachments
//   vapid.json             web-push identity (when present)
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { ZipArchive } = require('archiver');
const unzipper = require('unzipper');
const sqlite3 = require('sqlite3');

const FORMAT = 1;
const MANIFEST_ENTRY = 'manifest.json';
const DB_ENTRY = 'db/keeparr.sqlite';
const VAPID_ENTRY = 'vapid.json';
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/;

const DEFAULT_LIMITS = {
  maxEntries: 500_000,
  maxEntryBytes: 5 * 1024 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024 * 1024
};

function filesIn(directory) {
  if (!directory || !fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name);
}

/**
 * Writes `destPath` atomically: the archive is built as `<destPath>.partial` and renamed only when complete, so a crash
 * or SIGTERM never leaves something that looks like a finished backup. Files that disappear while the archive is being
 * written (an image deleted meanwhile) are skipped.
 */
async function writeBackupArchive({ destPath, dbSnapshotPath, uploadDir, attachmentDir, vapidPath, appVersion }) {
  const partialPath = `${destPath}.partial`;
  const output = fs.createWriteStream(partialPath);
  const archive = new ZipArchive({ zlib: { level: 1 } }); // images are already compressed; favour speed
  const counts = { uploads: 0, attachments: 0 };
  const finished = new Promise((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', warning => { if (warning.code !== 'ENOENT') reject(warning); });
  });
  try {
    archive.pipe(output);
    archive.file(dbSnapshotPath, { name: DB_ENTRY });
    for (const [prefix, directory] of [['uploads', uploadDir], ['attachments', attachmentDir]]) {
      for (const name of filesIn(directory)) {
        archive.file(path.join(directory, name), { name: `${prefix}/${name}` });
        counts[prefix] += 1;
      }
    }
    if (vapidPath && fs.existsSync(vapidPath)) archive.file(vapidPath, { name: VAPID_ENTRY });
    archive.append(JSON.stringify({ format: FORMAT, appVersion, createdAt: new Date().toISOString(), counts }, null, 2), { name: MANIFEST_ENTRY });
    await archive.finalize();
    await finished;
    fs.renameSync(partialPath, destPath);
  } catch (error) {
    archive.abort();
    output.destroy();
    try { fs.unlinkSync(partialPath); } catch {}
    throw error;
  }
  return { counts };
}

/** The place an entry of the archive goes, or null when it is not one this format allows. */
function classifyEntry(rawName) {
  const name = String(rawName || '').replace(/\\/g, '/');
  if (!name || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  if (name === MANIFEST_ENTRY) return { kind: 'manifest' };
  if (name === DB_ENTRY) return { kind: 'db' };
  if (name === VAPID_ENTRY) return { kind: 'vapid' };
  const parts = name.split('/');
  if (parts.length === 2 && (parts[0] === 'uploads' || parts[0] === 'attachments')) {
    const file = parts[1];
    if (file === '.' || file === '..' || !FILE_NAME.test(file) || file.includes('..')) return null;
    return { kind: parts[0], file };
  }
  return null;
}

/**
 * Extracts a backup zip into `stagingDir` (which must be empty or new), accepting only the entries of this format.
 * Anything else, including path tricks, fails the whole restore before live data is touched.
 */
async function extractBackupArchive(zipPath, stagingDir, limits = {}) {
  const { maxEntries, maxEntryBytes, maxTotalBytes } = { ...DEFAULT_LIMITS, ...limits };
  const directory = await unzipper.Open.file(zipPath);
  const entries = directory.files.filter(file => file.type !== 'Directory' && !/\/$/.test(file.path));
  if (entries.length > maxEntries) throw new Error('The backup has too many files.');

  fs.mkdirSync(path.join(stagingDir, 'uploads'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'attachments'), { recursive: true });
  fs.mkdirSync(path.join(stagingDir, 'db'), { recursive: true });

  const result = { dbPath: '', vapidPath: '', manifest: null, uploads: [], attachments: [] };
  const seen = new Set();
  let total = 0;
  for (const entry of entries) {
    const target = classifyEntry(entry.path);
    if (!target) throw new Error(`The backup contains an unexpected entry: ${String(entry.path).slice(0, 80)}`);
    const key = entry.path.replace(/\\/g, '/');
    if (seen.has(key)) throw new Error(`The backup lists ${key} twice.`);
    seen.add(key);
    if (Number(entry.uncompressedSize) > maxEntryBytes) throw new Error(`${key} is too large.`);

    const destination = target.kind === 'manifest' ? path.join(stagingDir, MANIFEST_ENTRY)
      : target.kind === 'db' ? path.join(stagingDir, 'db', 'keeparr.sqlite')
      : target.kind === 'vapid' ? path.join(stagingDir, VAPID_ENTRY)
      : path.join(stagingDir, target.kind, target.file);
    // Inflated bytes are counted as they arrive: a declared size cannot be trusted.
    let written = 0;
    const counter = async function* counted(source) {
      for await (const chunk of source) {
        written += chunk.length;
        total += chunk.length;
        if (written > maxEntryBytes || total > maxTotalBytes) throw new Error('The backup expands beyond the safe size limit.');
        yield chunk;
      }
    };
    await pipeline(entry.stream(), counter, fs.createWriteStream(destination, { flags: 'wx' }));

    if (target.kind === 'db') result.dbPath = destination;
    else if (target.kind === 'vapid') result.vapidPath = destination;
    else if (target.kind === 'manifest') {
      try { result.manifest = JSON.parse(fs.readFileSync(destination, 'utf8')); }
      catch { throw new Error('The backup manifest is not valid JSON.'); }
    } else result[target.kind].push(target.file);
  }
  if (!result.manifest || result.manifest.format !== FORMAT) throw new Error('This is not a Keeparr backup, or it was made by a newer version.');
  if (!result.dbPath) throw new Error('The backup does not contain a database.');
  return result;
}

/** Opens a database file read-only and checks that it is intact and is a Keeparr database. */
function validateBackupDatabase(file) {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(file, sqlite3.OPEN_READONLY, openError => {
      if (openError) return reject(new Error('The backup database cannot be opened.'));
      database.all('PRAGMA integrity_check', (checkError, rows) => {
        if (checkError || !rows || rows.length !== 1 || rows[0].integrity_check !== 'ok') {
          return database.close(() => reject(new Error('The backup database failed its integrity check.')));
        }
        database.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`, (tableError, row) => {
          database.close(() => (tableError || !row ? reject(new Error('The backup database is not a Keeparr database.')) : resolve()));
        });
      });
    });
  });
}

module.exports = { writeBackupArchive, extractBackupArchive, validateBackupDatabase, classifyEntry, FORMAT };
