const compression = require('compression');
const cors = require('cors');
const express = require('express');
const http = require('http');
const multer = require('multer');
const { asyncRoute, oauthRegistrationLimiter, requireAuth, resolveSessionFromToken } = require('./auth');
const { mountBackupRoutes, startBackupScheduler } = require('./backup');
const { mountClientCapabilities } = require('./client-capabilities');
const { KEEPARR_VERSION, dbPath, port, staticDir, trustProxySetting } = require('./config');
const { all, closeDatabase, databaseIdle, get, run, withDatabaseTransaction } = require('./db');
const { startHousekeeping } = require('./housekeeping');
const { init } = require('./init');
const { mountLinkPreviewRoutes } = require('./link-preview');
const { getAccessibleNote, getNoteRecipientIds } = require('./note-data');
const { scheduleStartupMaintenance } = require('./notes');
const { mountOAuthAndMcpRoutes } = require('./oauth-mcp');
const { mountPushRoutes } = require('./push');
const { setupRealtime, terminateRealtimeClients } = require('./realtime');
const { processDueReminders, startReminderScheduler } = require('./reminder-scheduler');
const { mountAdminRoutes } = require('./routes/admin');
const { mountAiRoutes } = require('./routes/ai');
const { mountAuthRoutes } = require('./routes/auth');
const { mountCalendarIntegrationRoutes } = require('./routes/calendar-integrations');
const { mountLabelRoutes } = require('./routes/labels');
const { mountMcpRoutes } = require('./routes/mcp');
const { mountNoteRoutes } = require('./routes/notes');
const { mountReminderRoutes } = require('./routes/reminders');
const { mountSetupRoutes } = require('./routes/setup');
const { mountUploadRoutes } = require('./routes/uploads');
const { mountUserRoutes } = require('./routes/users');
const { mountStaticAssets } = require('./static-assets');
const { mountSyncRoutes } = require('./sync');
const { cleanupStaleTakeoutUploads, mountTakeoutImportRoutes } = require('./takeout-import');
const { armTestFault } = require('./test-faults');
const { createSession } = require('./users');

const app = express();
app.set('trust proxy', /^\d+$/.test(trustProxySetting) ? Number(trustProxySetting)
  : trustProxySetting === 'true' ? true : trustProxySetting === 'false' ? false : trustProxySetting);
app.disable('etag');
app.use(compression());
const server = http.createServer(app);

// CORS configuration.
//
// By default the SPA is served same-origin so no CORS headers are needed.
// Two opt-in modes for cross-origin deployments:
//
//   KEEPARR_CORS_ALLOW_ALL=1
//     Send `Access-Control-Allow-Origin: *` to every request, no credential
//     mode. Fine for personal/family self-hosted instances where you don't
//     want to fight allowlist syntax. Authenticated calls still need a valid
//     Bearer token (Keeparr doesn't use cookies), so an attacker site can't
//     read user data — but it does expose the unauth endpoints (login,
//     register, setup status) to direct browser fetch from anywhere. See
//     docker-compose.yml for the full security tradeoff.
//
//   KEEPARR_CORS_ORIGINS=https://app.example.com,https://keeparr.example.com
//     Comma-separated allowlist. Keeparr also allows exact native-shell origins
//     so the iOS/Android apps can connect while browser access stays pinned
//     to your configured domains. Required if you ever switch Keeparr to
//     cookie-based sessions.
//
// If both are set, the explicit allowlist wins.
const corsAllowlist = String(process.env.KEEPARR_CORS_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const nativeShellOrigins = new Set([
  'capacitor://localhost',
  'ionic://localhost',
  'http://localhost',
  'https://localhost'
]);
if (corsAllowlist.length) {
  const allowedOrigins = new Set([...corsAllowlist, ...nativeShellOrigins]);
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // same-origin / curl
      cb(null, allowedOrigins.has(origin));
    },
    credentials: true
  }));
} else if (process.env.KEEPARR_CORS_ALLOW_ALL === '1') {
  app.use(cors({ origin: '*' }));
}
app.use('/api', (_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
  next();
});
app.use(express.json({ limit: '25mb' }));

mountOAuthAndMcpRoutes(app, {
  get, all, run, withDatabaseTransaction, asyncRoute, requireAuth, resolveSessionFromToken, createSession,
  oauthRegistrationLimiter, internalBaseUrl: `http://127.0.0.1:${port}`
});
mountSetupRoutes(app);

mountAuthRoutes(app);
mountUserRoutes(app);

mountBackupRoutes(app);
mountAdminRoutes(app);

mountMcpRoutes(app);

mountLabelRoutes(app);

mountUploadRoutes(app);

mountClientCapabilities(app, requireAuth, KEEPARR_VERSION);
if (process.env.KEEPARR_TEST_MODE === '1') {
  app.post('/api/test/failpoint', requireAuth, asyncRoute(async (req, res) => {
    try { armTestFault(String(req.body?.name || ''), String(req.body?.mode || 'throw'), req.body?.pauseMs); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    res.json({ ok: true });
  }));
  app.post('/api/test/reminders/tick', requireAuth, asyncRoute(async (req, res) => {
    const timestamp = Date.parse(String(req.body?.now || ''));
    if (!Number.isFinite(timestamp)) return res.status(400).json({ error: 'A valid deterministic tick time is required.' });
    const result = await processDueReminders(new Date(timestamp));
    res.json({ ok: true, now: timestamp, ...result });
  }));
}

mountSyncRoutes(app);
mountNoteRoutes(app);

mountAiRoutes(app);

mountReminderRoutes(app);

mountPushRoutes(app);

mountCalendarIntegrationRoutes(app);

mountLinkPreviewRoutes(app);

mountTakeoutImportRoutes(app);

mountStaticAssets(app, staticDir);

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'File is too large for this upload.'
      : error.message;
    return res.status(400).json({ error: message });
  }
  if (String(error?.message || '').startsWith('Only PNG, JPG, GIF, and WEBP uploads are supported.') || error.message === 'Only ZIP files are supported.' || error.message === 'This file type is not allowed. Supported formats: PDF, Office documents, text files, and archives.') {
    return res.status(400).json({ error: error.message });
  }

  if (error && error.code === 'SQLITE_CONSTRAINT') {
    return res.status(409).json({ error: 'A record with that value already exists.' });
  }

  console.error(error);
  res.status(error.status || 500).json({ error: error.message || 'Server error.' });
});

// A stray rejected promise or socket error must not take the whole server down mid-request.
process.on('unhandledRejection', reason => console.error('Unhandled rejection', reason));
process.on('uncaughtException', error => console.error('Uncaught exception', error));

// Docker stops with SIGTERM: stop taking connections, let queued database work finish, then close the database.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down.`);
  setTimeout(() => process.exit(1), 8000).unref();
  const finish = async () => {
    await databaseIdle();
    await closeDatabase().catch(() => {});
    process.exit(0);
  };
  terminateRealtimeClients();
  server.close(() => { finish(); });
  server.closeIdleConnections?.();
  // Keep-alive connections would hold server.close open; finish even if they linger.
  setTimeout(() => { finish(); }, 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

init().then(() => {
  setupRealtime({ server, getAccessibleNote, getNoteRecipientIds });
  if (process.env.KEEPARR_TEST_MODE !== '1') startReminderScheduler();
  startBackupScheduler();
  startHousekeeping();
  cleanupStaleTakeoutUploads();
  server.listen(port, () => {
    console.log(`Keep API listening on http://127.0.0.1:${port}`);
    console.log(`Keep realtime listening on ws://127.0.0.1:${port}/api/realtime`);
    console.log(`SQLite database: ${dbPath}`);
    scheduleStartupMaintenance();
  });
}).catch(error => {
  console.error(error);
  process.exit(1);
});
