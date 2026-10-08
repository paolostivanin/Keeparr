// Request parsing for a user's manual note order.

const MAX_ORDER_POSITIONS = 20000;
const MAX_POSITION = 1e15;

// Ids from a client list, unique, in order, restricted to those the caller may order.
function orderedAccessibleIds(requested, accessible) {
  const seen = new Set();
  const result = [];
  for (const id of requested) {
    if (accessible.has(id) && !seen.has(id)) { seen.add(id); result.push(id); }
  }
  return result;
}

// `positions` from a reorder request: [{ syncId | id, sortOrder }, ...], the new stored position of each note that moved.
// Returns undefined when the client sent none (older clients: the whole ordered list is used instead), false when the value
// is malformed, otherwise [{ key, sortOrder }] with each note listed once (the last value wins).
function parseOrderPositions(value, keyField = 'syncId') {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ORDER_POSITIONS) return false;
  const byKey = new Map();
  for (const item of value) {
    if (!item || typeof item !== 'object') return false;
    const key = keyField === 'id' ? Number(item.id) : item.syncId;
    const sortOrder = item.sortOrder;
    if (keyField === 'id' ? !Number.isSafeInteger(key) || key <= 0 : typeof key !== 'string' || !key || key.length > 200) return false;
    if (typeof sortOrder !== 'number' || !Number.isFinite(sortOrder) || Math.abs(sortOrder) > MAX_POSITION) return false;
    byKey.set(key, sortOrder);
  }
  return [...byKey].map(([key, sortOrder]) => ({ key, sortOrder }));
}

module.exports = { MAX_ORDER_POSITIONS, orderedAccessibleIds, parseOrderPositions };
