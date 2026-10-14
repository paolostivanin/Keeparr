// Locked notes: passcode hashing and what an external token may see of one.
const crypto = require('crypto');
const { get } = require('./db');

function notePasscodeHash(passcode, salt, algorithm = 'pbkdf2') {
  if (algorithm === 'sha256') {
    return crypto.createHash('sha256').update(`${salt}:${passcode}`).digest('base64url');
  }
  return crypto.pbkdf2Sync(String(passcode), String(salt), 150000, 32, 'sha256').toString('base64url');
}

function verifyNotePasscode(note, passcode) {
  const stored = String(note?.lockHash || '');
  const [algorithm, expected] = stored.split(':', 2);
  if (!expected || !['pbkdf2', 'sha256'].includes(algorithm)) return false;
  const actual = notePasscodeHash(passcode, note.lockSalt || '', algorithm);
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function mcpNoteIsUnlocked(req, noteId) {
  if (!req.mcpToken) return true;
  if (!req.mcpCapabilities?.allowLockedNotes) return false;
  const row = await get(
    `SELECT token FROM external_unlock_challenges
     WHERE principalType = ? AND principalId = ? AND noteId = ? AND approved = 1 AND expiresAt > ?
     ORDER BY createdAt DESC LIMIT 1`,
    [req.mcpToken.type, req.mcpToken.id, noteId, new Date().toISOString()]
  );
  return !!row;
}

function mcpNoteResponse(note, includeLockedContent) {
  const result = { ...note };
  delete result.lockSalt;
  delete result.lockHash;
  delete result.ownerAvatarDataUrl;
  delete result.lwwPhysicalMs;
  delete result.lwwLogical;
  delete result.lwwDeviceId;
  delete result.lwwOperationId;
  if (result.locked && !includeLockedContent) {
    result.noteBody = '';
    result.checkBoxes = [];
    result.images = [];
    result.attachments = [];
    result.extraFields = {};
    result.hasAttachments = false;
    result.lockedContentAvailable = false;
  } else if (result.locked) {
    result.lockedContentAvailable = true;
  }
  return result;
}

module.exports = {
  mcpNoteIsUnlocked, mcpNoteResponse, verifyNotePasscode
};
