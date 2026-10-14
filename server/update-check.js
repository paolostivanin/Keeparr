// Checks GitHub for a newer Keeparr release. The result is cached for 12 hours and a failed check keeps the last good one.
const https = require('https');
const { GITHUB_RELEASES_URL, KEEPARR_VERSION } = require('./config');

const updateCheckCache = { latest: null, fetchedAt: 0, error: null, inFlight: null };
const UPDATE_CHECK_TTL_MS = 12 * 60 * 60 * 1000;

function fetchLatestRelease() {
  return new Promise((resolve, reject) => {
    const req = https.get(GITHUB_RELEASES_URL, {
      headers: {
        'User-Agent': `Keeparr/${KEEPARR_VERSION}`,
        Accept: 'application/vnd.github+json'
      },
      timeout: 8000
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub returned ${res.statusCode}`));
        try {
          const body = JSON.parse(data);
          resolve({
            version: String(body.tag_name || body.name || '').replace(/^v/i, ''),
            url: body.html_url || `https://github.com/paolostivanin/Keeparr/releases`,
            notes: String(body.body || '').slice(0, 5000),
            publishedAt: body.published_at || null
          });
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function getLatestRelease() {
  const now = Date.now();
  if (updateCheckCache.latest && now - updateCheckCache.fetchedAt < UPDATE_CHECK_TTL_MS) {
    return updateCheckCache.latest;
  }
  if (updateCheckCache.inFlight) return updateCheckCache.inFlight;
  updateCheckCache.inFlight = fetchLatestRelease()
    .then(latest => {
      updateCheckCache.latest = latest;
      updateCheckCache.fetchedAt = Date.now();
      updateCheckCache.error = null;
      return latest;
    })
    .catch(e => {
      updateCheckCache.error = e.message;
      return updateCheckCache.latest;
    })
    .finally(() => {
      updateCheckCache.inFlight = null;
    });
  return updateCheckCache.inFlight;
}

function getCachedLatestRelease() {
  const now = Date.now();
  if (updateCheckCache.latest && now - updateCheckCache.fetchedAt < UPDATE_CHECK_TTL_MS) {
    return updateCheckCache.latest;
  }
  return updateCheckCache.latest;
}

function refreshLatestReleaseInBackground() {
  const now = Date.now();
  if (updateCheckCache.inFlight) return;
  if (updateCheckCache.latest && now - updateCheckCache.fetchedAt < UPDATE_CHECK_TTL_MS) return;
  getLatestRelease().catch(() => undefined);
}

// Fire a check at startup so the first admin who logs in sees it without delay.
setTimeout(() => refreshLatestReleaseInBackground(), 5000).unref?.();

module.exports = { updateCheckCache, getCachedLatestRelease, refreshLatestReleaseInBackground };
