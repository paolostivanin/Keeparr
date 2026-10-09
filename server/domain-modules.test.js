const test = require('node:test');
const assert = require('node:assert/strict');
const { plainText, parseJson, escapeHtml, notePreviewText, noteLinkCount } = require('./note-text');
const { searchTextFromQuery, searchTokensFromQuery, searchOperatorsFromQuery, noteOperatorWhere, noteSearchWhere } = require('./note-search');
const {
  normalizeRepeatRule, normalizeReminderDueAt, normalizeLocationTrigger, reminderScheduleDefinitionChanged, parseRepeatRule,
  reminderScheduleChanged, normalizeReminderPayload, reminderResponse
} = require('./reminder-model');
const { isPrivateOrLocalAddress, resolvePublicIp, publicRequestOptions } = require('./public-network');

test('note text helpers strip markup, tolerate bad JSON and bound previews', () => {
  assert.equal(plainText('<p>Hi&nbsp;<b>there</b> &amp; <script>x()</script>you</p>'), 'Hi there & you');
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.deepEqual(parseJson('nope', []), []);
  assert.equal(notePreviewText({ noteBody: '', checkBoxes: JSON.stringify([{ data: '<b>one</b>' }, { data: 'two' }]) }), 'one two');
  assert.equal(notePreviewText({ noteBody: 'x'.repeat(1000) }).length, 280);
  assert.equal(noteLinkCount({ noteBody: 'see https://a.test/x, and https://a.test/x.', checkBoxes: JSON.stringify([{ data: 'http://b.test' }]) }), 2);
});

test('search operators are separated from the text and become SQL predicates', () => {
  assert.equal(searchTextFromQuery('milk !ima !label:work !t eggs'), 'milk eggs');
  assert.deepEqual(searchTokensFromQuery('Café !todo  Crème/Brûlée'), ['cafe', 'creme/brulee']);
  const operators = searchOperatorsFromQuery('!IMAGE !todo !draw !url !att !label:Work !l');
  assert.deepEqual(operators, { hasImage: true, hasCheckbox: true, hasDrawing: true, hasAnyLabel: true, hasUrl: true, hasAttachment: true, labels: ['work'] });
  const { clauses, params } = noteOperatorWhere(operators);
  assert.equal(clauses.length, 7);
  assert.deepEqual(params, ['%work%']);
  const plain = noteSearchWhere(['a', 'b']);
  assert.equal(plain.params.length, 10);
  assert.match(plain.clause, /AND/);
  const protectedSearch = noteSearchWhere(['a'], { protectLockedContent: true });
  assert.equal(protectedSearch.params.length, 8);
  assert.match(protectedSearch.clause, /locked = 1/);
  assert.deepEqual(noteSearchWhere([]), { clause: '', params: [] });
});

test('every search operator compiles in SQLite and selects the right notes', async () => {
  const sqlite3 = require('sqlite3');
  const db = new sqlite3.Database(':memory:');
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => (error ? reject(error) : resolve())));
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => (error ? reject(error) : resolve(rows))));
  try {
    await run(`CREATE TABLE notes (id INTEGER PRIMARY KEY, noteTitle TEXT, noteBody TEXT, bgImage TEXT, images TEXT, isCbox INTEGER,
      checkBoxes TEXT, labels TEXT, attachmentCount INTEGER, attachmentNames TEXT, binder TEXT, locked INTEGER)`);
    const insert = (id, fields) => run(
      `INSERT INTO notes (id, noteTitle, noteBody, images, labels, attachmentCount, locked) VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [id, fields.title || '', fields.body || '', fields.images || '[]', fields.labels || '[]', fields.attachments || 0]
    );
    await insert(1, { title: 'plain' });
    await insert(2, { images: '[{"id":"photo"}]' });
    await insert(3, { images: '[{"id":"drawing"}]' });
    await insert(4, { body: '<p>hi</p><img src="/api/uploads/images/a.png">' });
    await insert(5, { body: 'see https://example.test', labels: '["Work"]', attachments: 1 });
    const ids = async query => {
      const { clauses, params } = noteOperatorWhere(searchOperatorsFromQuery(query));
      return (await all(`SELECT id FROM notes WHERE ${clauses.join(' AND ')} ORDER BY id`, params)).map(row => row.id);
    };
    assert.deepEqual(await ids('!image'), [2, 4]);
    assert.deepEqual(await ids('!draw'), [3]);
    assert.deepEqual(await ids('!url'), [5]);
    assert.deepEqual(await ids('!att'), [5]);
    assert.deepEqual(await ids('!label:work'), [5]);
    assert.deepEqual(await ids('!l'), [5]);
    assert.deepEqual(await ids('!todo'), []);
    // Combined, as a user can type them: each must still be valid SQL next to the others.
    assert.deepEqual(await ids('!image !draw !todo !url !att !label:work !l'), []);
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
});

test('release versions compare by major, minor and patch', () => {
  const { compareVersion } = require('./version-compare');
  assert.equal(compareVersion('2.0.2', '2.0.1'), 1, 'a patch release is an update');
  assert.equal(compareVersion('v2.0.1', '2.0.2'), -1);
  assert.equal(compareVersion('2.1', '2.0.9'), 1);
  assert.equal(compareVersion('3.0.0', '2.9.9'), 1);
  assert.equal(compareVersion('2.0', '2.0.0'), 0);
  assert.equal(compareVersion('2.0.2-rc1', '2.0.2'), 0);
  assert.equal(compareVersion('', '0.0.1'), -1);
});

test('note HTML with active content is neutralized and clean HTML is left byte for byte', () => {
  const { neutralizeActiveHtml, neutralizeChecklist, hasActiveContent } = require('./html-safety');
  const clean = [
    '<p>Hi&nbsp;<b>there</b><br>again &amp; <a href="https://example.test/?a=1&amp;b=2">link</a></p>',
    '<ul><li>one</li><ul><li>two</li></ul></ul>',
    '<div><img src="/api/uploads/images/a.png" class="inline-note-image"><br></div>',
    '<div class="inline-note-image-wrap" data-id="x" contenteditable="false"><img src="data:image/png;base64,YWJj"></div>',
    'use the onload= option in a plain sentence'
  ];
  for (const html of clean) assert.equal(neutralizeActiveHtml(html), html, html);

  const hostile = {
    '<p>a</p><img src=x onerror=alert(1)>': ['onerror'],
    '<p>x</p><script>steal()</script>': ['<script', 'steal'],
    '<a href="javascript:steal()">click</a>': ['javascript'],
    '<a href="  JaVaScRiPt:steal()">click</a>': ['script:'],
    '<iframe src="https://evil.test"></iframe>text': ['iframe'],
    '<svg onload=alert(1)><circle/></svg>': ['onload', '<svg'],
    '<div style="x" onclick="steal()">kept text</div>': ['onclick']
  };
  for (const [html, forbidden] of Object.entries(hostile)) {
    assert.equal(hasActiveContent(html), true, html);
    const result = neutralizeActiveHtml(html).toLowerCase();
    for (const fragment of forbidden) assert.ok(!result.includes(fragment), `${html} -> ${result}`);
  }
  assert.match(neutralizeActiveHtml('<div style="x" onclick="steal()">kept text</div>'), /kept text/);
  assert.match(neutralizeActiveHtml('<p>a</p><img src=x onerror=alert(1)>'), /<p>a<\/p>/);

  const items = [{ id: 1, data: 'fine', done: false }, { id: 2, data: '<img src=x onerror=alert(1)>', done: true }];
  const neutral = neutralizeChecklist(items);
  assert.equal(neutral[0], items[0], 'a clean item is not copied');
  assert.ok(!neutral[1].data.includes('onerror'));
  assert.equal(neutral[1].done, true);
  assert.ok(!neutralizeChecklist(JSON.stringify(items)).includes('onerror'));
  assert.equal(neutralizeActiveHtml(undefined), undefined);
  assert.equal(neutralizeChecklist(undefined), undefined);
});

test('reminder schedules normalize the same way for comparison and storage', () => {
  assert.equal(normalizeRepeatRule(null), null);
  assert.equal(normalizeRepeatRule({ type: 'none' }), null);
  assert.equal(normalizeRepeatRule('{"type":"daily"}'), '{"type":"daily","moveToTopOnTrigger":false}');
  assert.equal(normalizeRepeatRule({ type: 'custom_days', intervalDays: 2.9 }), '{"type":"custom_days","intervalDays":2,"moveToTopOnTrigger":false}');
  assert.equal(normalizeRepeatRule({ type: 'yearly' }), null);
  assert.equal(normalizeRepeatRule('not json'), null);
  assert.deepEqual(parseRepeatRule({ type: 'weekly', moveToTopOnTrigger: 1 }), { type: 'weekly', moveToTopOnTrigger: true });
  assert.equal(normalizeReminderDueAt('2030-01-01T09:00:00+01:00'), '2030-01-01T08:00:00.000Z');
  assert.equal(normalizeReminderDueAt(''), null);
  assert.equal(normalizeLocationTrigger('Departure'), 'leave');
  assert.equal(normalizeLocationTrigger('whatever'), 'arrive');
  const base = { dueAtUtc: '2030-01-01T08:00:00Z', timezone: 'UTC', repeatRule: null };
  assert.equal(reminderScheduleDefinitionChanged(base, { ...base, dueAtUtc: '2030-01-01T08:00:00.000Z' }), false);
  assert.equal(reminderScheduleDefinitionChanged(base, { ...base, timezone: 'Europe/Rome' }), true);
  assert.equal(reminderScheduleDefinitionChanged(base, { ...base, repeatRule: { type: 'daily' } }), true);
});

test('rolling a repeating reminder over to its next occurrence is not a schedule edit', () => {
  const monthly = { dueAtUtc: '2030-02-28T09:00:00.000Z', scheduleAnchorAtUtc: '2030-01-31T09:00:00.000Z', timezone: 'UTC', repeatRule: '{"type":"monthly","moveToTopOnTrigger":false}' };
  const next = (changes) => ({ dueAtUtc: monthly.dueAtUtc, timezone: monthly.timezone, repeatRule: monthly.repeatRule, ...changes });
  assert.equal(reminderScheduleChanged(monthly, next({ dueAtUtc: '2030-03-31T09:00:00.000Z' })), false, 'the next occurrence keeps the 31st anchor');
  assert.equal(reminderScheduleChanged(monthly, next({ dueAtUtc: '2030-03-30T09:00:00.000Z' })), true, 'any other time is an edit');
  assert.equal(reminderScheduleChanged(monthly, next({ dueAtUtc: '2030-01-31T09:00:00.000Z' })), true, 'moving backwards is an edit');
  assert.equal(reminderScheduleChanged(monthly, next({ dueAtUtc: '2030-03-31T09:00:00.000Z', timezone: 'Europe/Rome' })), true);
  assert.equal(reminderScheduleChanged(monthly, next({ dueAtUtc: '2030-03-31T09:00:00.000Z', repeatRule: '{"type":"weekly","moveToTopOnTrigger":false}' })), true);
  assert.equal(reminderScheduleChanged(monthly, next({})), false, 'nothing changed');
  const single = { dueAtUtc: '2030-02-28T09:00:00.000Z', timezone: 'UTC', repeatRule: null };
  assert.equal(reminderScheduleChanged(single, { ...single, dueAtUtc: '2030-03-01T09:00:00.000Z' }), true, 'a one-off reminder is always edited');
});

test('reminder payloads accept every client spelling and fall back to the existing reminder', () => {
  const payload = normalizeReminderPayload({ note_id: '12', dateTime: '2030-01-01T08:00:00Z', location: { name: 'Home', lat: '1.5', lon: 2, radius: 50 }, title: '<b>Hi</b>' },
    { timezone: 'Europe/Rome', status: 'dismissed' });
  assert.deepEqual(payload, {
    noteId: 12, dueAtUtc: '2030-01-01T08:00:00.000Z', timezone: 'Europe/Rome', repeatRule: null, status: 'dismissed', title: 'Hi', body: null,
    imageUrl: null, locationName: 'Home', latitude: 1.5, longitude: 2, radiusMeters: 50, locationTrigger: 'arrive'
  });
  assert.equal(normalizeReminderPayload({ locationName: 'Gym' }).radiusMeters, 120);
  assert.equal(normalizeReminderPayload({}, { noteId: 3 }).noteId, 3);
});

test('reminder responses follow the note unless it is locked or inaccessible', () => {
  const reminder = { id: '4', userId: 1, noteId: 9, title: 'Stored', body: 'Stored body', locationTrigger: 'leave' };
  const notes = new Map([['1:9', { noteTitle: 'Live title', noteBody: '<p>Live body</p>', locked: 0 }]]);
  const live = reminderResponse(reminder, notes);
  assert.equal(live.title, 'Live title');
  assert.equal(live.body, 'Live body');
  assert.equal(live.deepLink, 'keeparr://note/9');
  assert.equal(live.id, 4);
  const locked = reminderResponse(reminder, new Map([['1:9', { noteTitle: 'Secret', noteBody: 'Secret body', locked: 1 }]]));
  assert.equal(locked.title, 'Stored');
  const hidden = reminderResponse(reminder, new Map());
  assert.equal(hidden.title, null);
  assert.equal(hidden.deepLink, null);
  const located = reminderResponse({ ...reminder, locationName: 'Home', latitude: 1, longitude: 2 }, notes);
  assert.deepEqual(located.location, { displayName: 'Home', name: 'Home', latitude: 1, longitude: 2, radiusMeters: 120, triggerType: 'leave', locationTrigger: 'leave' });
});

test('server-side fetches are limited to public addresses and pinned to the checked one', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip', '']) {
    assert.equal(isPrivateOrLocalAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPrivateOrLocalAddress(address), false, address);
  await assert.rejects(resolvePublicIp('localhost'), /Private network targets are blocked/);
  await assert.rejects(publicRequestOptions('ftp://example.test/file'), /Unsupported protocol/);
  await assert.rejects(publicRequestOptions('http://127.0.0.1/'), /Private network targets are blocked/);
  const options = await publicRequestOptions('http://1.1.1.1/', { method: 'GET' });
  assert.equal(options.method, 'GET');
  await new Promise(resolve => options.lookup('ignored.test', {}, (_error, address, family) => { assert.equal(address, '1.1.1.1'); assert.equal(family, 4); resolve(); }));
  await new Promise(resolve => options.lookup('ignored.test', { all: true }, (_error, list) => { assert.deepEqual(list, [{ address: '1.1.1.1', family: 4 }]); resolve(); }));
});
