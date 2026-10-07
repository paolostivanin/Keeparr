function mountClientCapabilities(app, requireAuth, serverVersion) {
  app.get('/api/client/capabilities', requireAuth, (_request, response) => response.json({
    serverVersion,
    nativeProtocolVersion: 3,
    noteRevisions: true,
    personalReminders: true,
    reminderOccurrences: true,
    reminderScheduleDefinitions: true,
    idempotentMutations: true,
    incrementalMutationResponses: true
  }));
}

module.exports = { mountClientCapabilities };
