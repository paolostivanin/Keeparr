const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  CLOCK_SKEW_MS, MAX_MUTATIONS_PER_REQUEST, clampToClockSkew, normalizeLwwStamp, compareLwwStamp, rowLwwStamp, clampClientSortOrder,
  orderMutations, validateMutationEnvelope, parseChangesQuery
} = require('./sync-protocol');
const { mountSyncMutationRoute } = require('./sync-routes');

test('client clocks and sort orders are held to the same skew window', () => {
  const now = 1_700_000_000_000;
  assert.equal(clampToClockSkew(now + 10 * CLOCK_SKEW_MS, now), now + CLOCK_SKEW_MS);
  assert.equal(clampToClockSkew(now - 10 * CLOCK_SKEW_MS, now), now - CLOCK_SKEW_MS);
  assert.equal(clampToClockSkew(now + 1000, now), now + 1000);
  const stamp = normalizeLwwStamp({ physicalMs: Date.now() + 10 * CLOCK_SKEW_MS, logical: -4.9, deviceId: 'd'.repeat(500) });
  assert.ok(stamp.physicalMs <= Date.now() + CLOCK_SKEW_MS + 50);
  assert.equal(stamp.logical, 0);
  assert.equal(stamp.deviceId.length, 160);
  assert.ok(stamp.operationId);
  assert.ok(Math.abs(clampClientSortOrder(-1) - Date.now()) < 1000);
  assert.ok(clampClientSortOrder(1) >= Date.now() - CLOCK_SKEW_MS - 50);
  assert.ok(clampClientSortOrder(Number.MAX_SAFE_INTEGER) <= Date.now() + CLOCK_SKEW_MS + 50);
});

test('last-writer-wins compares time, then counter, device and operation', () => {
  const base = { physicalMs: 10, logical: 1, deviceId: 'a', operationId: 'x' };
  assert.ok(compareLwwStamp({ ...base, physicalMs: 11 }, base) > 0);
  assert.ok(compareLwwStamp(base, { ...base, logical: 2 }) < 0);
  assert.ok(compareLwwStamp({ ...base, deviceId: 'b' }, base) > 0);
  assert.ok(compareLwwStamp(base, { ...base, operationId: 'y' }) < 0);
  assert.equal(compareLwwStamp(base, { ...base }), 0);
  assert.deepEqual(rowLwwStamp({ lwwPhysicalMs: '5', lwwDeviceId: 'z' }), { physicalMs: 5, logical: 0, deviceId: 'z', operationId: '' });
});

test('mutations apply edits first and deletions last, keeping request order within a priority', () => {
  const types = ['note.delete', 'note.upsert', 'reminder.upsert', 'note.upsert', 'unknown', 'note.reorder', 'attachment.delete', 'note.view-state'];
  const ordered = orderMutations(types.map(type => ({ type }))).map(item => item.index);
  assert.deepEqual(ordered, [1, 3, 7, 5, 2, 0, 6, 4]);
  assert.doesNotThrow(() => orderMutations([null, { type: 'note.upsert' }]));
});

test('mutation envelopes are validated before dispatch', () => {
  assert.equal(validateMutationEnvelope({ type: 'note.upsert', syncId: 'a', operationId: 'op', payload: { x: 1 } }), null);
  assert.equal(validateMutationEnvelope({ type: 'note.delete' }), null, 'legacy clients may omit operationId, syncId and payload');
  assert.equal(validateMutationEnvelope({ type: 'note.upsert', payload: null }), null);
  for (const bad of [null, 'x', 7, [], {}, { type: '' }, { type: 5 }, { type: 'x'.repeat(65) },
    { type: 'a', operationId: '' }, { type: 'a', operationId: 3 }, { type: 'a', operationId: 'o'.repeat(161) },
    { type: 'a', syncId: 9 }, { type: 'a', syncId: 's'.repeat(201) }, { type: 'a', payload: [] }, { type: 'a', payload: 'text' }]) {
    const result = validateMutationEnvelope(bad);
    assert.equal(result?.ok, false, JSON.stringify(bad));
    assert.equal(result.status, 400);
  }
});

test('change-feed paging parameters are lenient but bounded', () => {
  assert.deepEqual(parseChangesQuery({}), { since: 0, limit: 500 });
  assert.deepEqual(parseChangesQuery({ cursor: '41', limit: '10' }), { since: 41, limit: 10 });
  assert.deepEqual(parseChangesQuery({ since: '7' }), { since: 7, limit: 500 });
  assert.deepEqual(parseChangesQuery({ cursor: '-3', limit: '0' }), { since: 0, limit: 500 });
  assert.deepEqual(parseChangesQuery({ cursor: 'abc', limit: 'x' }), { since: 0, limit: 500 });
  assert.deepEqual(parseChangesQuery({ cursor: '5.9', limit: '99999' }), { since: 5, limit: 2000 });
  assert.deepEqual(parseChangesQuery({ limit: '-5' }), { since: 0, limit: 1 });
});

async function withRoute(handler, body) {
  const app = express();
  app.use(express.json());
  const executed = [];
  mountSyncMutationRoute(app, {
    requireAuth: (request, _response, next) => { request.user = { id: 1 }; next(); },
    asyncRoute: fn => (request, response, next) => fn(request, response, next).catch(next),
    executeSyncMutation: async (_user, mutation) => { executed.push(mutation.type); return handler(mutation); },
    syncSnapshotForUser: async () => null,
    syncCursorForUser: async () => 9,
    testMode: false
  });
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sync/mutations`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, json: await response.json(), executed };
  } finally { server.close(); }
}

test('the mutation route rejects malformed entries individually and applies the rest in order', async () => {
  const { status, json, executed } = await withRoute(m => ({ ok: true, type: m.type }), {
    includeSnapshot: false,
    mutations: [{ type: 'note.delete', operationId: 'a' }, null, { type: 'note.upsert', payload: [] }, { type: 'note.upsert', operationId: 'b', payload: {} }]
  });
  assert.equal(status, 200);
  assert.deepEqual(executed, ['note.upsert', 'note.delete'], 'only valid entries run, edits before deletions');
  assert.deepEqual(json.results.map(r => [r.ok, r.status ?? null]), [[true, null], [false, 400], [false, 400], [true, null]]);
  assert.equal(json.serverCursor, 9);
});

test('the mutation route bounds a request instead of running unbounded work', async () => {
  const mutations = Array.from({ length: MAX_MUTATIONS_PER_REQUEST + 1 }, () => ({ type: 'note.upsert', payload: {} }));
  const { status, executed } = await withRoute(() => ({ ok: true }), { mutations });
  assert.equal(status, 413);
  assert.equal(executed.length, 0);
});
