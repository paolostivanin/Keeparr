// Rules at the sync boundary that do not need the database: last-writer-wins stamps, the accepted client clock skew,
// mutation validation/ordering, and request-parameter parsing. Pure, so it can be tested without a server.
const crypto = require('crypto');

const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_MUTATIONS_PER_REQUEST = 500;
const MAX_CHANGES_PER_PAGE = 2000;
const DEFAULT_CHANGES_PER_PAGE = 500;

// Client-supplied timestamps and sort orders may only be this far from the server's clock.
function clampToClockSkew(value, now = Date.now()) {
  return Math.max(now - CLOCK_SKEW_MS, Math.min(now + CLOCK_SKEW_MS, value));
}

function serverLwwStamp() {
  return {
    physicalMs: Date.now(),
    logical: 0,
    deviceId: 'server',
    operationId: crypto.randomUUID()
  };
}

function normalizeLwwStamp(value = {}) {
  const now = Date.now();
  const requested = Number(value.physicalMs || value.lwwPhysicalMs || now);
  return {
    physicalMs: clampToClockSkew(Number.isFinite(requested) ? requested : now, now),
    logical: Math.max(0, Math.floor(Number(value.logical ?? value.lwwLogical ?? 0) || 0)),
    deviceId: String(value.deviceId || value.lwwDeviceId || 'unknown').slice(0, 160),
    operationId: String(value.operationId || value.lwwOperationId || crypto.randomUUID()).slice(0, 160)
  };
}

function rowLwwStamp(row = {}) {
  return {
    physicalMs: Number(row.lwwPhysicalMs || 0),
    logical: Number(row.lwwLogical || 0),
    deviceId: String(row.lwwDeviceId || ''),
    operationId: String(row.lwwOperationId || '')
  };
}

function compareLwwStamp(left, right) {
  const keys = ['physicalMs', 'logical'];
  for (const key of keys) {
    const delta = Number(left[key] || 0) - Number(right[key] || 0);
    if (delta) return delta;
  }
  const device = String(left.deviceId || '').localeCompare(String(right.deviceId || ''));
  if (device) return device;
  return String(left.operationId || '').localeCompare(String(right.operationId || ''));
}

function clampClientSortOrder(value) {
  const now = Date.now();
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return now;
  return clampToClockSkew(n, now);
}

// Within one request, edits to a note go first and deletions last; equal priorities keep their request order.
const MUTATION_PRIORITY = {
  'note.upsert': 0,
  'note.patch': 0,
  'note.view-state': 1,
  'note.reorder': 3,
  'reminder.upsert': 4,
  'reminder.delete': 5,
  'note.merge': 6,
  'note.delete': 7,
  'attachment.delete': 8
};

function orderMutations(mutations) {
  return mutations
    .map((mutation, index) => ({ mutation, index }))
    .sort((left, right) =>
      (MUTATION_PRIORITY[left.mutation?.type] ?? 99) - (MUTATION_PRIORITY[right.mutation?.type] ?? 99) || left.index - right.index);
}

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Shape check for one mutation from an external client. Returns the failure result to send back, or null when the
// envelope is well-formed. The mutation's payload keeps being validated by its own handler.
function validateMutationEnvelope(mutation) {
  if (!isPlainObject(mutation)) return { ok: false, status: 400, error: 'A mutation must be an object.' };
  const type = mutation.type;
  if (typeof type !== 'string' || !type || type.length > 64) return { ok: false, status: 400, error: 'A mutation needs a type.', type: String(type ?? '').slice(0, 64) };
  const operationId = mutation.operationId;
  if (operationId !== undefined && (typeof operationId !== 'string' || !operationId || operationId.length > 160)) {
    return { ok: false, status: 400, error: 'Invalid operationId.', type };
  }
  if (mutation.syncId !== undefined && (typeof mutation.syncId !== 'string' || mutation.syncId.length > 200)) {
    return { ok: false, status: 400, error: 'Invalid syncId.', type };
  }
  if (mutation.payload !== undefined && mutation.payload !== null && !isPlainObject(mutation.payload)) {
    return { ok: false, status: 400, error: 'A mutation payload must be an object.', type };
  }
  return null;
}

// Cursor and page size of GET /api/sync/changes. Lenient like before (bad values fall back), but in one place.
function parseChangesQuery(query = {}) {
  const cursor = Number(query.cursor || query.since || 0);
  const requested = Number(query.limit);
  return {
    since: Number.isFinite(cursor) && cursor > 0 ? Math.floor(cursor) : 0,
    limit: Math.min(Math.max(Number.isFinite(requested) && requested ? requested : DEFAULT_CHANGES_PER_PAGE, 1), MAX_CHANGES_PER_PAGE)
  };
}

module.exports = {
  CLOCK_SKEW_MS, MAX_MUTATIONS_PER_REQUEST, clampToClockSkew,
  serverLwwStamp, normalizeLwwStamp, rowLwwStamp, compareLwwStamp, clampClientSortOrder,
  MUTATION_PRIORITY, orderMutations, validateMutationEnvelope, parseChangesQuery
};
