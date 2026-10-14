// Request authentication: session, MCP and OAuth bearer tokens, short-lived media and realtime tickets, rate limits and
// sign-in lockouts, and the TOTP helpers behind two-factor sign-in.
const crypto = require('crypto');
const { generateSecret, verifySync, generateURI } = require('otplib');
const { run, get } = require('./db');
const { getAppSetting, setAppSetting } = require('./app-settings');
const { oauthTokenCanCallApi, resolveOAuthAccessToken } = require('./oauth-mcp');

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateTotpSecret() {
  return generateSecret();
}

function verifyTotpToken(token, secret) {
  try {
    const result = verifySync({ token: String(token), secret: String(secret) });
    return !!result.valid;
  } catch (e) {
    return false;
  }
}

function buildTotpKeyUri(username, issuer, secret) {
  return generateURI({ username, issuer, secret, label: username });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

// ─── Rate limiting ─────────────────────────────────────────────────────────
const rateBuckets = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const bucketKey = `${key}:${(typeof key === 'function' ? key(req) : req.ip)}`;
    const now = Date.now();
    let bucket = rateBuckets.get(bucketKey);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}
// Periodically prune stale buckets to keep memory bounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
}, 60_000).unref?.();

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, key: 'login' });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, key: 'register' });
const setupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, key: 'setup' });
const oauthRegistrationLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: 'oauth-register' });

// Failed passwords per account, regardless of address: rotating client addresses must not give unlimited guesses.
const loginFailures = new Map(); // username -> { count, lockedUntil }
function loginLockSeconds(username) {
  const entry = loginFailures.get(username);
  return entry?.lockedUntil > Date.now() ? Math.ceil((entry.lockedUntil - Date.now()) / 1000) : 0;
}
function recordLoginFailure(username) {
  const entry = loginFailures.get(username) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= 10) { entry.lockedUntil = Date.now() + 15 * 60 * 1000; entry.count = 0; }
  loginFailures.set(username, entry);
  if (loginFailures.size > 10_000) for (const [name, value] of loginFailures) if (value.lockedUntil <= Date.now() && !value.count) loginFailures.delete(name);
}

const totpFailures = new Map(); // userId -> { count, lockedUntil }
function checkTotpLock(userId) {
  const entry = totpFailures.get(userId);
  if (entry?.lockedUntil && entry.lockedUntil > Date.now()) {
    return Math.ceil((entry.lockedUntil - Date.now()) / 1000);
  }
  return 0;
}
function recordTotpFailure(userId) {
  const entry = totpFailures.get(userId) || { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= 5) {
    entry.lockedUntil = Date.now() + 15 * 60 * 1000;
    entry.count = 0;
  }
  totpFailures.set(userId, entry);
}
function clearTotpFailures(userId) { totpFailures.delete(userId); }

// A current authenticator code (6 digits) or an unused backup code (8 characters, consumed on use).
async function verifySecondFactor(user, token) {
  if (token.length === 6) return verifyTotpToken(token, user.totpSecret);
  if (token.length === 8 && user.totpBackupCodes) {
    let backupCodes = [];
    try { backupCodes = JSON.parse(user.totpBackupCodes); } catch {}
    const codeIndex = backupCodes.indexOf(token.toUpperCase());
    if (codeIndex > -1) {
      backupCodes.splice(codeIndex, 1);
      await run('UPDATE users SET totpBackupCodes = ? WHERE id = ?', [JSON.stringify(backupCodes), user.id]);
      return true;
    }
  }
  return false;
}

async function resolveSessionFromToken(token) {
  if (!token) return null;
  return await get(
    `SELECT users.*, sessions.expiresAt AS sessionExpiresAt FROM sessions
     JOIN users ON users.id = sessions.userId
     WHERE sessions.token = ? AND users.enabled = 1
       AND (sessions.expiresAt IS NULL OR sessions.expiresAt > ?)`,
    [mcpTokenHash(token), new Date().toISOString()]
  );
}

function mcpTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

// Page assets (<img src>) and WebSockets cannot send an Authorization header. They use short-lived tickets instead of the
// session token, so the session never appears in a URL, a proxy log or a Referer header.
// A media ticket is stateless and read-only: it is accepted only by requireAuthOrMediaTicket (image and image-proxy GETs).
const MEDIA_TICKET_TTL_MS = 2 * 60 * 60 * 1000;
let urlTicketSecretCache = '';
async function urlTicketSecret() {
  if (urlTicketSecretCache) return urlTicketSecretCache;
  let secret = await getAppSetting('urlTicketSecret', '');
  if (!secret) {
    secret = randomHex(32);
    await setAppSetting('urlTicketSecret', secret);
  }
  urlTicketSecretCache = secret;
  return secret;
}
async function mediaTicketSignature(userId, expires) {
  return crypto.createHmac('sha256', await urlTicketSecret()).update(`media|${userId}|${expires}`).digest('hex');
}
async function issueMediaTicket(userId) {
  const expires = Date.now() + MEDIA_TICKET_TTL_MS;
  return { ticket: `${userId}.${expires}.${await mediaTicketSignature(userId, expires)}`, expiresAt: new Date(expires).toISOString() };
}
async function resolveMediaTicket(ticket) {
  const match = /^(\d{1,12})\.(\d{10,16})\.([0-9a-f]{64})$/.exec(String(ticket || ''));
  if (!match) return null;
  const [, userId, expires, signature] = match;
  if (Number(expires) <= Date.now()) return null;
  const expected = await mediaTicketSignature(userId, expires);
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  return await get('SELECT * FROM users WHERE id = ? AND enabled = 1', [Number(userId)]);
}

// Realtime tickets are single use and live for seconds; they remember which session asked, so that session's socket can
// later be told apart from the user's other devices.
const REALTIME_TICKET_TTL_MS = 30 * 1000;
const realtimeTickets = new Map(); // ticket -> { userId, sessionHash, expires }
function issueRealtimeTicket(userId, sessionHash) {
  const now = Date.now();
  for (const [key, value] of realtimeTickets) if (value.expires <= now) realtimeTickets.delete(key);
  const ticket = randomHex(24);
  realtimeTickets.set(ticket, { userId, sessionHash, expires: now + REALTIME_TICKET_TTL_MS });
  return ticket;
}
function redeemRealtimeTicket(ticket) {
  const entry = realtimeTickets.get(String(ticket || ''));
  realtimeTickets.delete(String(ticket || ''));
  return entry && entry.expires > Date.now() ? entry : null;
}

async function resolveMcpToken(token) {
  if (String(token || '').startsWith('keeparr_oauth_')) {
    return await resolveOAuthAccessToken(token, { get });
  }
  if (!String(token || '').startsWith('keeparr_mcp_')) return null;
  return await get(
    `SELECT users.*, mcp_tokens.id AS mcpTokenId, mcp_tokens.tokenPrefix
     FROM mcp_tokens
     JOIN users ON users.id = mcp_tokens.userId
     WHERE mcp_tokens.tokenHash = ? AND users.enabled = 1 AND users.mcpEnabled = 1`,
    [mcpTokenHash(token)]
  );
}

function isAllowedMcpApiRequest(method, requestPath) {
  const pathOnly = String(requestPath || '').split('?')[0];
  const rules = [
    ['GET', /^\/api\/mcp\/(?:status|locked-notes\/\d+\/unlock)$/],
    ['GET', /^\/api\/(?:oauth\/me|labels|users\/search|notes|notes\/search|reminders)$/],
    ['GET', /^\/api\/(?:notes\/\d+|notes\/\d+\/collaborators|attachments\/\d+|uploads\/images\/[^/]+)$/],
    ['POST', /^\/api\/(?:labels|labels\/find-or-create|notes|reminders|uploads\/images)$/],
    ['POST', /^\/api\/(?:notes\/\d+\/attachments|notes\/\d+\/collaborators\/rejoin|mcp\/locked-notes\/\d+\/unlock)$/],
    ['PUT', /^\/api\/notes\/\d+(?:\/collaborators)?$/],
    ['PATCH', /^\/api\/(?:notes\/\d+|reminders\/\d+|labels\/\d+)$/],
    ['DELETE', /^\/api\/(?:notes\/\d+|notes\/\d+\/attachments\/\d+|reminders\/\d+|labels\/\d+)$/]
  ];
  return rules.some(([allowedMethod, pattern]) => method === allowedMethod && pattern.test(pathOnly));
}

function hasOAuthScope(access, scope) {
  return String(access?.oauthScope || '').split(/\s+/).includes(scope);
}

function sendAuthenticationRequired(req, res) {
  const origin = String(process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  res.set('WWW-Authenticate', `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/api"`);
  return res.status(401).json({ error: 'Authentication required.' });
}

function auditExternalRequest(req, res) {
  if (!req.mcpToken || req.method === 'GET') return;
  res.on('finish', () => {
    const table = req.mcpToken.type === 'oauth' ? 'oauth_audit_events' : 'mcp_audit_events';
    const idColumn = req.mcpToken.type === 'oauth' ? 'grantId' : 'mcpTokenId';
    run(
      `INSERT INTO ${table} (userId, ${idColumn}, method, path, status, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.id, req.mcpToken.id, req.method, req.path, res.statusCode, new Date().toISOString()]
    ).catch(() => undefined);
  });
}

function trackExternalAccessUse(access) {
  const now = new Date().toISOString();
  if (access.oauthClientId) {
    return run('UPDATE oauth_grants SET lastUsedAt = ? WHERE id = ?', [now, access.oauthGrantId]);
  }
  return run('UPDATE mcp_tokens SET lastUsedAt = ? WHERE id = ?', [now, access.mcpTokenId]);
}

async function requireAuth(req, res, next) {
  const perfAuthStart = process.hrtime.bigint();
  try {
    const header = req.header('authorization') || '';
    // Token must be in the Authorization header — querystring tokens leak via
    // logs and Referer. (WebSocket and ICS feed endpoints intentionally do
    // their own token handling.)
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!token) return sendAuthenticationRequired(req, res);

    let session = await resolveSessionFromToken(token);
    let mcpAccess = null;
    if (!session) mcpAccess = await resolveMcpToken(token);
    if (!session && !mcpAccess) return sendAuthenticationRequired(req, res);
    if (mcpAccess && !isAllowedMcpApiRequest(req.method, req.originalUrl || req.path)) {
      return res.status(403).json({ error: 'This endpoint is not available to external access tokens.' });
    }
    if (mcpAccess?.oauthClientId) {
      if (!oauthTokenCanCallApi(mcpAccess, req)) {
        return res.status(403).json({ error: 'This OAuth token was issued for a different protected resource.' });
      }
      const requiredScope = ['GET', 'HEAD'].includes(req.method) ? 'keeparr.read' : 'keeparr.write';
      if (!hasOAuthScope(mcpAccess, requiredScope)) {
        res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${requiredScope}"`);
        return res.status(403).json({ error: `This OAuth token does not have the ${requiredScope} scope.` });
      }
    }

    session = session || mcpAccess;

    req.user = session;
    req.token = token;
    req.tokenHash = mcpTokenHash(token);
    if (mcpAccess) {
      req.mcpToken = mcpAccess.oauthClientId
        ? { id: mcpAccess.oauthGrantId, type: 'oauth', prefix: mcpAccess.oauthClientId }
        : { id: mcpAccess.mcpTokenId, type: 'mcp', prefix: mcpAccess.tokenPrefix };
      req.mcpCapabilities = {
        allowLockedNotes: !!mcpAccess.mcpAllowLockedNotes,
        allowPermanentDelete: !!mcpAccess.mcpAllowPermanentDelete
      };
      auditExternalRequest(req, res);
      trackExternalAccessUse(mcpAccess).catch(() => undefined);
    }
    if (req.path === '/api/notes' || req.path === '/api/admin/update-status') {
      const authMs = Number(process.hrtime.bigint() - perfAuthStart) / 1e6;
      console.log(`[KeeparrPerf:server] auth ${req.method} ${req.path} ${authMs.toFixed(1)}ms`);
    }
    next();
  } catch (error) {
    next(error);
  }
}

// For endpoints loaded as page assets (<img src>) where the browser cannot attach an Authorization header: the header as
// usual, or a short-lived read-only media ticket in `?ticket=`. A session token in the URL is never accepted.
async function requireAuthOrMediaTicket(req, res, next) {
  try {
    if ((req.header('authorization') || '').startsWith('Bearer ')) return requireAuth(req, res, next);
    const user = await resolveMediaTicket(req.query.ticket);
    if (!user) return sendAuthenticationRequired(req, res);
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

function clearLoginFailures(username) {
  loginFailures.delete(username);
}

// A restored database carries its own ticket secret, and the lockout counters belong to the database it replaced.
function resetAuthStateAfterRestore() {
  urlTicketSecretCache = '';
  loginFailures.clear();
}

module.exports = {
  randomHex, mcpTokenHash, generateTotpSecret, verifyTotpToken, buildTotpKeyUri,
  asyncRoute, rateLimit, loginLimiter, registerLimiter, setupLimiter, oauthRegistrationLimiter,
  loginLockSeconds, recordLoginFailure, clearLoginFailures, checkTotpLock, recordTotpFailure, clearTotpFailures,
  verifySecondFactor, resolveSessionFromToken, issueMediaTicket, issueRealtimeTicket, redeemRealtimeTicket,
  REALTIME_TICKET_TTL_MS, requireAuth, requireAuthOrMediaTicket, requireAdmin, resetAuthStateAfterRestore
};
