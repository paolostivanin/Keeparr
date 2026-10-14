// Assistant routes: context, validating and executing action plans.
const { accessibleNoteSummaries, accessibleNoteSummaryRows, noteSummaryFromRow } = require('../note-data');
const { afterDatabaseCommit, all, withDatabaseTransaction } = require('../db');
const { asyncRoute, requireAuth } = require('../auth');
const { broadcastNoteChange } = require('../notes');
const { cleanupUnusedLabels } = require('../labels');
const {
  executeSmartAction, insertAiActionHistory, selectedActionsWithDependencies, setOwnedNoteLifecycleState, syncSmartReminderIntegrations, validateKeeparrActionPlan
} = require('../ai');
const { publicCollaborator, publicUser } = require('../users');

function mountAiRoutes(app) {
  app.get('/api/ai/context', requireAuth, asyncRoute(async (req, res) => {
    const query = String(req.query.query || req.query.q || '').trim();
    const labels = await all('SELECT id, name FROM labels WHERE userId = ? ORDER BY name COLLATE NOCASE', [req.user.id]);
    const users = await all(
      `SELECT id, username, displayName, avatarDataUrl, avatarPreset
     FROM users
     WHERE id != ? AND enabled = 1
     ORDER BY displayName COLLATE NOCASE, username COLLATE NOCASE
     LIMIT 50`,
      [req.user.id]
    );
    const recentNotes = await accessibleNoteSummaries(req.user.id, { limit: 20 });
    let candidateNotes = query
      ? await accessibleNoteSummaries(req.user.id, { query, limit: 20 })
      : recentNotes;
    if (!candidateNotes.length) candidateNotes = recentNotes;

    let currentOpenNote = null;
    const currentOpenNoteId = Number(req.query.currentOpenNoteId || 0);
    if (currentOpenNoteId) {
      const rows = await accessibleNoteSummaryRows(req.user.id, { noteId: currentOpenNoteId, limit: 1 });
      currentOpenNote = rows[0] ? noteSummaryFromRow(rows[0]) : null;
    }

    res.json({
      currentUser: publicUser(req.user),
      labels,
      users: users.map(publicCollaborator),
      recentNotes,
      candidateNotes,
      currentOpenNote
    });
  }));

  app.post('/api/ai/action-plan/validate', requireAuth, asyncRoute(async (req, res) => {
    const transcript = String(req.body.transcript || '');
    const actionPlan = req.body.actionPlan;
    const validation = await validateKeeparrActionPlan(req.user.id, transcript, actionPlan);
    await insertAiActionHistory(
      req.user.id,
      transcript,
      actionPlan,
      validation.normalizedPlan,
      validation.valid ? 'validated' : 'failed'
    );
    res.json(validation);
  }));

  app.post('/api/ai/action-plan/execute', requireAuth, asyncRoute(async (req, res) => {
    const transcript = String(req.body.transcript || '');
    const actionPlan = req.body.actionPlan;
    const executeOptions = req.body.executeOptions || req.body.options || {};
    const validation = await validateKeeparrActionPlan(req.user.id, transcript, actionPlan);
    if (!validation.valid) {
      await insertAiActionHistory(req.user.id, transcript, actionPlan, validation.normalizedPlan, 'failed');
      return res.status(400).json({ ok: false, errors: validation.errors, validation });
    }
    if (validation.requiresConfirmation && executeOptions.confirmed !== true) {
      await insertAiActionHistory(req.user.id, transcript, actionPlan, validation.normalizedPlan, 'failed');
      return res.status(409).json({
        ok: false,
        errors: ['This action plan requires confirmation before execution.'],
        requiresConfirmation: true,
        normalizedPlan: validation.normalizedPlan
      });
    }

    const allowPartial = !!executeOptions.allowPartial;
    const selected = Array.isArray(executeOptions.selectedActionIndexes)
      ? new Set(executeOptions.selectedActionIndexes.map(Number).filter(Number.isInteger))
      : null;
    const actions = selectedActionsWithDependencies(validation.normalizedPlan.actions, selected);
    const state = {
      createdNoteIds: [],
      updatedNoteIds: new Set(),
      createdLabelIds: new Set(),
      reminderIds: [],
      remindersToSync: [],
      shareBroadcasts: [],
      lastCreatedNoteId: null
    };
    const executed = [];
    const failed = [];

    let transactionError = null;
    try {
      await withDatabaseTransaction(async () => {
        for (let index = 0; index < actions.length; index += 1) {
          const action = actions[index];
          try {
            const result = await executeSmartAction(req.user.id, action, state);
            executed.push({ index, ...result });
          } catch (error) {
            failed.push({ index, type: action.type, error: error.message || 'Action failed.' });
            if (!allowPartial) throw error;
          }
        }
        for (const noteId of state.createdNoteIds) await broadcastNoteChange(noteId, 'created', [req.user.id]);
        for (const noteId of state.updatedNoteIds) await broadcastNoteChange(noteId, 'updated');
        for (const share of state.shareBroadcasts) await broadcastNoteChange(share.noteId, 'collaborators-updated', share.previousRecipients);
        if (state.createdLabelIds.size) await cleanupUnusedLabels(req.user.id, Array.from(state.createdLabelIds));
        afterDatabaseCommit(() => syncSmartReminderIntegrations(req.user.id, state.remindersToSync));
      });
    } catch (error) {
      transactionError = error;
    }
    if (transactionError) {
      const error = transactionError;
      await insertAiActionHistory(req.user.id, transcript, actionPlan, { executed, failed }, 'failed');
      return res.status(400).json({
        ok: false,
        executed: [],
        failed: failed.length ? failed : [{ error: error.message || 'Execution failed.' }],
        createdNoteIds: [],
        updatedNoteIds: [],
        createdLabelIds: [],
        reminderIds: []
      });
    }

    const status = failed.length ? 'partial' : 'success';
    const response = {
      ok: failed.length === 0,
      executed,
      failed,
      createdNoteIds: state.createdNoteIds,
      updatedNoteIds: Array.from(state.updatedNoteIds),
      createdLabelIds: Array.from(state.createdLabelIds),
      reminderIds: state.reminderIds
    };
    await insertAiActionHistory(req.user.id, transcript, actionPlan, response, status);

    res.status(failed.length ? 207 : 200).json(response);
  }));

  app.post('/api/ai/notes/:id/archive', requireAuth, asyncRoute(async (req, res) => {
    const noteId = Number(req.params.id);
    if (!noteId) return res.status(400).json({ error: 'noteId is required.' });
    try {
      const status = await setOwnedNoteLifecycleState(req.user.id, noteId, { archived: true, trashed: false });
      await broadcastNoteChange(noteId, 'updated');
      res.json({ ok: true, ...status });
    } catch (error) {
      if (/not owned by you/i.test(error.message || '')) return res.status(404).json({ error: 'Note not found.' });
      throw error;
    }
  }));

  app.post('/api/ai/notes/:id/trash', requireAuth, asyncRoute(async (req, res) => {
    const noteId = Number(req.params.id);
    if (!noteId) return res.status(400).json({ error: 'noteId is required.' });
    try {
      const status = await setOwnedNoteLifecycleState(req.user.id, noteId, { archived: false, trashed: true });
      await broadcastNoteChange(noteId, 'updated');
      res.json({ ok: true, ...status });
    } catch (error) {
      if (/not owned by you/i.test(error.message || '')) return res.status(404).json({ error: 'Note not found.' });
      throw error;
    }
  }));
}

module.exports = {
  mountAiRoutes
};
