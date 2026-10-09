const test = require('node:test');
const assert = require('node:assert/strict');
const fixtures = require('../test-fixtures/native-contract.json');
const { nextRepeatDueAt, isRepeatOccurrence } = require('./reminder-recurrence');

for (const fixture of fixtures.recurrence) {
  test(`shared recurrence fixture: ${fixture.id}`, () => {
    assert.equal(nextRepeatDueAt(fixture.dueAtUtc, fixture.rule, fixture.timezone, Date.parse(fixture.now), fixture.anchorAtUtc), fixture.nextDueAtUtc);
  });
}

test('a later valid occurrence remains actionable after the reminder cursor advances', () => {
  assert.equal(isRepeatOccurrence('2030-01-01T09:00:00.000Z', '2030-01-04T09:00:00.000Z', { type: 'daily' }, 'UTC'), true);
  assert.equal(isRepeatOccurrence('2030-01-01T09:00:00.000Z', '2030-01-04T09:01:00.000Z', { type: 'daily' }, 'UTC'), false);
});

test('a schedule returns to its own time of day after a DST gap moved one occurrence', () => {
  // 02:30 Rome does not exist on 2026-03-29; that one day moves to 03:30 and the next day is 02:30 again.
  const anchor = '2026-03-28T01:30:00.000Z';
  const afterGap = nextRepeatDueAt(anchor, { type: 'daily' }, 'Europe/Rome', Date.parse('2026-03-28T02:00:00Z'), anchor);
  assert.equal(afterGap, '2026-03-29T01:30:00.000Z');
  assert.equal(nextRepeatDueAt(afterGap, { type: 'daily' }, 'Europe/Rome', Date.parse(afterGap) + 1, anchor), '2026-03-30T00:30:00.000Z');
});

test('catching up a very old reminder takes constant time and lands on the right occurrence', () => {
  const started = Date.now();
  const now = Date.parse('2030-01-01T09:01:00Z');
  // UTC has no DST and no historical offsets, so the expected instants are plain calendar arithmetic.
  assert.equal(nextRepeatDueAt('1000-01-01T09:00:00.000Z', { type: 'daily' }, 'UTC', now), '2030-01-02T09:00:00.000Z');
  assert.equal(nextRepeatDueAt('1970-01-01T09:00:00.000Z', { type: 'custom_days', intervalDays: 3 }, 'UTC', now), '2030-01-04T09:00:00.000Z');
  assert.equal(nextRepeatDueAt('1970-01-05T09:00:00.000Z', { type: 'weekly' }, 'UTC', now), '2030-01-07T09:00:00.000Z');
  assert.equal(nextRepeatDueAt('1000-01-31T09:00:00.000Z', { type: 'monthly' }, 'UTC', Date.parse('2030-02-01T00:00:00Z')), '2030-02-28T09:00:00.000Z');
  assert.ok(Date.now() - started < 1500, 'skipping ahead must not walk every missed occurrence');
});

test('occurrence checks stay exact and fast far from the anchor', () => {
  const started = Date.now();
  assert.equal(isRepeatOccurrence('1970-01-01T09:00:00.000Z', '2030-01-01T09:00:00.000Z', { type: 'daily' }, 'UTC'), true);
  assert.equal(isRepeatOccurrence('1970-01-01T09:00:00.000Z', '2030-01-01T09:00:01.000Z', { type: 'daily' }, 'UTC'), false);
  assert.equal(isRepeatOccurrence('2030-01-01T09:00:00.000Z', '2029-12-31T09:00:00.000Z', { type: 'daily' }, 'UTC'), false);
  assert.equal(isRepeatOccurrence('2000-01-31T09:00:00.000Z', '2030-03-31T09:00:00.000Z', { type: 'monthly' }, 'UTC'), true);
  assert.equal(isRepeatOccurrence('2000-01-31T09:00:00.000Z', '2030-02-28T09:00:00.000Z', { type: 'monthly' }, 'UTC'), true);
  assert.equal(isRepeatOccurrence('2000-01-31T09:00:00.000Z', '2030-02-27T09:00:00.000Z', { type: 'monthly' }, 'UTC'), false);
  assert.ok(Date.now() - started < 1500);
});
