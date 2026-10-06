import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const buildRoot = path.join(repositoryRoot, 'dist/keep/browser');
const legacyBuildRoot = path.join(repositoryRoot, 'dist/keep');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const countArgument = process.argv.find(argument => argument.startsWith('--notes='));
const fixtureCount = Math.max(80, Math.min(10000, Number(countArgument?.split('=')[1]) || 240));
const detailDelayArgument = process.argv.find(argument => argument.startsWith('--detail-delay='));
const requestedDetailDelay = Number(detailDelayArgument?.split('=')[1]);
const detailDelay = Number.isFinite(requestedDetailDelay) && requestedDetailDelay >= 0 ? requestedDetailDelay : 500;
const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAAAAAElFTkSuQmCC';

function createNote(index) {
  const checklist = index % 4 === 0;
  const title = `Performance note ${index + 1}`;
  const body = index % 25 === 0
    ? `<p>A <strong>rich</strong> measured note body, item ${index + 1}.</p><a href="https://fixture-${index + 1}.example.test/page">https://fixture-${index + 1}.example.test/page</a>`
    : `<p>A measured note body, item ${index + 1}. </p>`.repeat(2 + index % 12);
  return {
    id: index + 1,
    syncId: `performance-fixture-${index + 1}`,
    revision: 1,
    ownerUserId: index % 17 === 0 ? 2 : 1,
    noteTitle: title,
    noteBody: body,
    searchText: `performance-fixture-${index + 1}`,
    previewText: `A measured note body, item ${index + 1}.`,
    isCbox: checklist,
    checkBoxes: checklist ? Array.from({ length: 8 }, (_, item) => ({
      id: item + 1,
      data: `Fixture task ${item + 1}`,
      done: item % 4 === 0,
      indentLevel: item > 2 ? 1 : 0
    })) : [],
    pinned: index < 8,
    sortOrder: fixtureCount - index,
    labels: index % 9 === 0 ? [{ id: 1, name: 'Performance', added: true }] : [],
    binder: index % 13 === 0 ? 'Benchmarks' : '',
    bgColor: ['#fce8e6', '#e6f4ea', '#e8f0fe', ''][index % 4],
    bgImage: '',
    images: index % 29 === 0 ? [{ id: `fixture-image-${index + 1}`, dataUrl: imageDataUrl, name: 'pixel.png', placement: 'top' }] : [],
    attachments: index % 31 === 0 ? [{ id: index + 1, originalName: 'fixture.txt', fileSize: 64, mimeType: 'text/plain', uploadedAt: '2026-01-01T12:00:00Z' }] : [],
    hasAttachments: index % 31 === 0,
    attachmentCount: index % 31 === 0 ? 1 : 0,
    ownerDisplayName: index % 17 === 0 ? 'Fixture collaborator' : undefined,
    ownerUsername: index % 17 === 0 ? 'fixture-collaborator' : undefined,
    ownerOnline: index % 17 === 0 && index % 2 === 0,
    collaborators: index % 17 === 0 ? [{ id: 2, username: 'fixture-collaborator' }] : [],
    archived: index > 8 && index % 37 === 0,
    trashed: index > 8 && index % 41 === 0,
    createdAt: '2026-01-01T12:00:00Z',
    updatedAt: '2026-01-01T12:00:00Z'
  };
}

const notes = Array.from({ length: fixtureCount }, (_, index) => createNote(index));
const bootstrapNotes = notes.map(note => ({ ...note }));
const reminders = notes.filter((note, index) => index % 19 === 0).map((note, index) => ({
  id: 10000 + index,
  syncId: `performance-reminder-${index + 1}`,
  noteId: note.id,
  dueAtUtc: '2035-01-01T12:00:00.000Z',
  timezone: 'UTC',
  status: 'pending',
  title: note.noteTitle
}));
const apiRequests = [];
const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    apiRequests.push(`${request.method} ${url.pathname}`);
    let value = [];
    if (url.pathname === '/api/notes' && request.method === 'GET') {
      const query = (url.searchParams.get('q') || '').toLocaleLowerCase();
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 80));
      const filtered = notes.filter(note => `${note.noteTitle} ${note.noteBody} ${note.searchText}`.toLocaleLowerCase().includes(query));
      const page = filtered.slice(offset, offset + limit).map(note => ({ ...note, isCardPreview: true }));
      value = { notes: page, nextCursor: offset + limit < filtered.length ? String(offset + limit) : null };
    } else if (/^\/api\/notes\/\d+$/.test(url.pathname) && request.method === 'GET') {
      const id = Number(url.pathname.split('/').pop());
      value = notes[id - 1] || {};
      response.setHeader('Content-Type', 'application/json');
      return setTimeout(() => response.end(JSON.stringify(value)), detailDelay);
    } else if (url.pathname === '/api/sync/bootstrap') {
      value = { notes: bootstrapNotes, reminders, attachments: [], cursor: 1, serverTime: Date.now() };
    } else if (url.pathname === '/api/sync/changes') {
      value = { changes: [], cursor: 1, hasMore: false, serverTime: Date.now() };
    } else if (url.pathname === '/api/reminders') {
      value = reminders;
    } else if (url.pathname === '/api/link-preview') {
      const link = url.searchParams.get('url') || '';
      value = { title: `Fixture preview · ${new URL(link).hostname}`, description: 'Synthetic performance fixture', image: null,
        url: link, domain: new URL(link).hostname };
    } else if (url.pathname === '/api/auth/preferences') {
      value = { showPastReminders: false };
    } else if (url.pathname === '/api/setup/status') {
      value = { hasUsers: true };
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(value));
    return;
  }

  const staticRoot = fs.existsSync(path.join(buildRoot, 'index.html')) ? buildRoot : legacyBuildRoot;
  const requestedPath = url.pathname === '/' ? path.join(staticRoot, 'index.html')
    : path.resolve(staticRoot, `.${decodeURIComponent(url.pathname)}`);
  if (!requestedPath.startsWith(`${staticRoot}${path.sep}`) && requestedPath !== path.join(staticRoot, 'index.html')) {
    response.writeHead(403).end();
    return;
  }
  const filePath = !fs.existsSync(requestedPath) || fs.statSync(requestedPath).isDirectory()
    ? path.join(staticRoot, 'index.html')
    : requestedPath;
  const contentTypes = {
    '.css': 'text/css', '.html': 'text/html', '.ico': 'image/x-icon', '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg', '.js': 'application/javascript', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff': 'font/woff',
    '.woff2': 'font/woff2'
  };
  response.setHeader('Content-Type', contentTypes[path.extname(filePath)] || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(response);
});

async function listenOnEphemeralPort() {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function findAvailablePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return port;
}

function findBrowser() {
  const candidates = [process.env.CHROME_BIN, '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/chromium-browser']
    .filter(Boolean);
  const browser = candidates.find(candidate => fs.existsSync(candidate));
  if (!browser) throw new Error('Set CHROME_BIN to a Chromium-compatible browser executable.');
  return browser;
}

async function waitForDevTools(port) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error('Chromium remote debugging endpoint did not start.');
}

async function run() {
  const port = await listenOnEphemeralPort();
  const devToolsPort = await findAvailablePort();
  const browserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-ui-check-'));
  const chrome = spawn(findBrowser(), [
    '--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    `--remote-debugging-port=${devToolsPort}`, `--user-data-dir=${browserDataDir}`, 'about:blank'
  ], { stdio: 'ignore' });
  let socket;

  try {
    const tabs = await waitForDevTools(devToolsPort);
    const page = tabs.find(tab => tab.type === 'page');
    assert(page, 'Chromium did not expose a page target.');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });

    let commandId = 0;
    const pending = new Map();
    const errors = [];
    socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const operation = pending.get(message.id);
        if (!operation) return;
        pending.delete(message.id);
        clearTimeout(operation.timer);
        message.error ? operation.reject(new Error(message.error.message)) : operation.resolve(message.result);
      } else if (message.method === 'Runtime.exceptionThrown') {
        errors.push(message.params.exceptionDetails);
      }
    });
    const cdp = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++commandId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for DevTools command ${method}.`));
      }, 10000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };

    await cdp('Page.enable');
    await cdp('Runtime.enable');
    await cdp('Performance.enable');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `localStorage.setItem('gk_session', JSON.stringify({id:1,username:'fixture',displayName:'Fixture',role:'admin',theme:'light',token:'fixture-token',demoNotesCreatedAt:'2026-01-01'}));localStorage.setItem('kept_user_preferences', JSON.stringify({richLinkPreviews:true}));`
    });
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}/` });
    await sleep(2500);

    const cardCount = await evaluate(`document.querySelectorAll('app-notes .note-container').length`);
    assert(cardCount >= 40, `Expected a progressive first paint; found ${cardCount} rendered note cards.`);
    const metrics = async () => Object.fromEntries((await cdp('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
    await evaluate('window.scrollTo(0, 400)');
    await sleep(150);
    const beforeScroll = await metrics();
    await evaluate(`new Promise(resolve => { let frame = 0; const tick = () => { window.dispatchEvent(new Event('scroll')); if (++frame < 120) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); })`);
    const afterScroll = await metrics();
    const durationDelta = (before, after, name) => +(((after[name] || 0) - (before[name] || 0)) * 1000).toFixed(2);
    const scrollMetrics = {
      taskDurationMs: durationDelta(beforeScroll, afterScroll, 'TaskDuration'),
      scriptDurationMs: durationDelta(beforeScroll, afterScroll, 'ScriptDuration'),
      layoutCount: Math.round((afterScroll.LayoutCount || 0) - (beforeScroll.LayoutCount || 0)),
      recalcStyleCount: Math.round((afterScroll.RecalcStyleCount || 0) - (beforeScroll.RecalcStyleCount || 0))
    };

    await evaluate('window.scrollTo(0, 0)');
    await sleep(150);
    const beforeResize = await metrics();
    await cdp('Emulation.setDeviceMetricsOverride', { width: 480, height: 850, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const afterResize = await metrics();
    const mobileGrid = await evaluate(`(() => { const cards = [...document.querySelectorAll('app-notes .note-container')].filter(card => card.clientWidth); return {width: cards[0]?.clientWidth, columns: new Set(cards.slice(0, 6).map(card => Math.round(card.getBoundingClientRect().left))).size, overlap: cards.some((card, index) => cards.slice(index + 1).some(other => { const a = card.getBoundingClientRect(), b = other.getBoundingClientRect(); return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1; }))}; })()`);
    assert.equal(mobileGrid.columns, 2, 'Mobile grid should render two columns.');
    assert.equal(mobileGrid.overlap, false, 'Mobile cards overlap.');
    const resizeMetrics = {
      taskDurationMs: durationDelta(beforeResize, afterResize, 'TaskDuration'),
      layoutCount: Math.round((afterResize.LayoutCount || 0) - (beforeResize.LayoutCount || 0)),
      recalcStyleCount: Math.round((afterResize.RecalcStyleCount || 0) - (beforeResize.RecalcStyleCount || 0))
    };

    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const layoutGroups = () => evaluate(`(() => [...document.querySelectorAll('app-notes .notes-layout')].map(group => { const cards = [...group.querySelectorAll('.note-container')].filter(card => card.clientWidth); return {count: cards.length, width: cards[0]?.clientWidth, columns: new Set(cards.slice(0, 6).map(card => Math.round(card.getBoundingClientRect().left))).size, overlap: cards.some((card, index) => cards.slice(index + 1).some(other => { const a = card.getBoundingClientRect(), b = other.getBoundingClientRect(); return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1; }))}; }))()`);
    const smoke = [];
    await evaluate(`document.querySelector('app-navbar .view').click()`);
    await sleep(550);
    for (let attempt = 0; attempt < 15 && (await layoutGroups()).some(group => group.overlap); attempt++) await sleep(100);
    const listGroups = await layoutGroups();
    assert(listGroups.filter(group => group.count).every(group => group.columns === 1 && !group.overlap && group.width === 600), `List view layout failed: ${JSON.stringify(listGroups)} ${await evaluate(`JSON.stringify([...document.querySelectorAll('app-notes .note-container')].slice(0, 8).map(card => ({id:card.dataset.noteId,transform:card.style.transform,rect:card.getBoundingClientRect().toJSON(),height:card.clientHeight})))`)}`);
    smoke.push('list layout');
    await evaluate(`document.querySelector('app-navbar .view').click()`);
    await sleep(550);
    for (let attempt = 0; attempt < 15 && (await layoutGroups()).some(group => group.overlap); attempt++) await sleep(100);
    assert((await layoutGroups()).every(group => !group.overlap), 'Grid view layout failed.');
    smoke.push('grid layout');
    await evaluate(`document.querySelector('app-navbar .pic-container').click()`);
    await sleep(500);
    assert((await layoutGroups()).every(group => !group.overlap), 'Sidebar resize caused card overlap.');
    smoke.push('sidebar resize');

    await evaluate(`(() => { const input = document.querySelector('app-navbar input[placeholder="Search your notes"]'); input.value = 'Performance note 23'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await sleep(700);
    const searchTitles = await evaluate(`[...document.querySelectorAll('app-notes .note-container .title')].map(title => title.textContent)`);
    assert(searchTitles.length > 0 && searchTitles.every(title => title.includes('23')), `Search returned unexpected notes: ${JSON.stringify(searchTitles)}`);
    smoke.push('search');
    await evaluate(`document.querySelector('app-navbar button[aria-label="Clear search"]').click()`);
    await sleep(700);
    assert(await evaluate(`document.querySelectorAll('app-notes .note-container').length > 30`), 'Clearing search did not restore notes.');
    smoke.push('clear search');

    await evaluate(`document.querySelector('app-notes .note-container .title').click()`);
    await sleep(detailDelay + 150);
    assert(await evaluate(`!!document.querySelector('app-notes .modal app-input')`), 'Unchanged-note editor did not open.');
    const detailReadsBeforeClose = apiRequests.filter(request => request === 'GET /api/notes/1').length;
    const noteWritesBeforeClose = apiRequests.filter(request => /^(POST|PUT|PATCH|DELETE) \/api\/notes(?:\/|$)/.test(request)).length;
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    for (let attempt = 0; attempt < 20 && await evaluate(`document.querySelector('app-notes .modal-container').style.display !== 'none'`); attempt++) await sleep(50);
    await sleep(100);
    const detailReadsAfterClose = apiRequests.filter(request => request === 'GET /api/notes/1').length;
    const noteWritesAfterClose = apiRequests.filter(request => /^(POST|PUT|PATCH|DELETE) \/api\/notes(?:\/|$)/.test(request)).length;
    assert.equal(detailReadsAfterClose, detailReadsBeforeClose, 'Closing an unchanged note issued a detail read.');
    assert.equal(noteWritesAfterClose, noteWritesBeforeClose, 'Closing an unchanged note issued a note write.');
    smoke.push('unchanged note closes without network reads');

    await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await evaluate(`document.querySelector('app-notes .note-container .title').click()`);
    await sleep(500);
    assert(await evaluate(`getComputedStyle(document.querySelector('app-notes .modal')).transitionDuration === '0s'`), 'Reduced-motion editor transition is active.');
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    for (let attempt = 0; attempt < 20 && await evaluate(`document.querySelector('app-notes .modal-container').style.display !== 'none'`); attempt++) await sleep(50);
    assert(await evaluate(`document.querySelector('app-notes .modal-container').style.display === 'none'`), 'Editor did not close.');
    smoke.push('reduced motion');
    await cdp('Emulation.setEmulatedMedia', { features: [] });

    assert.equal(errors.length, 0, `Browser runtime errors: ${errors.map(error => error.text).join('; ')}`);
    console.log(JSON.stringify({
      fixture: { noteCount: fixtureCount, detailDelayMs: detailDelay },
      renderedCardsAtFirstPaint: cardCount,
      scrollMetrics,
      resizeMetrics,
      mobileGrid,
      smoke,
      apiRequestCount: apiRequests.length,
      browserErrors: errors.length
    }, null, 2));
  } finally {
    socket?.close();
    chrome.kill('SIGTERM');
    if (chrome.exitCode === null) {
      await Promise.race([
        new Promise(resolve => chrome.once('close', resolve)),
        sleep(3000)
      ]);
    }
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(browserDataDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
