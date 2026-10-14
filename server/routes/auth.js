// Sign-in, two-factor setup and the short-lived tickets for page assets and the realtime socket.
const qrcode = require('qrcode');
const { run, get } = require('../db');
const {
  asyncRoute, loginLimiter, loginLockSeconds, recordLoginFailure, clearLoginFailures, checkTotpLock, recordTotpFailure,
  clearTotpFailures, verifySecondFactor, generateTotpSecret, verifyTotpToken, buildTotpKeyUri, issueMediaTicket,
  issueRealtimeTicket, REALTIME_TICKET_TTL_MS, requireAuth
} = require('../auth');

function mountAuthRoutes(app, {
  normalizeUsername, hashPassword, createSession, generateBackupCodes, revokeUserCredentials, realtimeClients
}) {
  app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
    const username = normalizeUsername(req.body.username);
    const password = String(req.body.password || '');
    const lockedFor = loginLockSeconds(username);
    if (lockedFor > 0) {
      res.setHeader('Retry-After', String(lockedFor));
      return res.status(429).json({ error: `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minutes.` });
    }
    const user = await get('SELECT * FROM users WHERE username = ?', [username]);

    if (!user || hashPassword(password, user.passwordSalt) !== user.passwordHash) {
      recordLoginFailure(username);
      return res.status(401).json({ error: 'Username or password is incorrect.' });
    }
    clearLoginFailures(username);

    if (!user.enabled) {
      return res.status(403).json({ error: 'Your account is pending approval by an administrator.' });
    }

    if (user.totpEnabled) {
      const lockedFor = checkTotpLock(user.id);
      if (lockedFor > 0) {
        return res.status(429).json({ error: `Too many invalid 2FA attempts. Try again in ${Math.ceil(lockedFor / 60)} minutes.` });
      }

      const token = String(req.body.totpToken || '').trim();
      if (!token) {
        return res.status(401).json({ error: '2FA required', requires2FA: true });
      }

      const isValid = await verifySecondFactor(user, token);

      if (!isValid) {
        recordTotpFailure(user.id);
        return res.status(401).json({ error: 'Invalid 2FA code or backup code.' });
      }
      clearTotpFailures(user.id);
    }

    res.json(await createSession(user));
  }));

  app.get('/api/setup/2fa/generate', asyncRoute(async (req, res) => {
    const row = await get('SELECT COUNT(*) AS count FROM users');
    if (row.count > 0) return res.status(403).json({ error: 'Initial setup already complete.' });

    // Use the username the operator typed on the setup screen if provided so
    // the authenticator app shows their actual handle, not the generic
    // "admin" placeholder. The user record itself doesn't exist yet, so we
    // accept the value via querystring without DB validation here.
    const requestedUsername = String(req.query.username || '').trim();
    const safeUsername = /^[A-Za-z0-9._-]{1,64}$/.test(requestedUsername) ? requestedUsername : 'admin';

    const secret = generateTotpSecret();
    const otpauthUrl = buildTotpKeyUri(safeUsername, 'Keeparr', secret);
    const qrCodeUrl = await qrcode.toDataURL(otpauthUrl);

    res.json({ secret, qrCodeUrl });
  }));

  app.get('/api/auth/2fa/generate', requireAuth, asyncRoute(async (req, res) => {
    const secret = generateTotpSecret();
    const otpauthUrl = buildTotpKeyUri(req.user.username, 'Keeparr', secret);
    const qrCodeUrl = await qrcode.toDataURL(otpauthUrl);

    res.json({ secret, qrCodeUrl });
  }));

  app.post('/api/auth/2fa/enable', requireAuth, asyncRoute(async (req, res) => {
    const { secret, token } = req.body;
    if (!secret || !token) return res.status(400).json({ error: 'Secret and token required.' });
    // A session alone must not be enough to set or replace the second factor.
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (hashPassword(String(req.body.currentPassword || ''), user.passwordSalt) !== user.passwordHash) {
      return res.status(400).json({ error: 'Enter your current password to set up 2FA.' });
    }
    if (user.totpEnabled) {
      const lockedFor = checkTotpLock(user.id);
      if (lockedFor > 0) {
        return res.status(429).json({ error: `Too many invalid 2FA attempts. Try again in ${Math.ceil(lockedFor / 60)} minutes.` });
      }
      const current = String(req.body.currentToken || '').trim();
      if (!current || !(await verifySecondFactor(user, current))) {
        recordTotpFailure(user.id);
        return res.status(401).json({ error: 'Enter a current authenticator code or a backup code to replace 2FA.', requires2FA: true });
      }
      clearTotpFailures(user.id);
    }

    const isValid = verifyTotpToken(token, secret);
    if (!isValid) return res.status(400).json({ error: 'Invalid 2FA code.' });

    const backupCodes = generateBackupCodes();
    await run('UPDATE users SET totpSecret = ?, totpEnabled = 1, totpBackupCodes = ? WHERE id = ?',
      [secret, JSON.stringify(backupCodes), req.user.id]);
    await revokeUserCredentials(req.user.id, { exceptSessionHash: req.tokenHash, reason: 'Two-factor authentication changed.', sessionsOnly: true });

    res.json({ success: true, backupCodes });
  }));

  app.delete('/api/auth/2fa/disable', requireAuth, asyncRoute(async (req, res) => {
    // A session alone must not be enough to remove the second factor: it needs a current code or a backup code.
    const user = await get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (user?.totpEnabled) {
      const lockedFor = checkTotpLock(user.id);
      if (lockedFor > 0) {
        return res.status(429).json({ error: `Too many invalid 2FA attempts. Try again in ${Math.ceil(lockedFor / 60)} minutes.` });
      }
      const token = String(req.body?.token || '').trim();
      if (!token) return res.status(401).json({ error: 'Enter a current authenticator code or a backup code to disable 2FA.', requires2FA: true });
      if (!(await verifySecondFactor(user, token))) {
        recordTotpFailure(user.id);
        return res.status(401).json({ error: 'Invalid 2FA code or backup code.' });
      }
      clearTotpFailures(user.id);
    }
    await run('UPDATE users SET totpSecret = NULL, totpEnabled = 0, totpBackupCodes = NULL WHERE id = ?', [req.user.id]);
    await revokeUserCredentials(req.user.id, { exceptSessionHash: req.tokenHash, reason: 'Two-factor authentication changed.', sessionsOnly: true });
    res.json({ success: true });
  }));

  app.post('/api/auth/media-ticket', requireAuth, asyncRoute(async (req, res) => {
    if (req.mcpToken) return res.status(403).json({ error: 'This endpoint is not available to external access tokens.' });
    res.json(await issueMediaTicket(req.user.id));
  }));

  app.post('/api/realtime/ticket', requireAuth, asyncRoute(async (req, res) => {
    if (req.mcpToken) return res.status(403).json({ error: 'This endpoint is not available to external access tokens.' });
    res.json({ ticket: issueRealtimeTicket(req.user.id, req.tokenHash), expiresInSeconds: REALTIME_TICKET_TTL_MS / 1000 });
  }));

  app.post('/api/auth/logout', requireAuth, asyncRoute(async (req, res) => {
    await run('DELETE FROM sessions WHERE token = ?', [req.tokenHash]);
    for (const socket of [...(realtimeClients.get(req.user.id) || [])]) {
      if (socket.sessionHash === req.tokenHash) { try { socket.close(1008, 'Signed out.'); } catch {} }
    }
    res.status(204).end();
  }));
}

module.exports = { mountAuthRoutes };
