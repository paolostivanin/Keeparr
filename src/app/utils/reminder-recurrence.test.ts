// node --test src/app/utils/reminder-recurrence.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { nextRepeatDueAt } from './reminder-recurrence.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../test-fixtures/native-contract.json', import.meta.url), 'utf8')) as {
  recurrence: Array<{ id: string; dueAtUtc: string; anchorAtUtc?: string; timezone: string; rule: { type: 'daily'; intervalDays?: number }; now: string; nextDueAtUtc: string }>;
};

// The server and Android consume the same fixtures; the web must agree with them.
for (const item of fixture.recurrence) {
  test(`shared recurrence fixture: ${item.id}`, () => {
    assert.equal(nextRepeatDueAt(item.dueAtUtc, item.rule, item.timezone, Date.parse(item.now), item.anchorAtUtc ?? item.dueAtUtc), item.nextDueAtUtc);
  });
}

test('a reminder that is not repeating has no next occurrence', () => {
  assert.equal(nextRepeatDueAt('2030-01-01T09:00:00Z', { type: 'none' }, 'UTC', 0), null);
  assert.equal(nextRepeatDueAt('2030-01-01T09:00:00Z', null, 'UTC', 0), null);
});

test('a schedule returns to its own time of day after a DST gap moved one occurrence', () => {
  const anchor = '2026-03-28T01:30:00.000Z';
  const afterGap = nextRepeatDueAt(anchor, { type: 'daily' }, 'Europe/Rome', Date.parse('2026-03-28T02:00:00Z'), anchor);
  assert.equal(afterGap, '2026-03-29T01:30:00.000Z');
  assert.equal(nextRepeatDueAt(afterGap, { type: 'daily' }, 'Europe/Rome', Date.parse(afterGap!) + 1, anchor), '2026-03-30T00:30:00.000Z');
});

test('catching up a very old reminder is immediate and lands on the right occurrence', () => {
  const started = Date.now();
  const now = Date.parse('2030-01-01T09:01:00Z');
  assert.equal(nextRepeatDueAt('1000-01-01T09:00:00.000Z', { type: 'daily' }, 'UTC', now), '2030-01-02T09:00:00.000Z');
  assert.equal(nextRepeatDueAt('1970-01-01T09:00:00.000Z', { type: 'custom_days', intervalDays: 3 }, 'UTC', now), '2030-01-04T09:00:00.000Z');
  assert.equal(nextRepeatDueAt('1970-01-05T09:00:00.000Z', { type: 'weekly' }, 'UTC', now), '2030-01-07T09:00:00.000Z');
  assert.equal(nextRepeatDueAt('1000-01-31T09:00:00.000Z', { type: 'monthly' }, 'UTC', Date.parse('2030-02-01T00:00:00Z')), '2030-02-28T09:00:00.000Z');
  assert.ok(Date.now() - started < 1500);
});
