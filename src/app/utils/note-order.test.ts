// node --test src/app/utils/note-order.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { planNoteOrder } from './note-order.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../test-fixtures/note-order-plan.json', import.meta.url), 'utf8')) as {
  cases: Array<{ name: string; desired: number[]; current: Array<[number, number]>; pinned: number[]; expected: Array<[number, number]> }>;
};

for (const item of fixture.cases) {
  test(`shared plan fixture: ${item.name}`, () => {
    assert.deepEqual(planNoteOrder({ desired: item.desired, current: new Map(item.current), pinned: new Set(item.pinned) }), item.expected);
  });
}

// Displayed order of the notes after applying a plan: position, then id, both descending.
function displayed(ids: number[], values: Map<number, number>, plan: Array<[number, number]>) {
  const next = new Map(values);
  for (const [id, value] of plan) next.set(id, value);
  return { order: [...ids].sort((a, b) => next.get(b)! - next.get(a)! || b - a), next };
}

test('every move in a long list is honoured and rewrites only what moved', () => {
  const ids = Array.from({ length: 400 }, (_, index) => index + 1);
  let values = new Map(ids.map((id, index) => [id, 1_700_000_000_000 - index * 1000]));
  let order = [...ids];
  let seed = 11;
  let written = 0;
  for (let round = 0; round < 300; round += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const from = seed % order.length;
    const to = (seed >> 7) % order.length;
    const desired = [...order];
    desired.splice(to, 0, desired.splice(from, 1)[0]);
    const plan = planNoteOrder({ desired, current: values });
    assert.ok(plan.length <= 1, `a single move writes one note (round ${round} wrote ${plan.length})`);
    written += plan.length;
    const result = displayed(ids, values, plan);
    assert.deepEqual(result.order, desired, `round ${round}`);
    values = result.next;
    order = result.order;
  }
  assert.ok(written <= 300);
});

test('swapping many pairs at once stays correct and is bounded by the pairs', () => {
  const ids = Array.from({ length: 1000 }, (_, index) => index + 1);
  const values = new Map(ids.map((id, index) => [id, 10_000 - index * 3]));
  const desired = [...ids];
  for (let index = 0; index < 100; index += 1) [desired[index * 10], desired[index * 10 + 1]] = [desired[index * 10 + 1], desired[index * 10]];
  const plan = planNoteOrder({ desired, current: values });
  assert.ok(plan.length <= 100);
  assert.deepEqual(displayed(ids, values, plan).order, desired);
});

test('pinned notes keep their own order and never need rewriting for the others', () => {
  const values = new Map([[1, 5], [2, 4], [3, 100], [4, 90]]);
  const plan = planNoteOrder({ desired: [1, 2, 4, 3], current: values, pinned: new Set([1, 2]) });
  assert.deepEqual(plan.map(([id]) => id), [4]);
});
