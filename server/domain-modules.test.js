const test = require('node:test');
const assert = require('node:assert/strict');
const { plainText, parseJson, escapeHtml, notePreviewText, noteLinkCount } = require('./note-text');
const { searchTextFromQuery, searchTokensFromQuery, searchOperatorsFromQuery, noteOperatorWhere, noteSearchWhere } = require('./note-search');
const {
  normalizeRepeatRule, normalizeReminderDueAt, normalizeLocationTrigger, reminderScheduleDefinitionChanged, parseRepeatRule,
  normalizeReminderPayload, reminderResponse
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
