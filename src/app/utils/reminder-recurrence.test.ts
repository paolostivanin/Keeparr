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
