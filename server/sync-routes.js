function mountSyncMutationRoute(app, { requireAuth, asyncRoute, executeSyncMutation, syncSnapshotForUser, syncCursorForUser, testMode }) {
  app.post('/api/sync/mutations', requireAuth, asyncRoute(async (req, res) => {
    const mutations = Array.isArray(req.body?.mutations) ? req.body.mutations : [];
    if (!mutations.length) return res.json({ results: [], serverTime: Date.now() });
    const priority = {
      'note.upsert': 0,
      'note.patch': 0,
      'note.view-state': 1,
      'note.delete': 7,
      'note.reorder': 3,
      'reminder.upsert': 4,
      'reminder.delete': 5,
      'note.merge': 6,
      'attachment.delete': 8
    };
    const ordered = mutations
      .map((mutation, index) => ({ mutation, index }))
      .sort((left, right) =>
        (priority[left.mutation.type] ?? 99) - (priority[right.mutation.type] ?? 99) || left.index - right.index
      );
    const results = new Array(mutations.length);
    for (const { mutation, index } of ordered) {
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
