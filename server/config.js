// Environment-driven settings, data directories and VAPID keys. Required first, so the directories exist before
// anything opens the database or writes under the data directory.
const fs = require('fs');
const path = require('path');
const webPush = require('web-push');

// How many reverse proxies sit in front of Keeparr (default 1, e.g. Caddy or nginx). Client addresses for rate limits come
// from X-Forwarded-For only that many hops deep; use 0 when the port is reachable directly, or a comma-separated list of
// proxy addresses/subnets. See docs/deployment.md.
const trustProxySetting = String(process.env.KEEPARR_TRUST_PROXY ?? '1').trim();
const port = Number(process.env.PORT || 3000);
const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const uploadDir = process.env.UPLOAD_DIR || path.join(dataDir, 'uploads');
const attachmentDir = process.env.ATTACHMENT_DIR || path.join(dataDir, 'attachments');
const takeoutTmpDir = process.env.TAKEOUT_TMP_DIR || path.join(dataDir, 'imports', 'tmp');
const dbPath = process.env.SQLITE_PATH || path.join(dataDir, 'keeparr.sqlite');
const vapidPath = path.join(dataDir, 'vapid.json');
const staticDir = path.join(__dirname, '..', 'dist', 'keep');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
fs.mkdirSync(attachmentDir, { recursive: true });
fs.mkdirSync(takeoutTmpDir, { recursive: true });

const KEEPARR_VERSION = (() => {
  try {
    return require(path.join(__dirname, '..', 'package.json')).version || '0.0';
  } catch {
    return '0.0';
  }
})();
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/paolostivanin/Keeparr/releases/latest';

function getVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  }

  if (fs.existsSync(vapidPath)) {
    return JSON.parse(fs.readFileSync(vapidPath, 'utf8'));
  }

  const keys = webPush.generateVAPIDKeys();
  fs.writeFileSync(vapidPath, JSON.stringify(keys, null, 2));
  return keys;
}

const vapidKeys = getVapidKeys();
// Apple's APNS gateway (used for iOS web push) validates the VAPID JWT
// `sub` claim and rejects reserved/private TLDs like `.local`, which
// causes pushes to iOS PWAs to silently fail (BadJwtToken). Use a
// publicly-routable mailto or https URL. Override with env var if needed.
const vapidSubject = process.env.VAPID_SUBJECT || 'https://example.com';
webPush.setVapidDetails(vapidSubject, vapidKeys.publicKey, vapidKeys.privateKey);

module.exports = {
  trustProxySetting, port, dataDir, uploadDir, attachmentDir, takeoutTmpDir, dbPath, vapidPath, staticDir,
  KEEPARR_VERSION, GITHUB_RELEASES_URL, vapidKeys
};
