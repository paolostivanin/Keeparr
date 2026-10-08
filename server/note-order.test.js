const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_ORDER_POSITIONS, orderedAccessibleIds, parseOrderPositions } = require('./note-order');

test('clients that send no positions keep the whole-list behaviour', () => {
  assert.equal(parseOrderPositions(undefined), undefined);
  assert.equal(parseOrderPositions(null), undefined);
});

test('positions are validated and deduplicated with the last value winning', () => {
  assert.deepEqual(parseOrderPositions([{ syncId: 'a', sortOrder: 5 }, { syncId: 'b', sortOrder: -1.5 }, { syncId: 'a', sortOrder: 6 }]),
    [{ key: 'a', sortOrder: 6 }, { key: 'b', sortOrder: -1.5 }]);
  assert.deepEqual(parseOrderPositions([{ id: '12', sortOrder: 1700000000000.5 }], 'id'), [{ key: 12, sortOrder: 1700000000000.5 }]);
  assert.deepEqual(parseOrderPositions([]), []);
  for (const bad of ['x', {}, [null], [7], [{ syncId: '', sortOrder: 1 }], [{ syncId: 5, sortOrder: 1 }], [{ syncId: 'a' }], [{ syncId: 'a', sortOrder: '1' }],
    [{ syncId: 'a', sortOrder: NaN }], [{ syncId: 'a', sortOrder: Infinity }], [{ syncId: 'a', sortOrder: 1e16 }], [{ syncId: 'a'.repeat(201), sortOrder: 1 }]]) {
    assert.equal(parseOrderPositions(bad), false, JSON.stringify(bad));
  }
  assert.equal(parseOrderPositions([{ id: 0, sortOrder: 1 }], 'id'), false);
  assert.equal(parseOrderPositions([{ id: 1.5, sortOrder: 1 }], 'id'), false);
  assert.equal(parseOrderPositions(Array.from({ length: MAX_ORDER_POSITIONS + 1 }, (_, i) => ({ syncId: `n${i}`, sortOrder: i }))), false);
});

test('requested ids are limited to accessible notes, once each, in the requested order', () => {
  assert.deepEqual(orderedAccessibleIds([3, 1, 3, 9, 2, 1], new Map([[1, {}], [2, {}], [3, {}]])), [3, 1, 2]);
  assert.deepEqual(orderedAccessibleIds(['b', 'a'], new Set(['a', 'b'])), ['b', 'a']);
});
