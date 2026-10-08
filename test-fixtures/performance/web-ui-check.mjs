import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const buildRootArgument = process.argv.find(argument => argument.startsWith('--build-root='))?.split('=')[1];
const buildRoot = buildRootArgument ? path.resolve(buildRootArgument) : path.join(repositoryRoot, 'dist/keep/browser');
const legacyBuildRoot = path.join(repositoryRoot, 'dist/keep');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const countArgument = process.argv.find(argument => argument.startsWith('--notes='));
const fixtureCount = Math.max(80, Math.min(10000, Number(countArgument?.split('=')[1]) || 240));
const detailDelayArgument = process.argv.find(argument => argument.startsWith('--detail-delay='));
const requestedDetailDelay = Number(detailDelayArgument?.split('=')[1]);
const detailDelay = Number.isFinite(requestedDetailDelay) && requestedDetailDelay >= 0 ? requestedDetailDelay : 500;
const virtualizationArgument = process.argv.find(argument => argument.startsWith('--virtual-grid='));
const virtualGridMode = ['on', 'off', 'auto'].includes(virtualizationArgument?.split('=')[1])
  ? virtualizationArgument.split('=')[1]
  : 'auto';
const virtualGridEnabled = virtualGridMode === 'on';
const profileMode = process.argv.includes('--profile');
const cpuProfileMode = process.argv.includes('--cpu-profile');
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
const appPath = `/?virtualGrid=${virtualGridEnabled ? 'on' : 'off'}`;
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
    } else if (url.pathname === '/api/users/me/mcp-access') {
      value = { enabled: false, allowLockedNotes: false, allowPermanentDelete: false, token: null };
    } else if (url.pathname === '/api/users/me/oauth-access') {
      value = { enabled: false, allowLockedNotes: false, allowPermanentDelete: false, connections: [] };
    } else if (url.pathname === '/api/auth/oidc/link/status') {
      value = { enabled: false, connected: false, identityEmail: '', connectedAt: null };
    } else if (url.pathname === '/api/reminders/ics-token') {
      value = { token: 'fixture-ics-token' };
    } else if (url.pathname === '/api/google-calendar/status') {
      value = { enabled: false, hasCredentials: false, clientId: '' };
    } else if (url.pathname === '/api/caldav/settings') {
      value = null;
    } else if (url.pathname === '/api/settings/registration') {
      value = { selfRegistrationEnabled: true, requireApproval: false };
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
  const browserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keeparr-ui-check-'));
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
    await cdp('HeapProfiler.enable');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp('Page.addScriptToEvaluateOnNewDocument', {
      source: `if (!sessionStorage.getItem('keeparr-harness-logged-out')) localStorage.setItem('gk_session', JSON.stringify({id:1,username:'fixture',displayName:'Fixture',role:'admin',theme:'light',token:'fixture-token',demoNotesCreatedAt:'2026-01-01'}));localStorage.setItem('keeparr_user_preferences', JSON.stringify({richLinkPreviews:true}));`
    });
    if (profileMode) {
      // Diagnostic journey: cold and warm browsing, search, and scroll paging, each split into the
      // part the user waits for (to the first card / to the results) and background settling.
      const read = async () => Object.fromEntries((await cdp('Performance.getMetrics')).metrics.map(metric => [metric.name, metric.value]));
      const delta = (before, after) => ({
        scriptMs: +(((after.ScriptDuration || 0) - (before.ScriptDuration || 0)) * 1000).toFixed(1),
        taskMs: +(((after.TaskDuration || 0) - (before.TaskDuration || 0)) * 1000).toFixed(1),
        layoutMs: +(((after.LayoutDuration || 0) - (before.LayoutDuration || 0)) * 1000).toFixed(1),
        styleMs: +(((after.RecalcStyleDuration || 0) - (before.RecalcStyleDuration || 0)) * 1000).toFixed(1),
        layouts: Math.round((after.LayoutCount || 0) - (before.LayoutCount || 0)),
        heapMb: +((after.JSHeapUsedSize || 0) / 1048576).toFixed(1),
        domNodes: Math.round(after.Nodes || 0)
      });
      const waitFor = async (expression, limitMs = 20000) => {
        const started = Date.now();
        while (Date.now() - started < limitMs) {
          if (await evaluate(expression)) return Date.now() - started;
          await sleep(10);
        }
        throw new Error(`Timed out waiting for ${expression}`);
      };
      const cards = `document.querySelectorAll('app-notes .note-container').length`;
      const journey = {};
      for (const phase of ['cold', 'warm']) {
        // Chromium's counters restart with each document, so a navigation phase is measured from zero.
        const before = {};
        const requestsBefore = apiRequests.length;
        const sampling = cpuProfileMode;
        if (sampling) {
          await cdp('Profiler.enable');
          await cdp('Profiler.setSamplingInterval', { interval: 200 });
          await cdp('Profiler.start');
        }
        await cdp('Page.navigate', { url: `http://127.0.0.1:${port}${appPath}` });
        const toFirstCardMs = await waitFor(`${cards} > 0`);
        const atFirstCard = await read();
        const mountedAtFirstCard = await evaluate(cards);
        await sleep(3000);
        const settled = await read();
        if (sampling) {
          // Top self-time functions from navigation until the collection has settled (first card plus background work).
          const { profile } = await cdp('Profiler.stop');
          const interval = profile.timeDeltas;
          const selfMs = new Map();
          const nodes = new Map(profile.nodes.map(node => [node.id, node]));
          profile.samples.forEach((id, index) => selfMs.set(id, (selfMs.get(id) || 0) + (interval[index] || 0) / 1000));
          const byFunction = new Map();
          for (const [id, ms] of selfMs) {
            const frame = nodes.get(id).callFrame;
            const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber}`;
            byFunction.set(key, (byFunction.get(key) || 0) + ms);
          }
          // Inclusive time shows which callers own the self-time above.
          const inclusive = new Map();
          const total = id => {
            const node = nodes.get(id);
            const own = selfMs.get(id) || 0;
            const value = own + (node.children || []).reduce((sum, child) => sum + total(child), 0);
            const frame = node.callFrame;
            const key = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').pop()}:${frame.lineNumber}:${frame.columnNumber}`;
            if (!['(root)', '(program)', '(idle)'].includes(frame.functionName)) inclusive.set(key, Math.max(inclusive.get(key) || 0, value));
            return value;
          };
          total(profile.nodes[0].id);
          journey[`${phase}TopInclusiveTime`] = [...inclusive].filter(([name]) => !/polyfills|chunk-KPH/.test(name)).sort((x, y) => y[1] - x[1]).slice(0, 16).map(([name, ms]) => `${ms.toFixed(0)}ms ${name}`);
          journey[`${phase}TopSelfTime`] = [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, ms]) => `${ms.toFixed(0)}ms ${name}`);
        }

        journey[phase] = {
          toFirstCardMs,
          mountedAtFirstCard,
          interactive: delta(before, atFirstCard),
          backgroundAfterFirstCard: delta(atFirstCard, settled),
          apiRequests: apiRequests.length - requestsBefore
        };
      }
      // Search: time from typing to the filtered result, then clearing.
      let before = await read();
      let requestsBefore = apiRequests.length;
      const searchStarted = Date.now();
      await evaluate(`(() => { const input = document.querySelector('app-navbar input[placeholder="Search your notes"]'); input.value = 'Performance note 23'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await waitFor(`(() => { const titles = [...document.querySelectorAll('app-notes .note-container .title')].map(title => title.textContent); return titles.length > 0 && titles.every(title => title.includes('23')); })()`);
      const searchMs = Date.now() - searchStarted;
      journey.search = { toResultsMs: searchMs, ...delta(before, await read()), apiRequests: apiRequests.length - requestsBefore, mounted: await evaluate(cards) };
      before = await read();
      const clearStarted = Date.now();
      await evaluate(`document.querySelector('app-navbar button[aria-label="Clear search"]').click()`);
      await waitFor(`${cards} > ${virtualGridEnabled ? 5 : 30}`);
      journey.clearSearch = { toResultsMs: Date.now() - clearStarted, ...delta(before, await read()), mounted: await evaluate(cards) };
      // Paging: scroll to the bottom in steps until nothing new is reachable.
      before = await read();
      requestsBefore = apiRequests.length;
      const steps = [];
      let quiet = 0;
      for (let step = 0; step < 80 && quiet < 6; step++) {
        const requestsAtStep = apiRequests.length;
        await evaluate(`window.scrollTo(0, document.documentElement.scrollHeight)`);
        await sleep(250);
        const height = await evaluate(`document.documentElement.scrollHeight`);
        quiet = height === steps[steps.length - 1] && apiRequests.length === requestsAtStep ? quiet + 1 : 0;
        steps.push(height);
      }
      journey.scrollThroughCollection = {
        steps: steps.length,
        pageRequests: apiRequests.slice(requestsBefore).filter(request => request.startsWith('GET /api/notes')).length,
        ...delta(before, await read()),
        mountedAtEnd: await evaluate(cards)
      };
      // Editor cycles: open a note, type, close (saving locally), repeated. Reports what the user waits for (open, per
      // keystroke to the next frame, close/save) and what each cycle leaves behind after a forced GC, so retained
      // DOM nodes, event listeners or heap show up as growth after warm-up. Duration is `--cycles=N` (default 10).
      const cycleCount = Math.max(2, Number(process.argv.find(argument => argument.startsWith('--cycles='))?.split('=')[1]) || 10);
      await cdp('Page.navigate', { url: `http://127.0.0.1:${port}${appPath}` });
      await waitFor(`${cards} > 0`);
      // Background settling after a warm start outlasts the 3 s window at large sizes (docs/performance.md), and editor
      // timings taken while it runs measure that contention; wait it out (override with --settle=ms).
      const settleMs = Number(process.argv.find(argument => argument.startsWith('--settle='))?.split('=')[1]) || Math.max(1500, fixtureCount * 1.2);
      await sleep(settleMs);
      const p95 = values => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)];
      const median = values => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)];
      const closeEditor = async () => {
        await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
        await waitFor(`document.querySelector('app-notes .modal-container').style.display === 'none'`);
      };
      const retained = async () => {
        await cdp('HeapProfiler.collectGarbage');
        await sleep(100);
        const counters = await cdp('Memory.getDOMCounters');
        const heap = await cdp('Runtime.getHeapUsage');
        // Listeners on the long-lived targets, by type, so growth can be attributed rather than only counted.
        const byType = {};
        for (const target of ['document', 'window', 'document.body', 'window.visualViewport']) {
          const { result } = await cdp('Runtime.evaluate', { expression: target });
          for (const listener of (await cdp('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners) {
            byType[`${target}:${listener.type}`] = (byType[`${target}:${listener.type}`] || 0) + 1;
          }
        }
        return { heapMb: +(heap.usedSize / 1048576).toFixed(2), domNodes: counters.nodes, listeners: counters.jsEventListeners, byType };
      };
      const openMs = [], keystrokeMs = [], closeMs = [], afterCycle = [];
      let scriptBeforeCycles = (await read()).ScriptDuration;
      for (let cycle = 0; cycle < cycleCount; cycle++) {
        await evaluate(`window.scrollTo(0, ${cycle % 2 ? 600 : 0})`);
        await sleep(150);
        const openStarted = Date.now();
        // Alternate a text note with the next fixture note that carries an inline image, so the cycles also open media.
        const noteId = cycle % 2 ? 30 : 2;
        await evaluate(`(document.querySelector('app-notes .note-container[data-note-id="${noteId}"] .title') || document.querySelector('app-notes .note-container[data-note-id="2"] .title')).click()`);
        await waitFor(`!!document.querySelector('app-notes .modal .note-body')`);
        openMs.push(Date.now() - openStarted);
        await sleep(200);
        await evaluate(`document.querySelector('app-notes .modal .note-body').focus()`);
        for (let key = 0; key < 20; key++) {
          keystrokeMs.push(await evaluate(`new Promise(resolve => { const started = performance.now(); document.execCommand('insertText', false, 'x'); requestAnimationFrame(() => resolve(performance.now() - started)); })`));
        }
        const closeStarted = Date.now();
        await closeEditor();
        closeMs.push(Date.now() - closeStarted);
        await sleep(300);
        afterCycle.push(await retained());
      }
      const scriptMs = +(((await read()).ScriptDuration - scriptBeforeCycles) * 1000).toFixed(1);
      const warm = afterCycle.slice(2);
      journey.editorCycles = {
        cycles: cycleCount,
        openMs: { median: median(openMs), p95: p95(openMs) },
        keystrokeToFrameMs: { median: +median(keystrokeMs).toFixed(1), p95: +p95(keystrokeMs).toFixed(1), max: +Math.max(...keystrokeMs).toFixed(1) },
        closeAndSaveMs: { median: median(closeMs), p95: p95(closeMs), perCycle: closeMs },
        scriptMsTotal: scriptMs,
        retainedAfterWarmup: warm.length > 1 ? {
          heapMbGrowth: +(warm[warm.length - 1].heapMb - warm[0].heapMb).toFixed(2),
          domNodeGrowth: warm[warm.length - 1].domNodes - warm[0].domNodes,
          listenerGrowth: warm[warm.length - 1].listeners - warm[0].listeners
        } : null,
        afterEachCycle: afterCycle
      };
      assert.equal(errors.length, 0, `Browser runtime errors: ${errors.map(error => error.text).join('; ')}`);
      console.log('PROFILE ' + JSON.stringify({ noteCount: fixtureCount, virtualGrid: virtualGridEnabled ? 'on' : 'off', journey }));
      return;
    }
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}${appPath}` });
    await sleep(2500);

    const cardCount = await evaluate(`document.querySelectorAll('app-notes .note-container').length`);
    assert(cardCount > 0 && cardCount < 120, `Expected a bounded first paint; found ${cardCount} rendered note cards.`);
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
    const renderedCardsAfterScroll = await evaluate(`document.querySelectorAll('app-notes .note-container').length`);

    await evaluate('window.scrollTo(0, 0)');
    await sleep(150);
    const beforeResize = await metrics();
    await cdp('Emulation.setDeviceMetricsOverride', { width: 480, height: 850, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    const afterResize = await metrics();
    const mobileGrid = await evaluate(`(() => { const cards = [...document.querySelectorAll('app-notes .note-container')].filter(card => card.clientWidth); return {width: cards[0]?.clientWidth, columns: new Set(cards.slice(0, 6).map(card => Math.round(card.getBoundingClientRect().left))).size, overlap: cards.some((card, index) => cards.slice(index + 1).some(other => { const a = card.getBoundingClientRect(), b = other.getBoundingClientRect(); return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1; }))}; })()`);
    assert.equal(mobileGrid.columns, 2, 'Mobile grid should render two columns.');
    if (mobileGrid.overlap) {
      const positions = await evaluate(`JSON.stringify([...document.querySelectorAll('app-notes .note-container')].filter(card => card.clientWidth).slice(0, 20).map(card => ({id:card.dataset.noteId,rect:card.getBoundingClientRect().toJSON(),transform:card.style.transform})))`);
      assert.equal(mobileGrid.overlap, false, `Mobile cards overlap: ${positions}`);
    }
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
    const renderedCardsInList = listGroups.reduce((total, group) => total + group.count, 0);
    if (fixtureCount >= 1000) assert(renderedCardsInList < 80, `List virtualizer mounted too many cards: ${renderedCardsInList}`);
    let renderedCardsAfterListScroll = renderedCardsInList;
    if (fixtureCount >= 1000) {
      await evaluate(`window.scrollTo(0, Math.floor(document.documentElement.scrollHeight / 2))`);
      await sleep(350);
      renderedCardsAfterListScroll = await evaluate(`document.querySelectorAll('app-notes .note-container').length`);
      assert(renderedCardsAfterListScroll > 0 && renderedCardsAfterListScroll < 80,
        `List virtualizer did not keep the mid-scroll window bounded: ${renderedCardsAfterListScroll}`);
      await evaluate('window.scrollTo(0, 0)');
      await sleep(200);
    }
    smoke.push('list layout');
    smoke.push('variable-height list window and mid-scroll bound');
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
    const cardsAfterSearchClear = await evaluate(`document.querySelectorAll('app-notes .note-container').length`);
    assert(cardsAfterSearchClear > 0 && (virtualGridEnabled ? cardsAfterSearchClear < 80 : cardsAfterSearchClear > 30),
      `Clearing search did not restore an appropriate note window: ${cardsAfterSearchClear}`);
    smoke.push('clear search');

    const scriptsBeforeSettingsNavigation = await evaluate(`performance.getEntriesByType('resource').filter(entry => /\\.js(?:$|\\?)/.test(entry.name)).map(entry => entry.name)`);
    await evaluate(`document.querySelector('app-navbar .user-pic-container').click()`);
    await sleep(50);
    await evaluate(`document.querySelector('.profile-menu .secondary').click()`);
    await sleep(1200);
    assert(await evaluate(`location.pathname === '/settings' && document.querySelector('h1')?.textContent.includes('Settings')`), 'Lazy settings route did not open.');
    const scriptsAfterSettingsNavigation = await evaluate(`performance.getEntriesByType('resource').filter(entry => /\\.js(?:$|\\?)/.test(entry.name)).map(entry => entry.name)`);
    assert(scriptsAfterSettingsNavigation.some(script => !scriptsBeforeSettingsNavigation.includes(script)), 'Settings lazy chunk was not loaded on navigation.');
    smoke.push('lazy settings route');
    // Lazy auth/admin routes: each loads its own chunk on first navigation and the first field is focused.
    const navigateInApp = async route => {
      await evaluate(`(() => { history.pushState({}, '', ${JSON.stringify(route)}); window.dispatchEvent(new PopStateEvent('popstate')); })()`);
    };
    const waitForRoute = async (selector, label) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
        await sleep(50);
      }
      assert.fail(`${label} did not render.`);
    };
    const loadedScripts = () => evaluate(`performance.getEntriesByType('resource').filter(entry => /\\.js(?:$|\\?)/.test(entry.name)).map(entry => entry.name)`);
    let knownScripts = await loadedScripts();
    await navigateInApp('/users');
    await waitForRoute('app-user-management h1', 'Lazy user-management route');
    const afterUsers = await loadedScripts();
    assert(afterUsers.some(script => !knownScripts.includes(script)), 'User-management lazy chunk was not loaded on navigation.');
    smoke.push('lazy admin route');
    knownScripts = afterUsers;
    // Signed-out entry points need a fresh document, as a user opening the shipped app would get.
    await evaluate(`sessionStorage.setItem('keeparr-harness-logged-out', '1'); localStorage.removeItem('gk_session')`);
    for (const route of ['/login', '/register']) {
      await cdp('Page.navigate', { url: `http://127.0.0.1:${port}${route}` });
      await waitForRoute(`app-${route.slice(1)} input[name="username"]`, `Lazy ${route} route`);
      await sleep(100);
      assert.equal(await evaluate(`document.activeElement?.getAttribute('name')`), 'username', `${route} did not focus its first field.`);
      const scripts = await loadedScripts();
      assert(scripts.some(script => /chunk-/.test(script)), `${route} did not load a lazy chunk.`);
    }
    await evaluate(`sessionStorage.removeItem('keeparr-harness-logged-out')`);
    smoke.push('lazy login/register routes with first-field focus');
    await cdp('Page.navigate', { url: `http://127.0.0.1:${port}${appPath}` });
    await sleep(700);

    // Accessibility audit of the mounted home screen: accessible names, contrast of card text, and touch target size.
    const auditExpression = (roots, includeCards) => `(() => {
      const visible = element => { const r = element.getBoundingClientRect(); const style = getComputedStyle(element); return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !element.closest('[aria-hidden=true]'); };
      const nameOf = element => (element.getAttribute('aria-label') || element.getAttribute('aria-labelledby') && document.getElementById(element.getAttribute('aria-labelledby'))?.textContent || element.getAttribute('title') || element.textContent || element.getAttribute('placeholder') || element.querySelector('img[alt]')?.getAttribute('alt') || '').trim();
      const controls = [...document.querySelectorAll(${JSON.stringify(roots)})].flatMap(root => [...root.querySelectorAll('button, a[href], input:not([type=hidden]), [role=button], [role=checkbox], [tabindex="0"]')]).filter(visible);
      const unnamed = controls.filter(element => !nameOf(element) && !(element.id && document.querySelector('label[for="' + element.id + '"]'))).map(element => element.tagName.toLowerCase() + '.' + String(element.className).split(' ').slice(0, 2).join('.'));
      const luminance = rgb => { const [r, g, b] = rgb.map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
      const parse = value => (value.match(/[0-9.]+/g) || []).map(Number);
      const backgroundOf = element => { for (let node = element; node; node = node.parentElement) { const color = parse(getComputedStyle(node).backgroundColor); if (color.length >= 3 && (color[3] === undefined || color[3] > 0.5)) return color; } return [255, 255, 255]; };
      const lowContrast = [];
      for (const card of ${includeCards} ? [...document.querySelectorAll('app-notes .note-container')].filter(visible).slice(0, 40) : []) {
        for (const text of card.querySelectorAll('.title, .note-body-preview, .preview, p')) {
          if (!visible(text) || !text.textContent.trim()) continue;
          const fg = parse(getComputedStyle(text).color), bg = backgroundOf(text);
          const a = luminance(fg) + 0.05, b = luminance(bg) + 0.05;
          const ratio = Math.max(a, b) / Math.min(a, b);
          if (ratio < 4.5) lowContrast.push(card.dataset.noteId + ':' + text.className + ':' + ratio.toFixed(2));
        }
      }
      const smallTargets = controls.filter(element => { const r = element.getBoundingClientRect(); return element.tagName !== 'INPUT' && (r.width < 24 || r.height < 24); }).map(element => element.tagName.toLowerCase() + '.' + String(element.className).split(' ').slice(0, 2).join('.') + ':' + Math.round(element.getBoundingClientRect().width) + 'x' + Math.round(element.getBoundingClientRect().height));
      return { controls: controls.length, unnamed: [...new Set(unnamed)], lowContrast: lowContrast.slice(0, 10), lowContrastCount: lowContrast.length, smallTargets: [...new Set(smallTargets)].slice(0, 15) };
    })()`;
    const audit = await evaluate(auditExpression('app-navbar, app-sidenav, app-notes', true));
    assert.deepEqual(audit.unnamed, [], `Controls without an accessible name: ${audit.unnamed.join(', ')}`);
    assert.equal(audit.lowContrastCount, 0, `Card text below 4.5:1 contrast: ${audit.lowContrast.join(', ')}`);
    smoke.push(`accessibility audit (${audit.controls} controls named, card text contrast, ${audit.smallTargets.length} targets under 24px)`);

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

    // Keyboard: Enter on a focused card opens it, and closing returns focus to that card.
    const keyboardKey = await evaluate(`(() => { const card = document.querySelector('app-notes .note-container .note-preview-open'); card.focus(); const key = card.closest('.note-container').dataset.noteKey; card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return key; })()`);
    await sleep(detailDelay + 150);
    assert(await evaluate(`!!document.querySelector('app-notes .modal app-input')`), 'Enter on a focused card did not open the editor.');
    const editorAudit = await evaluate(auditExpression('app-notes .modal', false));
    assert.deepEqual(editorAudit.unnamed, [], `Editor controls without an accessible name: ${editorAudit.unnamed.join(', ')}`);
    smoke.push(`editor accessibility audit (${editorAudit.controls} controls named, ${editorAudit.smallTargets.length} targets under 24px: ${editorAudit.smallTargets.slice(0, 5).join(' ')})`);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    for (let attempt = 0; attempt < 20 && await evaluate(`document.querySelector('app-notes .modal-container').style.display !== 'none'`); attempt++) await sleep(50);
    await sleep(500);
    assert.equal(await evaluate(`document.activeElement?.classList.contains('note-preview-open') && document.activeElement.closest('.note-container')?.dataset.noteKey`), keyboardKey,
      'Closing the editor did not return focus to the card it was opened from.');
    smoke.push('keyboard open and focus return');

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
      fixture: { noteCount: fixtureCount, detailDelayMs: detailDelay, virtualGrid: virtualGridEnabled ? 'on' : 'off' },
      renderedCardsAtFirstPaint: cardCount,
      renderedCardsAfterScroll,
      renderedCardsInList,
      renderedCardsAfterListScroll,
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
