// External token endpoints: who am I, status and unlocking locked notes.
const express = require('express');
const { asyncRoute, randomHex, requireAuth } = require('../auth');
const { escapeHtml, plainText } = require('../note-text');
const { get, run } = require('../db');
const { getAccessibleNote } = require('../note-data');
const { mcpNoteIsUnlocked, verifyNotePasscode } = require('../note-lock');

function mountMcpRoutes(app) {
  app.get('/api/oauth/me', requireAuth, (req, res) => {
    res.json({
      id: req.user.id,
      username: req.user.username,
      displayName: req.user.displayName,
      email: req.user.email || '',
      role: req.user.role
    });
  });

  app.get('/api/mcp/status', requireAuth, (req, res) => {
    res.json({
      enabled: true,
      userId: req.user.id,
      allowLockedNotes: !!req.mcpCapabilities?.allowLockedNotes,
      allowPermanentDelete: !!req.mcpCapabilities?.allowPermanentDelete
    });
  });

  app.post('/api/mcp/locked-notes/:noteId/unlock', requireAuth, asyncRoute(async (req, res) => {
    if (!req.mcpCapabilities?.allowLockedNotes) {
      return res.status(403).json({ error: 'Locked-note access is disabled in Keeparr settings.' });
    }
    const noteId = Number(req.params.noteId);
    const note = await getAccessibleNote(noteId, req.user.id);
    if (!note) return res.status(404).json({ error: 'Note not found.' });
    if (!note.locked) return res.json({ unlocked: true, expiresAt: null });
    if (await mcpNoteIsUnlocked(req, noteId)) return res.json({ unlocked: true, expiresAt: null });

    const challenge = randomHex(32);
    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 10 * 60 * 1000).toISOString();
    await run(
      `INSERT INTO external_unlock_challenges
     (token, principalType, principalId, userId, noteId, approved, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
      [challenge, req.mcpToken.type, req.mcpToken.id, req.user.id, noteId, createdAt.toISOString(), expiresAt]
    );
    const publicOrigin = String(process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    res.status(201).json({
      unlocked: false,
      unlockUrl: `${publicOrigin}/api/mcp/unlock/${challenge}`,
      expiresAt
    });
  }));

  app.get('/api/mcp/locked-notes/:noteId/unlock', requireAuth, asyncRoute(async (req, res) => {
    const noteId = Number(req.params.noteId);
    res.json({ unlocked: await mcpNoteIsUnlocked(req, noteId) });
  }));

  app.get('/api/mcp/unlock/:challenge', asyncRoute(async (req, res) => {
    const challenge = await get(
      `SELECT c.*, n.noteTitle FROM external_unlock_challenges c
     JOIN notes n ON n.id = c.noteId
     WHERE c.token = ? AND c.expiresAt > ?`,
      [String(req.params.challenge || ''), new Date().toISOString()]
    );
    if (!challenge) return res.status(404).send('This unlock request is invalid or has expired.');
    if (challenge.approved) return res.send('This note is already unlocked for external access. You can close this page.');
    const safeTitle = escapeHtml(plainText(challenge.noteTitle || '') || 'Locked note');
    res.type('html').send(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unlock Keeparr note</title><style>body{background:#202124;color:#e8eaed;font:16px system-ui;margin:0;padding:32px}main{max-width:420px;margin:10vh auto}input,button{box-sizing:border-box;font:inherit;width:100%;padding:12px;margin-top:12px}button{background:#fbbc04;border:0;color:#202124;font-weight:700;cursor:pointer}.hint{color:#9aa0a6;font-size:13px}</style></head><body><main><h1>Unlock ${safeTitle}</h1><p>Enter this note's Keeparr passcode. It is sent directly to your Keeparr server and is not shared with the connected client or model.</p><form method="post"><input type="password" name="passcode" autocomplete="current-password" required autofocus><button type="submit">Unlock for 5 minutes</button></form><p class="hint">This only unlocks this note for the requesting connection.</p></main></body></html>`);
  }));

  app.post('/api/mcp/unlock/:challenge', express.urlencoded({ extended: false, limit: '8kb' }), asyncRoute(async (req, res) => {
    const challenge = await get(
      `SELECT c.*, n.locked, n.lockSalt, n.lockHash FROM external_unlock_challenges c
     JOIN notes n ON n.id = c.noteId
     JOIN users u ON u.id = c.userId
     WHERE c.token = ? AND c.expiresAt > ? AND u.mcpAllowLockedNotes = 1
       AND ((c.principalType = 'mcp' AND u.mcpEnabled = 1)
         OR (c.principalType = 'oauth' AND u.oauthEnabled = 1))`,
      [String(req.params.challenge || ''), new Date().toISOString()]
    );
    if (!challenge) return res.status(404).send('This unlock request is invalid or has expired.');
    if (Number(challenge.failedAttempts || 0) >= 5) {
      return res.status(429).send('Too many incorrect attempts. Request a new unlock link from the agent.');
    }
    if (!verifyNotePasscode(challenge, String(req.body?.passcode || ''))) {
      await run('UPDATE external_unlock_challenges SET failedAttempts = failedAttempts + 1 WHERE token = ?', [challenge.token]);
      return res.status(401).send('Incorrect passcode. Go back and try again.');
    }
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await run('UPDATE external_unlock_challenges SET approved = 1, expiresAt = ? WHERE token = ?', [expiresAt, challenge.token]);
    res.send('Note unlocked for external access for five minutes. You can close this page.');
  }));
}

module.exports = {
  mountMcpRoutes
};
