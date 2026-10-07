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
  app.get('*', (_request, response) => response.sendFile(path.join(staticDir, 'index.html')));
  return true;
}

module.exports = { mountStaticAssets };
