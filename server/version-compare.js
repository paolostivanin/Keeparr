/**
 * Compares two release versions as major.minor.patch (e.g. "2.0.1", "v2.1"). Strips a leading "v" and any "-prerelease"
 * suffix; missing or non-numeric parts count as 0. Returns -1, 0 or 1.
 */
function compareVersion(a, b) {
  const norm = v => String(v || '0.0.0').replace(/^v/i, '').split('-')[0];
  const pa = norm(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = norm(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

module.exports = { compareVersion };
