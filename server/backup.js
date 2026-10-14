// Backups: the zip snapshots written to the data directory, the scheduler that takes and prunes them, and the admin
// routes to list, download, create and delete them. Restoring one is handled where the setup and restore routes live.
const fs = require('fs');
const path = require('path');
const backupArchive = require('./backup-archive');
const { dataDir, uploadDir, attachmentDir, vapidPath, KEEPARR_VERSION } = require('./config');
const { withDatabaseLock, vacuumInto } = require('./db');
const { getAppSetting, setAppSetting } = require('./app-settings');
const { asyncRoute, requireAuth, requireAdmin } = require('./auth');

const BACKUP_FILE_PATTERN = /^backup-[A-Za-z0-9._-]+\.(?:zip|sqlite)$/;
const DEFAULT_BACKUP_KEEP_COUNT = 7;
let backupInProgress = false;

function backupDirectory() {
  return path.join(dataDir, 'backups');
}

function normalizeBackupKeepCount(value) {
  const count = Number(value);
  return Number.isInteger(count) && count >= 1 && count <= 60 ? count : null;
}

// Keeps the newest `keep` automated backups. Manual backups are never removed here.
async function pruneAutomatedBackups() {
  const keep = normalizeBackupKeepCount(await getAppSetting('backupKeepCount', DEFAULT_BACKUP_KEEP_COUNT)) ?? DEFAULT_BACKUP_KEEP_COUNT;
  const directory = backupDirectory();
  if (!fs.existsSync(directory)) return;
  const automated = fs.readdirSync(directory)
    .filter(name => BACKUP_FILE_PATTERN.test(name) && !name.includes('-manual'))
    .map(name => ({ name, createdAt: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.createdAt - a.createdAt);
  for (const old of automated.slice(keep)) {
    try { fs.unlinkSync(path.join(directory, old.name)); } catch (error) { console.error('[Backup] could not remove', old.name, error.message); }
  }
}

async function performBackup(isManual = false) {
  if (backupInProgress) throw new Error('A backup is already running.');
  backupInProgress = true;
  const backupDir = backupDirectory();
  fs.mkdirSync(backupDir, { recursive: true });

  const now = new Date().toISOString();
  const timestamp = now.replace(/[:.]/g, '-');
  const filename = `backup-${timestamp}${isManual ? '-manual' : ''}.zip`;
  const destPath = path.join(backupDir, filename);
  const snapshotPath = path.join(backupDir, `.snapshot-${timestamp}.sqlite`);

  try {
    // The database lock is held only while the snapshot is taken; copying the files must not stall other users.
    await withDatabaseLock(() => vacuumInto(snapshotPath));
    await backupArchive.writeBackupArchive({
      destPath, dbSnapshotPath: snapshotPath, uploadDir, attachmentDir, vapidPath, appVersion: KEEPARR_VERSION
    });
  } finally {
    try { fs.unlinkSync(snapshotPath); } catch {}
    backupInProgress = false;
  }
  const setting = isManual ? 'lastManualBackupAt' : 'lastAutomatedBackupAt';
  await setAppSetting(setting, now);
  if (!isManual) await pruneAutomatedBackups();
  return filename;
}

function isBackupInProgress() {
  return backupInProgress;
}

function startBackupScheduler() {
  setInterval(async () => {
    try {
      const schedule = await getAppSetting('backupSchedule', 'none');
      if (schedule === 'none') return;

      const backupTime = await getAppSetting('backupTime', '03:00');
      const lastBackupAt = await getAppSetting('lastAutomatedBackupAt', '');

      const now = new Date();
      const [hour, minute] = backupTime.split(':').map(Number);

      const targetToday = new Date(now);
      targetToday.setHours(hour, minute, 0, 0);


      // Don't backup if target time hasn't passed today
      if (now < targetToday) return;

      if (lastBackupAt) {
        const last = new Date(lastBackupAt);

        // If last backup was today, skip
        const isSameDay = last.getFullYear() === now.getFullYear() &&
                         last.getMonth() === now.getMonth() &&
                         last.getDate() === now.getDate();
        if (isSameDay) return;

        // Check intervals for non-daily schedules
        let daysToWait = 0;
        if (schedule === 'weekly') daysToWait = 7;
        if (schedule === 'monthly') daysToWait = 30;

        if (daysToWait > 0) {
          const diffDays = (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24);
          if (diffDays < daysToWait) return;
        }
      }

      await performBackup();
      await setAppSetting('lastAutomatedBackupAt', now.toISOString());
      console.log(`[Backup] Automated ${schedule} backup completed at ${now.toISOString()}`);
    } catch (err) {
      console.error('Backup scheduler error:', err.message);
    }
  }, Number(process.env.KEEPARR_BACKUP_CHECK_MS) || 60 * 1000); // Check every minute (the override is for tests)
}

function resolveBackupFilePath(filename) {
  // Reject any filename containing path separators or traversal segments
  // before path.join silently normalizes them out of the backup dir.
  if (typeof filename !== 'string') return null;
  if (!BACKUP_FILE_PATTERN.test(filename)) return null;
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) return null;
  const backupDir = path.resolve(backupDirectory());
  const resolved = path.resolve(path.join(backupDir, filename));
  if (resolved !== path.join(backupDir, filename)) return null;
  if (!resolved.startsWith(backupDir + path.sep)) return null;
  return resolved;
}

function mountBackupRoutes(app) {
  app.get('/api/admin/backup/status', requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
    const schedule = await getAppSetting('backupSchedule', 'none');
    const backupTime = await getAppSetting('backupTime', '03:00');
    const lastAutomatedAt = await getAppSetting('lastAutomatedBackupAt', null);
    const lastManualAt = await getAppSetting('lastManualBackupAt', null);
    const keepCount = normalizeBackupKeepCount(await getAppSetting('backupKeepCount', DEFAULT_BACKUP_KEEP_COUNT)) ?? DEFAULT_BACKUP_KEEP_COUNT;
    const backupDir = backupDirectory();
    let files = [];
    if (fs.existsSync(backupDir)) {
      files = fs.readdirSync(backupDir)
        .filter(f => BACKUP_FILE_PATTERN.test(f))
        .map(f => {
          const stats = fs.statSync(path.join(backupDir, f));
          return { filename: f, size: stats.size, createdAt: stats.birthtime };
        })
        .sort((a, b) => b.createdAt - a.createdAt);
    }
    res.json({ schedule, backupTime, keepCount, totalSize: files.reduce((sum, file) => sum + file.size, 0), lastAutomatedAt, lastManualAt, files });
  }));


  app.post('/api/admin/backup/schedule', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const { schedule, backupTime, keepCount } = req.body;
    if (schedule && !['none', 'daily', 'weekly', 'monthly'].includes(schedule)) {
      return res.status(400).json({ error: 'Invalid schedule.' });
    }
    if (backupTime !== undefined && backupTime !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(backupTime))) {
      return res.status(400).json({ error: 'Backup time must be HH:MM.' });
    }
    if (keepCount !== undefined && normalizeBackupKeepCount(keepCount) === null) {
      return res.status(400).json({ error: 'Keep between 1 and 60 backups.' });
    }
    if (schedule) await setAppSetting('backupSchedule', schedule);
    if (backupTime) await setAppSetting('backupTime', backupTime);
    if (keepCount !== undefined) await setAppSetting('backupKeepCount', normalizeBackupKeepCount(keepCount));
    res.json({ success: true, schedule, backupTime, keepCount });
  }));


  app.post('/api/admin/backup/now', requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
    try {
      const filename = await performBackup(true);
      res.json({ success: true, filename });
    } catch (e) {
      res.status(e.message === 'A backup is already running.' ? 409 : 500).json({ error: 'Backup failed: ' + e.message });
    }
  }));

  app.get('/api/admin/backup/download/:filename', requireAuth, requireAdmin, (req, res) => {
    const filePath = resolveBackupFilePath(req.params.filename);
    if (!filePath) return res.status(400).end();
    if (!fs.existsSync(filePath)) return res.status(404).end();
    res.download(filePath);
  });

  app.delete('/api/admin/backup/:filename', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const filePath = resolveBackupFilePath(req.params.filename);
    if (!filePath) return res.status(400).end();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    res.status(204).end();
  }));
}

module.exports = { backupDirectory, isBackupInProgress, startBackupScheduler, mountBackupRoutes };
