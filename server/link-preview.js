// Link previews for note URLs (Open Graph metadata) and an image proxy, both fetched through the public-network guard.
const http = require('http');
const https = require('https');
const { publicRequestOptions } = require('./public-network');
const { asyncRoute, requireAuth, requireAuthOrMediaTicket } = require('./auth');

const linkPreviewCache = new Map(); // url -> { data, fetchedAt }
const LINK_PREVIEW_CACHE_MAX = 500;

function fetchHtml(url, maxRedirects = 4) {
  return new Promise((resolve, reject) => {
    async function doFetch(currentUrl, hopsLeft) {
      let parsed;
      try { parsed = new URL(currentUrl); } catch (e) { return reject(e); }
      if (!['http:', 'https:'].includes(parsed.protocol)) return reject(new Error('Unsupported protocol'));
      let requestOptions;
      try {
        requestOptions = await publicRequestOptions(currentUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          },
          timeout: 8000
        });
      } catch (e) { return reject(e); }
      const mod = parsed.protocol === 'https:' ? require('https') : require('http');
      const req = mod.get(currentUrl, requestOptions, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hopsLeft > 0) {
          res.resume();
          const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, currentUrl).href;
          return doFetch(next, hopsLeft - 1);
        }
        let data = '';
        res.on('data', chunk => { data += chunk; if (data.length > 500000) { req.destroy(); resolve(data); } });
        res.on('end', () => resolve(data));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.on('error', reject);
    }
    doFetch(url, maxRedirects);
  });
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseAttributes(tag) {
  const attrs = {};
  tag.replace(/([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_m, key, dq, sq, bare) => {
    attrs[key.toLowerCase()] = decodeHtml(dq ?? sq ?? bare ?? '').trim();
    return '';
  });
  return attrs;
}

function absolutizeUrl(value, baseUrl) {
  if (!value) return null;
  const cleaned = decodeHtml(value).trim();
  if (!cleaned || /^data:|^javascript:/i.test(cleaned)) return null;
  try { return new URL(cleaned, baseUrl).href; } catch { return null; }
}

function bestSrcsetUrl(value) {
  let best = null;
  for (const candidate of String(value || '').split(',')) {
    const parts = candidate.trim().split(/\s+/);
    const url = parts[0] || '';
    const descriptor = parts[1] || '';
    let score = 1;
    if (descriptor.endsWith('w')) score = Number.parseInt(descriptor, 10) || 1;
    else if (descriptor.endsWith('x')) score = (Number.parseFloat(descriptor) || 1) * 1000;
    if (url && (!best || score > best.score)) best = { url, score };
  }
  return best?.url || '';
}

function collectJsonLdImages(html, baseUrl) {
  const images = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(decodeHtml(match[1]));
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const item = stack.pop();
        if (!item || typeof item !== 'object') continue;
        const image = item.image;
        if (typeof image === 'string') images.push(image);
        else if (Array.isArray(image)) images.push(...image.filter(x => typeof x === 'string'));
        else if (image && typeof image === 'object' && typeof image.url === 'string') images.push(image.url);
        for (const value of Object.values(item)) {
          if (value && typeof value === 'object') stack.push(value);
        }
      }
    } catch {}
  }
  return images.map(image => absolutizeUrl(image, baseUrl)).filter(Boolean);
}

function collectDynamicImageUrls(value, baseUrl) {
  const images = [];
  try {
    const data = JSON.parse(decodeHtml(value));
    if (data && typeof data === 'object') {
      for (const [url, dimensions] of Object.entries(data)) {
        images.push({
          url: absolutizeUrl(url, baseUrl),
          width: Array.isArray(dimensions) ? Number(dimensions[0]) || 0 : 0,
          height: Array.isArray(dimensions) ? Number(dimensions[1]) || 0 : 0
        });
      }
    }
  } catch {}
  return images.filter(image => image.url);
}

function previewImageScore(candidate) {
  const url = String(candidate.url || '');
  const lower = url.toLowerCase();
  let score = candidate.priority || 0;
  const width = Number(candidate.width || 0);
  const height = Number(candidate.height || 0);
  const area = width * height;

  if (area >= 120000) score += 220;
  else if (area >= 40000) score += 140;
  else if (width && height && area < 10000) score -= 500;
  else if (!width && !height) score -= 20;

  if (/\.(?:jpe?g|png|webp|avif)(?:[?#]|$)/.test(lower)) score += 80;
  if (/\/(?:image|images|media|photo|photos|product|products|assets)\//.test(lower)) score += 50;
  if (/(?:og|twitter|social|share|card)[-_./]?image/.test(lower)) score += 80;
  if (/m\.media-amazon\.com|ssl-images-amazon\.com|images-na\.ssl-images-amazon\.com/.test(lower)) score += 140;
  if (/favicon|apple-touch-icon|\/icon[-_.]?|\.ico(?:[?#]|$)/.test(lower)) score -= 700;
  if (/sprite|spacer|blank|transparent|pixel|tracking|loader|placeholder/.test(lower)) score -= 600;
  if (/logo|brand/.test(lower)) score -= 160;
  if (/\/(?:16|24|32|48|64)x(?:16|24|32|48|64)\//.test(lower) || /(?:^|[-_])(?:16|24|32|48|64)(?:[-_.x])/.test(lower)) score -= 350;
  if (/\.svg(?:[?#]|$)/.test(lower)) score -= 120;
  return score;
}

function bestPreviewImage(candidates, baseUrl) {
  const seen = new Set();
  const normalized = [];
  for (const candidate of candidates) {
    const url = absolutizeUrl(candidate.url || candidate, baseUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push({ ...candidate, url });
  }
  normalized.sort((a, b) => previewImageScore(b) - previewImageScore(a));
  return normalized[0]?.url || null;
}

function previewScreenshotUrl(baseUrl) {
  if (process.env.KEEPARR_LINK_PREVIEW_SCREENSHOTS === '0') return null;
  try {
    const target = new URL(baseUrl);
    if (!['http:', 'https:'].includes(target.protocol)) return null;
    target.hash = '';
    return `https://image.thum.io/get/width/640/crop/360/noanimate/${target.href}`;
  } catch {
    return null;
  }
}

function parseOgMeta(html, baseUrl) {
  const meta = new Map();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !meta.has(key)) meta.set(key, attrs.content);
  }
  const getMeta = (...names) => {
    for (const name of names) {
      const value = meta.get(name.toLowerCase());
      if (value) return value;
    }
    return null;
  };
  const titleMatch = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);

  const imageCandidates = [];
  const addCandidate = (url, priority, dimensions = {}) => {
    if (url) imageCandidates.push({ url, priority, ...dimensions });
  };

  addCandidate(
    getMeta('og:image:secure_url', 'og:image:url', 'og:image'),
    1100,
    { width: Number(getMeta('og:image:width')) || 0, height: Number(getMeta('og:image:height')) || 0 }
  );
  addCandidate(
    getMeta('twitter:image:src', 'twitter:image'),
    1050,
    { width: Number(getMeta('twitter:image:width')) || 0, height: Number(getMeta('twitter:image:height')) || 0 }
  );
  for (const image of collectJsonLdImages(html, baseUrl)) addCandidate(image, 900);

  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const rel = (attrs.rel || '').toLowerCase();
    if (rel.includes('image_src')) addCandidate(attrs.href, 850);
    else if (rel.includes('apple-touch-icon')) addCandidate(attrs.href, 180);
    else if (rel.includes('icon')) addCandidate(attrs.href, 80);
  }
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0]);
    const width = Number(attrs.width || attrs['data-width']) || 0;
    const height = Number(attrs.height || attrs['data-height']) || 0;
    const dimensions = { width, height };
    addCandidate(attrs['data-old-hires'], 760, dimensions);
    addCandidate(attrs['data-a-hires'], 760, dimensions);
    addCandidate(attrs['data-large-image'], 740, dimensions);
    addCandidate(bestSrcsetUrl(attrs.srcset || attrs['data-srcset']), 680, dimensions);
    addCandidate(attrs.src || attrs['data-src'] || attrs['data-original'] || attrs['data-lazy-src'], 620, dimensions);
    for (const image of collectDynamicImageUrls(attrs['data-a-dynamic-image'], baseUrl)) {
      addCandidate(image.url, 820, { width: image.width, height: image.height });
    }
  }

  // Deep Scan for absolute URLs ending in image extensions
  const deepScanRegex = /https?:\/\/[^"'\s]+\.(?:jpg|jpeg|png|webp|avif|svg)(?:\?[^"'\s]*)?/gi;
  const deepMatches = html.match(deepScanRegex);
  if (deepMatches) {
    for (const image of deepMatches) addCandidate(image, 520);
  }

  let bestImage = bestPreviewImage(imageCandidates, baseUrl);

  // Screenshot fallback handles sites that block server-side HTML fetches or
  // do not publish useful OpenGraph imagery. Set
  // KEEPARR_LINK_PREVIEW_SCREENSHOTS=0 to avoid using the third-party service.
  if (!bestImage) {
    bestImage = previewScreenshotUrl(baseUrl);
  }

  // Final fallback: High-res Google Favicon
  if (!bestImage) {
    try {
      const domain = new URL(baseUrl).hostname;
      bestImage = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
    } catch {}
  }

  return {
    title: getMeta('og:title', 'twitter:title') || (titleMatch ? decodeHtml(titleMatch[1]).trim() : null),
    description: getMeta('og:description') || getMeta('description') || null,
    image: bestImage || null,
  };
}

function mountLinkPreviewRoutes(app) {
  app.get('/api/link-preview', requireAuth, asyncRoute(async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
    let parsed;
    try {
      parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad protocol');
    } catch { return res.status(400).json({ error: 'Invalid URL' }); }

    const cached = linkPreviewCache.get(url);
    if (cached && cached.fetchedAt > Date.now() - 3600000) return res.json(cached.data);

    try {
      const html = await fetchHtml(url);
      const meta = parseOgMeta(html, url);
      const domain = parsed.hostname.replace(/^www\./, '');
      const data = { title: meta.title || domain, description: meta.description, image: meta.image, url, domain };
      // Bounded: the oldest preview is dropped first (a Map iterates in insertion order).
      if (linkPreviewCache.size >= LINK_PREVIEW_CACHE_MAX) linkPreviewCache.delete(linkPreviewCache.keys().next().value);
      linkPreviewCache.set(url, { data, fetchedAt: Date.now() });
      res.json(data);
    } catch (err) {
      const domain = parsed.hostname.replace(/^www\./, '');
      const fallback = {
        title: domain,
        description: null,
        image: `https://www.google.com/s2/favicons?domain=${domain}&sz=128`,
        url,
        domain
      };
      res.json(fallback);
    }
  }));

  app.get('/api/proxy-image', requireAuthOrMediaTicket, asyncRoute(async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('URL required');

    async function doProxy(targetUrl, redirectsLeft = 3) {
      let parsed;
      try { parsed = new URL(targetUrl); }
      catch { if (!res.headersSent) res.status(400).send('Invalid URL'); return; }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        if (!res.headersSent) res.status(400).send('Invalid protocol');
        return;
      }

      const transport = parsed.protocol === 'https:' ? https : http;
      let requestOptions;
      try {
        requestOptions = await publicRequestOptions(targetUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Cache-Control': 'no-cache'
          },
          timeout: 10000
        });
      } catch {
        if (!res.headersSent) res.status(400).send('Private network targets are blocked');
        return;
      }
      const proxyReq = transport.get(targetUrl, requestOptions, (proxyRes) => {
        if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location && redirectsLeft > 0) {
          proxyRes.resume();
          return doProxy(absolutizeUrl(proxyRes.headers.location, targetUrl), redirectsLeft - 1);
        }

        if (proxyRes.statusCode >= 400) {
          return res.status(proxyRes.statusCode).send('Upstream error');
        }

        const contentType = String(proxyRes.headers['content-type'] || 'image/jpeg').toLowerCase();
        if (!contentType.startsWith('image/')) {
          proxyRes.resume();
          if (!res.headersSent) res.status(415).send('Not an image');
          return;
        }

        // Remote content is served from this origin: an SVG opened directly (not through <img>) must not run script here.
        res.writeHead(proxyRes.statusCode, {
          'Content-Type': proxyRes.headers['content-type'] || 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox"
        });
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (err) => {
        console.error('Proxy Image Error:', err.message, 'for URL:', targetUrl);
        if (!res.headersSent) res.status(500).send('Proxy error');
      });
    }

    await doProxy(url);
  }));
}

module.exports = { mountLinkPreviewRoutes };
