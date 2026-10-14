// Users and sessions: public shapes, password and backup-code helpers, creating and deleting accounts, and revoking credentials.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { afterDatabaseCommit, all, get, run, withDatabaseTransaction } = require('./db');
const { broadcastRealtime, closeRealtimeClientsForUser } = require('./realtime');
const { deleteAttachmentFilesForNote, deleteImageFilesForNote, safeStoredImageFilename } = require('./files');
const { getAppSetting } = require('./app-settings');
const { mcpTokenHash, randomHex } = require('./auth');
const { uploadDir } = require('./config');

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    theme: user.theme || 'light',
    avatarDataUrl: user.avatarDataUrl || '',
    avatarPreset: user.avatarPreset || 'cat',
    showPastReminders: !!user.showPastReminders,
    totpEnabled: !!user.totpEnabled,
    hasBackupCodes: !!user.totpBackupCodes,
    email: user.email || '',
    enabled: user.enabled !== undefined ? !!user.enabled : true,
    createdAt: user.createdAt,
    demoNotesCreatedAt: user.demoNotesCreatedAt || null
  };
}

function publicCollaborator(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarDataUrl: user.avatarDataUrl || '',
    avatarPreset: user.avatarPreset || 'cat',
    shareCount: user.shareCount || 0
  };
}

function generateBackupCodes() {
  const codes = [];
  for (let i = 0; i < 3; i++) codes.push(randomHex(4).toUpperCase());
  return codes;
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), salt, 120000, 32, 'sha256').toString('hex');
}

function randomAvatarPreset() {
  const presets = ['cat', 'fox', 'bunny', 'bear', 'panda', 'guinea-pig', 'capybara'];
  return presets[Math.floor(Math.random() * presets.length)];
}

const SESSION_TTL_DAYS = Number(process.env.KEEPARR_SESSION_TTL_DAYS || 30);

async function createSession(user) {
  const token = randomHex(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await run(
    'INSERT INTO sessions (token, userId, createdAt, expiresAt, hashed) VALUES (?, ?, ?, ?, 1)',
    [mcpTokenHash(token), user.id, now.toISOString(), expiresAt]
  );
  return { token, user: publicUser(user) };
}

function validateEmail(email) {
  if (!email) return true; // optional for admin-created users
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).trim());
}

async function isOriginalAdminUser(userId) {
  const originalAdminUserId = Number(await getAppSetting('originalAdminUserId', '0'));
  return Number(userId) === originalAdminUserId;
}

async function deleteOwnedFilesForUser(userId) {
  const ownedNotes = await all('SELECT id FROM notes WHERE ownerUserId = ?', [userId]);
  for (const note of ownedNotes) {
    await deleteAttachmentFilesForNote(note.id);
    await deleteImageFilesForNote(note.id);
  }

  const unlinkedImages = await all('SELECT storedFilename FROM note_images WHERE ownerUserId = ? AND noteId IS NULL', [userId]);
  await run('DELETE FROM note_images WHERE ownerUserId = ? AND noteId IS NULL', [userId]);
  for (const row of unlinkedImages) {
    const filename = safeStoredImageFilename(row.storedFilename);
    if (!filename) continue;
    const stillUsed = await get('SELECT id FROM note_images WHERE storedFilename = ? LIMIT 1', [filename]);
    if (stillUsed) continue;
    await run(`UPDATE native_upload_receipts SET state = 'deleted', updatedAt = ?
      WHERE userId = ? AND resourceType = 'image' AND resourceSyncId = ? AND state = 'active'`, [new Date().toISOString(), userId, filename]);
    afterDatabaseCommit(() => { try { fs.unlinkSync(path.join(uploadDir, filename)); } catch {} });
  }
}

async function deleteUserAndOwnedData(userId) {
  await deleteOwnedFilesForUser(userId);
  await run('DELETE FROM users WHERE id = ?', [userId]);
}

async function createUser({ username, displayName, password, role, email, enabled, totpSecret, totpBackupCodes }) {
  const cleanUsername = normalizeUsername(username);
  const cleanDisplayName = String(displayName || '').trim() || cleanUsername;
  const cleanPassword = String(password || '');
  const cleanEmail = email ? String(email).trim() : null;

  if (cleanUsername.length < 3) {
    const error = new Error('Username must be at least 3 characters.');
    error.status = 400;
    throw error;
  }
  if (cleanPassword.length < 8) {
    const error = new Error('Password must be at least 8 characters.');
    error.status = 400;
    throw error;
  }
  if (cleanEmail && !validateEmail(cleanEmail)) {
    const error = new Error('Please enter a valid email address.');
    error.status = 400;
    throw error;
  }

  const passwordSalt = randomHex(16);
  const passwordHash = hashPassword(cleanPassword, passwordSalt);
  const createdAt = new Date().toISOString();
  const isEnabled = enabled !== undefined ? (enabled ? 1 : 0) : 1;

  const hasTotp = !!totpSecret;
  const result = await run(
    `INSERT INTO users (username, displayName, role, passwordHash, passwordSalt, theme, avatarPreset, email, enabled, totpSecret, totpEnabled, totpBackupCodes, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [cleanUsername, cleanDisplayName, role, passwordHash, passwordSalt, 'light', randomAvatarPreset(), cleanEmail, isEnabled, totpSecret || null, hasTotp ? 1 : 0, totpBackupCodes || null, createdAt]
  );
  return await get('SELECT * FROM users WHERE id = ?', [result.id]);
}

// Signs a user out of everything that could still act for them: sessions (optionally keeping one), the local MCP token and
// every OAuth grant with its tokens (unless `sessionsOnly`). Open sockets of the revoked sessions are closed.
async function revokeUserCredentials(userId, { exceptSessionHash = '', reason = 'Signed out.', sessionsOnly = false } = {}) {
  await withDatabaseTransaction(async () => {
    await run('DELETE FROM sessions WHERE userId = ? AND token != ?', [userId, exceptSessionHash]);
    if (sessionsOnly) return;
    await run(`DELETE FROM external_unlock_challenges WHERE userId = ? AND principalType IN ('mcp', 'oauth')`, [userId]);
    await run('DELETE FROM mcp_tokens WHERE userId = ?', [userId]);
    await run('DELETE FROM oauth_grants WHERE userId = ?', [userId]);
  });
  closeRealtimeClientsForUser(userId, reason, exceptSessionHash);
}

async function broadcastProfileUpdate(user) {
  const rows = await all(
    `SELECT ? AS userId
     UNION
     SELECT nc.userId
     FROM notes n
     JOIN note_collaborators nc ON nc.noteId = n.id
     WHERE n.ownerUserId = ?
     UNION
     SELECT n.ownerUserId
     FROM notes n
     JOIN note_collaborators nc ON nc.noteId = n.id
     WHERE nc.userId = ?
     UNION
     SELECT nc2.userId
     FROM note_collaborators nc
     JOIN note_collaborators nc2 ON nc2.noteId = nc.noteId
     WHERE nc.userId = ?`,
    [user.id, user.id, user.id, user.id]
  );
  broadcastRealtime(rows.map(row => row.userId), {
    type: 'profile-updated',
    user: publicCollaborator(user)
  });
}

module.exports = {
  broadcastProfileUpdate, createSession, createUser, deleteUserAndOwnedData, generateBackupCodes, hashPassword, isOriginalAdminUser, normalizeUsername, publicCollaborator, publicUser, revokeUserCredentials, validateEmail
};
