// Hourly cleanup of expired credentials, old idempotency records and leftovers of interrupted backups.
const fs = require('fs');
const path = require('path');
const { run } = require('./db');
const { backupDirectory, isBackupInProgress } = require('./backup');

// Hourly: expired sessions and OAuth rows, and idempotency records no client can still be replaying.
const RECEIPT_RETENTION_DAYS = 90;
async function runHousekeeping() {
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await run('DELETE FROM sessions WHERE expiresAt IS NOT NULL AND expiresAt <= ?', [now]);
  await run('DELETE FROM oauth_pending_authorizations WHERE expiresAt <= ?', [now]);
  await run('DELETE FROM oauth_authorization_codes WHERE expiresAt <= ?', [now]);
  await run('DELETE FROM oauth_access_tokens WHERE expiresAt <= ? OR revokedAt IS NOT NULL', [now]);
  await run('DELETE FROM oauth_refresh_tokens WHERE expiresAt <= ? OR revokedAt IS NOT NULL', [now]);
  await run('DELETE FROM native_mutation_results WHERE createdAt < ?', [cutoff]);
  await run(`DELETE FROM native_upload_receipts WHERE state = 'deleted' AND updatedAt < ?`, [cutoff]);
  // Leftovers of a backup or restore that was interrupted (a stop, a crash): never complete, never listed.
  const directory = backupDirectory();
  if (!isBackupInProgress() && fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      if (!/\.partial$|^\.snapshot-|^\.restore-/.test(name)) continue;
      const full = path.join(directory, name);
      try { if (Date.now() - fs.statSync(full).mtimeMs > 60 * 60 * 1000) fs.rmSync(full, { recursive: true, force: true }); } catch {}
    }
  }
}

function startHousekeeping() {
  const tick = () => runHousekeeping().catch(error => console.error('[Housekeeping] failed:', error.message));
  setTimeout(tick, 30_000).unref?.();
  setInterval(tick, 60 * 60 * 1000).unref?.();
}

module.exports = { startHousekeeping };
