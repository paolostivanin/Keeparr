// Account routes: preferences, MCP and OAuth access, profile, password, user administration and sharing lookups.
const { all, get, run, withDatabaseTransaction } = require('../db');
const { asyncRoute, mcpTokenHash, randomHex, requireAdmin, requireAuth } = require('../auth');
const {
  broadcastProfileUpdate, createUser, deleteUserAndOwnedData, hashPassword, isOriginalAdminUser, publicCollaborator, publicUser, revokeUserCredentials
} = require('../users');
const { broadcastRealtime, realtimeClients } = require('../realtime');
const { getAppSetting, setAppSetting } = require('../app-settings');

function mcpAccessResponse(user, tokenRow) {
  return {
    enabled: !!user.mcpEnabled,
    allowLockedNotes: !!user.mcpAllowLockedNotes,
    allowPermanentDelete: !!user.mcpAllowPermanentDelete,
    token: tokenRow ? {
      prefix: tokenRow.tokenPrefix,
      createdAt: tokenRow.createdAt,
      lastUsedAt: tokenRow.lastUsedAt || null
    } : null
  };
}

function externalCapabilitiesResponse(user) {
  return {
    allowLockedNotes: !!user.mcpAllowLockedNotes,
    allowPermanentDelete: !!user.mcpAllowPermanentDelete
  };
}

function oauthAccessResponse(user, grants) {
  return {
    enabled: !!user.oauthEnabled,
    ...externalCapabilitiesResponse(user),
    connections: grants.map(grant => ({
      id: grant.id,
      clientId: grant.clientId,
      clientName: grant.clientName,
      resource: grant.resource,
      scopes: String(grant.scope || '').split(/\s+/).filter(Boolean),
      authorizedAt: grant.authorizedAt,
      lastUsedAt: grant.lastUsedAt || null
    }))
  };
}

async function oauthGrantsForUser(userId) {
  return await all(
    `SELECT id, clientId, clientName, resource, scope, authorizedAt, lastUsedAt
     FROM oauth_grants WHERE userId = ? ORDER BY authorizedAt DESC`,
    [userId]
  );
}

function mountUserRoutes(app) {
  app.get('/api/users/me/preferences', requireAuth, asyncRoute(async (req, res) => {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(publicUser(user));
  }));

  app.patch('/api/users/me/preferences', requireAuth, asyncRoute(async (req, res) => {
    const assignments = [];
    const params = [];
    if (req.body.theme !== undefined) {
      if (!['light', 'dark'].includes(req.body.theme)) return res.status(400).json({ error: 'Invalid theme.' });
      assignments.push('theme = ?');
      params.push(req.body.theme);
    }
    if (req.body.showPastReminders !== undefined) {
      if (typeof req.body.showPastReminders !== 'boolean') {
        return res.status(400).json({ error: 'showPastReminders must be a boolean.' });
      }
      assignments.push('showPastReminders = ?');
      params.push(req.body.showPastReminders ? 1 : 0);
    }
    if (assignments.length) {
      params.push(req.user.id);
      await run(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
    }
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(publicUser(user));
  }));

  app.get('/api/users/me/mcp-access', requireAuth, asyncRoute(async (req, res) => {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const token = await get('SELECT tokenPrefix, createdAt, lastUsedAt FROM mcp_tokens WHERE userId = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
    res.json(mcpAccessResponse(user, token));
  }));

  app.post('/api/users/me/mcp-access/enable', requireAuth, asyncRoute(async (req, res) => {
    const rawToken = `keeparr_mcp_${randomHex(32)}`;
    const now = new Date().toISOString();
    await withDatabaseTransaction(async () => {
      await run(
        `DELETE FROM external_unlock_challenges
       WHERE principalType = 'mcp' AND principalId IN (SELECT id FROM mcp_tokens WHERE userId = ?)`,
        [req.user.id]
      );
      await run('DELETE FROM mcp_tokens WHERE userId = ?', [req.user.id]);
      await run(
        'INSERT INTO mcp_tokens (userId, tokenHash, tokenPrefix, createdAt) VALUES (?, ?, ?, ?)',
        [req.user.id, mcpTokenHash(rawToken), `${rawToken.slice(0, 17)}…`, now]
      );
      await run('UPDATE users SET mcpEnabled = 1 WHERE id = ?', [req.user.id]);
    });
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const token = await get('SELECT tokenPrefix, createdAt, lastUsedAt FROM mcp_tokens WHERE userId = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
    res.status(201).json({ ...mcpAccessResponse(user, token), accessToken: rawToken });
  }));

  app.patch('/api/users/me/mcp-access', requireAuth, asyncRoute(async (req, res) => {
    const assignments = [];
    const params = [];
    for (const [field, column] of [
      ['allowLockedNotes', 'mcpAllowLockedNotes'],
      ['allowPermanentDelete', 'mcpAllowPermanentDelete']
    ]) {
      if (req.body?.[field] === undefined) continue;
      if (typeof req.body[field] !== 'boolean') return res.status(400).json({ error: `${field} must be a boolean.` });
      assignments.push(`${column} = ?`);
      params.push(req.body[field] ? 1 : 0);
    }
    if (assignments.length) {
      params.push(req.user.id);
      await run(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
    }
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const token = await get('SELECT tokenPrefix, createdAt, lastUsedAt FROM mcp_tokens WHERE userId = ? ORDER BY id DESC LIMIT 1', [req.user.id]);
    res.json(mcpAccessResponse(user, token));
  }));

  app.patch('/api/users/me/external-access/capabilities', requireAuth, asyncRoute(async (req, res) => {
    const assignments = [];
    const params = [];
    for (const [field, column] of [
      ['allowLockedNotes', 'mcpAllowLockedNotes'],
      ['allowPermanentDelete', 'mcpAllowPermanentDelete']
    ]) {
      if (req.body?.[field] === undefined) continue;
      if (typeof req.body[field] !== 'boolean') return res.status(400).json({ error: `${field} must be a boolean.` });
      assignments.push(`${column} = ?`);
      params.push(req.body[field] ? 1 : 0);
    }
    if (assignments.length) {
      params.push(req.user.id);
      await run(`UPDATE users SET ${assignments.join(', ')} WHERE id = ?`, params);
    }
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(externalCapabilitiesResponse(user));
  }));

  app.delete('/api/users/me/mcp-access', requireAuth, asyncRoute(async (req, res) => {
    await withDatabaseTransaction(async () => {
      await run(
        `DELETE FROM external_unlock_challenges
       WHERE principalType = 'mcp' AND principalId IN (SELECT id FROM mcp_tokens WHERE userId = ?)`,
        [req.user.id]
      );
      await run('DELETE FROM mcp_tokens WHERE userId = ?', [req.user.id]);
      await run('UPDATE users SET mcpEnabled = 0 WHERE id = ?', [req.user.id]);
    });
    res.status(204).end();
  }));

  app.get('/api/users/me/oauth-access', requireAuth, asyncRoute(async (req, res) => {
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(oauthAccessResponse(user, await oauthGrantsForUser(req.user.id)));
  }));

  app.post('/api/users/me/oauth-access/enable', requireAuth, asyncRoute(async (req, res) => {
    await run('UPDATE users SET oauthEnabled = 1 WHERE id = ?', [req.user.id]);
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(oauthAccessResponse(user, await oauthGrantsForUser(req.user.id)));
  }));

  app.delete('/api/users/me/oauth-access/connections/:grantId', requireAuth, asyncRoute(async (req, res) => {
    const grantId = Number(req.params.grantId);
    if (!Number.isInteger(grantId) || grantId <= 0) return res.status(400).json({ error: 'Invalid OAuth connection.' });
    const grant = await get('SELECT id FROM oauth_grants WHERE id = ? AND userId = ?', [grantId, req.user.id]);
    if (!grant) return res.status(404).json({ error: 'OAuth connection not found.' });
    await withDatabaseTransaction(async () => {
      await run("DELETE FROM external_unlock_challenges WHERE principalType = 'oauth' AND principalId = ?", [grantId]);
      await run('DELETE FROM oauth_grants WHERE id = ? AND userId = ?', [grantId, req.user.id]);
    });
    res.status(204).end();
  }));

  app.delete('/api/users/me/oauth-access', requireAuth, asyncRoute(async (req, res) => {
    await withDatabaseTransaction(async () => {
      await run(
        `DELETE FROM external_unlock_challenges
       WHERE principalType = 'oauth' AND principalId IN (SELECT id FROM oauth_grants WHERE userId = ?)`,
        [req.user.id]
      );
      await run('DELETE FROM oauth_grants WHERE userId = ?', [req.user.id]);
      await run('UPDATE users SET oauthEnabled = 0 WHERE id = ?', [req.user.id]);
    });
    res.status(204).end();
  }));

  // Marks the user as having had their starter/demo notes created. Idempotent —
  // only sets the timestamp the first time. The client uses this server-side
  // flag (instead of localStorage) so demos appear once across all devices and
  // reliably even when first login goes through the 2FA path.
  app.post('/api/users/me/mark-demo-notes-created', requireAuth, asyncRoute(async (req, res) => {
    if (!req.user.demoNotesCreatedAt) {
      await run('UPDATE users SET demoNotesCreatedAt = ? WHERE id = ?', [new Date().toISOString(), req.user.id]);
    }
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.json(publicUser(user));
  }));

  app.patch('/api/users/me/profile', requireAuth, asyncRoute(async (req, res) => {
    const displayName = String(req.body.displayName || req.user.displayName).trim() || req.user.username;
    const avatarDataUrl = String(req.body.avatarDataUrl || '');
    const avatarPreset = req.body.avatarPreset ? String(req.body.avatarPreset) : req.user.avatarPreset;

    if (avatarDataUrl) {
      // Restrict to raster image data URLs. SVG can carry <script> and is
      // rendered to many places (sharing list, collaborator chips, navbar).
      if (!/^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(avatarDataUrl)) {
        return res.status(400).json({ error: 'Avatar must be a PNG, JPEG, GIF, or WEBP data URL.' });
      }
    }
    if (avatarDataUrl.length > 5000000) {
      return res.status(400).json({ error: 'Avatar image is too large.' });
    }

    await run('UPDATE users SET displayName = ?, avatarDataUrl = ?, avatarPreset = ? WHERE id = ?', [displayName, avatarDataUrl, avatarPreset, req.user.id]);
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    await broadcastProfileUpdate(user);
    res.json(publicUser(user));
  }));

  app.delete('/api/users/me', requireAuth, asyncRoute(async (req, res) => {
    const currentPassword = String(req.body.currentPassword || '');
    const confirmation = String(req.body.confirmation || '');
    if (confirmation !== 'DELETE') {
      return res.status(400).json({ error: 'Type DELETE to confirm account deletion.' });
    }
    if (hashPassword(currentPassword, req.user.passwordSalt) !== req.user.passwordHash) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }

    if (req.user.role === 'admin') {
      const admins = await get(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
      if (admins.count <= 1) return res.status(400).json({ error: 'At least one administrator account is required. Promote another user first.' });
    }

    const deletedUserId = req.user.id;
    await deleteUserAndOwnedData(deletedUserId);
    broadcastRealtime([deletedUserId], { type: 'account-deleted' });
    res.status(204).end();
  }));

  app.get('/api/users', requireAuth, requireAdmin, asyncRoute(async (_req, res) => {
    const users = await all('SELECT * FROM users ORDER BY username');
    res.json(users.map(publicUser));
  }));

  app.post('/api/users', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    const user = await createUser({ ...req.body, role });
    res.status(201).json(publicUser(user));
  }));

  app.delete('/api/users/:id', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const userId = Number(req.params.id);
    if (req.user.id === userId) return res.status(400).json({ error: 'You cannot delete your own account while signed in.' });

    const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (await isOriginalAdminUser(userId)) {
      return res.status(403).json({ error: 'The original administrator account cannot be deleted.' });
    }

    if (user.role === 'admin') {
      const admins = await get(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
      if (admins.count <= 1) return res.status(400).json({ error: 'At least one administrator account is required.' });
    }

    await deleteUserAndOwnedData(userId);
    res.status(204).end();
  }));

  app.patch('/api/users/me/password', requireAuth, asyncRoute(async (req, res) => {
    const currentPassword = String(req.body.currentPassword || '');
    const newPassword = String(req.body.newPassword || '');

    if (hashPassword(currentPassword, req.user.passwordSalt) !== req.user.passwordHash) {
      return res.status(400).json({ error: 'Current password is incorrect.' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }

    const newSalt = randomHex(16);
    const newHash = hashPassword(newPassword, newSalt);
    await run('UPDATE users SET passwordHash = ?, passwordSalt = ? WHERE id = ?', [newHash, newSalt, req.user.id]);
    // Every other device, the MCP token and all OAuth apps must authenticate again; this device stays signed in.
    await revokeUserCredentials(req.user.id, { exceptSessionHash: req.tokenHash, reason: 'Password was changed.' });
    res.json({ success: true });
  }));

  app.patch('/api/users/:id/reset-password', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const userId = Number(req.params.id);
    const newPassword = String(req.body.newPassword || '');

    const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const newSalt = randomHex(16);
    const newHash = hashPassword(newPassword, newSalt);
    await run('UPDATE users SET passwordHash = ?, passwordSalt = ? WHERE id = ?', [newHash, newSalt, userId]);
    // Force the target user to re-authenticate everywhere, including MCP and OAuth access.
    await revokeUserCredentials(userId, { reason: 'Password was reset.' });
    res.json({ success: true });
  }));

  app.patch('/api/users/:id/toggle-enabled', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const userId = Number(req.params.id);
    const enabled = req.body.enabled ? 1 : 0;

    const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });
    if (req.user.id === userId) return res.status(400).json({ error: 'You cannot disable your own account.' });

    await run('UPDATE users SET enabled = ? WHERE id = ?', [enabled, userId]);
    if (!enabled) await revokeUserCredentials(userId, { reason: 'Account disabled.' });
    const updated = await get('SELECT * FROM users WHERE id = ?', [userId]);
    res.json(publicUser(updated));
  }));

  app.get('/api/settings/registration', asyncRoute(async (_req, res) => {
    const selfRegistrationEnabled = await getAppSetting('selfRegistrationEnabled', 'false');
    const requireApproval = await getAppSetting('requireApproval', 'true');
    res.json({
      selfRegistrationEnabled: selfRegistrationEnabled === 'true',
      requireApproval: requireApproval === 'true'
    });
  }));

  app.patch('/api/settings/registration', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    if (req.body.selfRegistrationEnabled !== undefined) {
      await setAppSetting('selfRegistrationEnabled', String(!!req.body.selfRegistrationEnabled));
    }
    if (req.body.requireApproval !== undefined) {
      await setAppSetting('requireApproval', String(!!req.body.requireApproval));
    }
    const selfRegistrationEnabled = await getAppSetting('selfRegistrationEnabled', 'false');
    const requireApproval = await getAppSetting('requireApproval', 'true');
    res.json({
      selfRegistrationEnabled: selfRegistrationEnabled === 'true',
      requireApproval: requireApproval === 'true'
    });
  }));

  app.post('/api/admin/users/:id/disable-2fa', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const userId = parseInt(req.params.id);
    const user = await get('SELECT * FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    await run('UPDATE users SET totpSecret = NULL, totpBackupCodes = NULL, totpEnabled = 0 WHERE id = ?', [userId]);
    await revokeUserCredentials(userId, { reason: 'Two-factor authentication was disabled by an administrator.', sessionsOnly: true });
    res.json({ success: true, message: '2FA disabled for user.' });
  }));

  app.get('/api/sharing/users', requireAuth, asyncRoute(async (req, res) => {
    const users = await all(
      `SELECT users.id, users.username, users.displayName, users.avatarDataUrl, users.avatarPreset,
            COUNT(notes.id) AS shareCount
     FROM users
     LEFT JOIN note_collaborators ON note_collaborators.userId = users.id
     LEFT JOIN notes ON notes.id = note_collaborators.noteId AND notes.ownerUserId = ?
     WHERE users.id != ?
     GROUP BY users.id
     ORDER BY shareCount DESC, users.displayName COLLATE NOCASE, users.username COLLATE NOCASE`,
      [req.user.id, req.user.id]
    );
    res.json(users.map(u => ({
      ...publicCollaborator(u),
      online: realtimeClients.has(u.id)
    })));
  }));

  app.get('/api/users/search', requireAuth, asyncRoute(async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const like = `%${q.toLowerCase()}%`;
    const users = await all(
      `SELECT id, username, displayName, avatarDataUrl, avatarPreset
     FROM users
     WHERE id != ? AND enabled = 1
       AND (lower(username) LIKE ? OR lower(displayName) LIKE ? OR lower(COALESCE(email, '')) LIKE ?)
     ORDER BY displayName COLLATE NOCASE, username COLLATE NOCASE
     LIMIT 20`,
      [req.user.id, like, like, like]
    );
    res.json(users.map(publicCollaborator));
  }));
}

module.exports = {
  mountUserRoutes
};
