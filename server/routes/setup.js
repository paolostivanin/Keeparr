// First-run setup: the initial administrator and restoring a backup.
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const { asyncRoute, randomHex, resetAuthStateAfterRestore, setupLimiter, verifyTotpToken } = require('../auth');
const { attachmentDir, dataDir, dbPath, uploadDir, vapidPath } = require('../config');
const backupArchive = require('../backup-archive');
const { backupDirectory } = require('../backup');
const { closeDatabase, get, openDatabase, withDatabaseExclusive } = require('../db');
const { createUser, generateBackupCodes, publicUser } = require('../users');
const { init } = require('../init');
const { setAppSetting } = require('../app-settings');

// Optional operator secret for the first-admin form, so whoever reaches a fresh instance first cannot claim it.
function setupTokenMatches(supplied) {
  const expected = String(process.env.KEEPARR_SETUP_TOKEN || '');
  if (!expected) return true;
  const a = Buffer.from(String(supplied || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Setup is checked and applied as one step, so two simultaneous requests cannot both create an administrator.
let setupAdminInProgress = false;

// Refuse before multer writes anything: restore is only possible when the operator enabled it and no user exists yet.
const restoreUpload = multer({ dest: path.join(dataDir, 'backups'), limits: { fileSize: Number(process.env.KEEPARR_RESTORE_MAX_BYTES) || 2 * 1024 * 1024 * 1024, files: 1 } });

function mountSetupRoutes(app) {
  app.get('/api/setup/status', asyncRoute(async (_req, res) => {
    const row = await get('SELECT COUNT(*) AS count FROM users');
    res.json({ hasUsers: row.count > 0, setupTokenRequired: row.count === 0 && !!process.env.KEEPARR_SETUP_TOKEN });
  }));

  app.post('/api/setup/admin', setupLimiter, asyncRoute(async (req, res) => {
    if (setupAdminInProgress) return res.status(409).json({ error: 'Initial setup is already in progress.' });
    setupAdminInProgress = true;
    try {
    const row = await get('SELECT COUNT(*) AS count FROM users');
    if (row.count > 0) return res.status(409).json({ error: 'Initial setup is already complete.' });
    if (!setupTokenMatches(req.body?.setupToken)) return res.status(403).json({ error: 'The setup token is missing or incorrect.' });

    const { totpSecret, totpToken, setupToken: _setupToken, ...userData } = req.body;
    let backupCodes = null;

    if (totpSecret) {
      if (!totpToken) return res.status(400).json({ error: 'A 2FA code is required to enable 2FA.' });
      const isValid = verifyTotpToken(totpToken, totpSecret);
      if (!isValid) return res.status(400).json({ error: 'Invalid 2FA code.' });
      backupCodes = generateBackupCodes();
    }

    const user = await createUser({ ...userData, role: 'admin', totpSecret: totpSecret || null, totpBackupCodes: backupCodes ? JSON.stringify(backupCodes) : null });
    await setAppSetting('originalAdminUserId', String(user.id));
    await setAppSetting('trashRetentionDays', '30');
    res.status(201).json({ user: publicUser(user), backupCodes });
    } finally {
      setupAdminInProgress = false;
    }
  }));

  app.post('/api/setup/restore', setupLimiter, asyncRoute(async (req, res, next) => {
    // Guard: even if all users are deleted, restore must be explicitly enabled
    // by the operator via KEEPARR_ALLOW_RESTORE=1. Otherwise an attacker who can
    // wipe the DB could swap in an arbitrary SQLite to take over.
    if (process.env.KEEPARR_ALLOW_RESTORE !== '1') {
      return res.status(403).json({ error: 'Restore is disabled. Set KEEPARR_ALLOW_RESTORE=1 on the server to enable.' });
    }
    const row = await get('SELECT COUNT(*) AS count FROM users');
    if (row.count > 0) return res.status(403).json({ error: 'Initial setup already complete.' });
    next();
  }), restoreUpload.single('backup'), asyncRoute(async (req, res) => {

    if (!req.file) return res.status(400).json({ error: 'Backup file is required.' });

    const tempPath = req.file.path;
    const stagingDir = path.join(backupDirectory(), `.restore-${randomHex(8)}`);
    const cleanup = () => {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    };

    // Everything is unpacked and checked in a staging directory first; live data is not touched until it all passes.
    let staged;
    try {
      const fd = fs.openSync(tempPath, 'r');
      const header = Buffer.alloc(16);
      fs.readSync(fd, header, 0, 16, 0);
      fs.closeSync(fd);
      if (header.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
        fs.mkdirSync(stagingDir, { recursive: true });
        staged = await backupArchive.extractBackupArchive(tempPath, stagingDir);
      } else if (header.toString('utf8', 0, 16) === 'SQLite format 3\0') {
        staged = { dbPath: tempPath, uploads: [], attachments: [], vapidPath: '' }; // legacy database-only backup
      } else {
        cleanup();
        return res.status(400).json({ error: 'File is not a Keeparr backup (.zip or .sqlite).' });
      }
      await backupArchive.validateBackupDatabase(staged.dbPath);
    } catch (e) {
      cleanup();
      return res.status(400).json({ error: e.message || 'Could not read backup file.' });
    }

    const rollbackPath = `${dbPath}.pre-restore`;
    const copiedFiles = [];
    const removeSqliteSidecars = () => { for (const suffix of ['-wal', '-shm']) { try { fs.rmSync(dbPath + suffix, { force: true }); } catch {} } };
    try {
      await withDatabaseExclusive(async setConnection => {
        await closeDatabase();
        removeSqliteSidecars();
        const hadDatabase = fs.existsSync(dbPath);
        if (hadDatabase) fs.renameSync(dbPath, rollbackPath);
        try {
          fs.copyFileSync(staged.dbPath, dbPath);
          for (const [directory, names, prefix] of [[uploadDir, staged.uploads, 'uploads'], [attachmentDir, staged.attachments, 'attachments']]) {
            for (const name of names) {
              const target = path.join(directory, name);
              try {
                fs.copyFileSync(path.join(stagingDir, prefix, name), target, fs.constants.COPYFILE_EXCL);
                copiedFiles.push(target);
              } catch (error) { if (error.code !== 'EEXIST') throw error; }
            }
          }
          if (staged.vapidPath) fs.copyFileSync(staged.vapidPath, vapidPath);
          setConnection(openDatabase());
          await init();
          resetAuthStateAfterRestore();
        } catch (error) {
          // Put the previous database back and reopen it, so a failed restore leaves the instance as it was.
          await closeDatabase().catch(() => {});
          removeSqliteSidecars();
          for (const file of copiedFiles) { try { fs.unlinkSync(file); } catch {} }
          try { fs.rmSync(dbPath, { force: true }); } catch {}
          if (hadDatabase) fs.renameSync(rollbackPath, dbPath);
          setConnection(openDatabase());
          throw error;
        }
        try { fs.rmSync(rollbackPath, { force: true }); } catch {}
      });
      cleanup();
      res.json({ success: true, files: (staged.uploads?.length || 0) + (staged.attachments?.length || 0) });
    } catch (e) {
      cleanup();
      res.status(500).json({ error: 'Restore failed: ' + e.message });
    }
  }));
}

module.exports = {
  mountSetupRoutes
};
