const { MAX_MUTATIONS_PER_REQUEST, orderMutations, validateMutationEnvelope } = require('./sync-protocol');

function mountSyncMutationRoute(app, { requireAuth, asyncRoute, executeSyncMutation, syncSnapshotForUser, syncCursorForUser, testMode }) {
  app.post('/api/sync/mutations', requireAuth, asyncRoute(async (req, res) => {
    const mutations = Array.isArray(req.body?.mutations) ? req.body.mutations : [];
    if (!mutations.length) return res.json({ results: [], serverTime: Date.now() });
    if (mutations.length > MAX_MUTATIONS_PER_REQUEST) {
      return res.status(413).json({ error: `At most ${MAX_MUTATIONS_PER_REQUEST} mutations may be sent at once.` });
    }
    const ordered = orderMutations(mutations);
    const results = new Array(mutations.length);
    for (const { mutation, index } of ordered) {
      const invalid = validateMutationEnvelope(mutation);
      if (invalid) { results[index] = invalid; continue; }
      try {
        results[index] = await executeSyncMutation(req.user.id, mutation);
      } catch (error) {
        console.error('Sync mutation failed:', error);
        results[index] = { ok: false, status: 500, error: error.message || 'Sync mutation failed.', type: mutation.type };
      }
    }
    // New clients catch up from their durable cursor. Older clients retain the full snapshot response.
    const includeSnapshot = req.body?.includeSnapshot !== false;
    const snapshot = includeSnapshot ? await syncSnapshotForUser(req.user.id) : null;
    // This is a high-water mark, not a cursor that clients may persist directly.
    const serverCursor = snapshot?.cursor ?? await syncCursorForUser(req.user.id);
    if (testMode && req.get('x-kept-test-drop-response') === '1') {
      req.socket.destroy();
      return;
    }
    res.json({
      results,
      serverTime: Date.now(),
      serverCursor,
      ...(snapshot ? { snapshot } : {})
    });
  }));
}

module.exports = { mountSyncMutationRoute };
