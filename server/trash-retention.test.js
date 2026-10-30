const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness } = require('./test-harness');

test('trash retention defaults to 30 days and only accepts valid administrator updates', async t => {
  const harness = createHarness();
  t.after(async () => { await harness.stop(); harness.cleanup(); });
  await harness.start();
  const token = await harness.setupAdmin();
  assert.equal((await harness.call('/trash-retention')).status, 401);
  assert.equal((await harness.call('/trash-retention', { token })).body.days, 30);
  assert.equal((await harness.call('/users', { method: 'POST', token, body: { username: 'regular', displayName: 'Regular', password: 'regular-pass-123' } })).status, 201);
  const regular = await harness.login('regular', 'regular-pass-123');
  assert.equal((await harness.call('/trash-retention', { token: regular })).body.days, 30);
  assert.equal((await harness.call('/trash-retention', { method: 'PUT', token: regular, body: { days: 7 } })).status, 403);
  for (const days of [6, 366, 7.5, '30', null]) {
    assert.equal((await harness.call('/trash-retention', { method: 'PUT', token, body: { days } })).status, 400);
  }
  assert.equal((await harness.call('/trash-retention', { method: 'PUT', token, body: { days: 45 } })).body.days, 45);
  await harness.stop();
  await harness.start();
  assert.equal((await harness.call('/trash-retention', { token })).body.days, 45);
});
