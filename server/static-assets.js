const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

function mountStaticAssets(app, staticDir) {
  if (!fs.existsSync(staticDir)) return false;

  app.use(express.static(staticDir, {
    setHeaders(response, assetPath) {
      const assetName = path.basename(assetPath);
      if (/-[a-z0-9_-]{8,}\.(?:js|css|woff2?|ttf|svg|png|jpe?g|webp)$/i.test(assetName)) {
        response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        // HTML, manifests, and service-worker scripts must be revalidated so
        // deployments can publish new entry points and worker behavior.
        response.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));
  // Only client-side routes fall back to the app shell. A missing asset (a stale tab asking for a chunk that a newer
  // deployment replaced) or an unknown API path must be a real 404, not HTML the script loader or API client would
  // choke on with a confusing MIME/parse error.
  app.get('*', (request, response) => {
    if (request.path.startsWith('/api/') || path.extname(request.path)) {
      return response.status(404).json({ error: 'Not found.' });
    }
    response.setHeader('Cache-Control', 'no-cache');
    response.sendFile(path.join(staticDir, 'index.html'));
  });
  return true;
}

module.exports = { mountStaticAssets };
