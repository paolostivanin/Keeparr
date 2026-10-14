// Administrator update status.
const { KEEPARR_VERSION } = require('../config');
const { asyncRoute, requireAdmin, requireAuth } = require('../auth');
const { compareVersion } = require('../version-compare');
const { createPerfTrace, sendJsonWithPerf } = require('../perf');
const { get, run } = require('../db');
const { getCachedLatestRelease, refreshLatestReleaseInBackground, updateCheckCache } = require('../update-check');

function mountAdminRoutes(app) {
  app.get('/api/admin/update-status', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const trace = createPerfTrace('admin-update-status');
    const latest = getCachedLatestRelease();
    refreshLatestReleaseInBackground();
    trace.mark('cache');

    // Fetch any dismissals this admin has set for the current latest version.
    // A "forever" dismissal silences this version permanently for them; a
    // regular dismissal silences for 30 days.
    let dismissedUntil = null;
    let dismissedForever = false;
    if (latest?.version) {
      const dismissal = await get(
        'SELECT dismissedAt, forever FROM update_dismissals WHERE userId = ? AND version = ?',
        [req.user.id, latest.version]
      );
      trace.mark('dismissal-query', { latest: latest.version, hasDismissal: !!dismissal });
      if (dismissal) {
        dismissedForever = !!dismissal.forever;
        if (!dismissedForever && dismissal.dismissedAt) {
          const until = new Date(new Date(dismissal.dismissedAt).getTime() + 30 * 24 * 60 * 60 * 1000);
          dismissedUntil = until.toISOString();
        }
      }
    } else {
      trace.mark('dismissal-query-skipped');
    }

    const isOutdated = latest?.version ? compareVersion(latest.version, KEEPARR_VERSION) > 0 : false;
    const now = new Date();
    const suppressed =
      dismissedForever ||
      (dismissedUntil && new Date(dismissedUntil) > now);

    sendJsonWithPerf(res, trace, {
      current: KEEPARR_VERSION,
      latest: latest?.version || null,
      releaseUrl: latest?.url || null,
      releaseNotes: latest?.notes || null,
      publishedAt: latest?.publishedAt || null,
      isOutdated,
      suppressed: !!suppressed,
      dismissedForever,
      dismissedUntil,
      checkedAt: updateCheckCache.fetchedAt ? new Date(updateCheckCache.fetchedAt).toISOString() : null,
      checkError: updateCheckCache.error
    });
  }));

  app.post('/api/admin/update-status/dismiss', requireAuth, requireAdmin, asyncRoute(async (req, res) => {
    const version = String(req.body.version || '').trim().replace(/^v/i, '');
    if (!version) return res.status(400).json({ error: 'version is required.' });
    const forever = !!req.body.forever;
    await run(
      `INSERT INTO update_dismissals (userId, version, dismissedAt, forever)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(userId, version) DO UPDATE SET dismissedAt = excluded.dismissedAt, forever = excluded.forever`,
      [req.user.id, version, new Date().toISOString(), forever ? 1 : 0]
    );
    res.status(204).end();
  }));
}

module.exports = {
  mountAdminRoutes
};
