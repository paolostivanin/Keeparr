// Label routes.
const { all, get, run } = require('../db');
const { asyncRoute, requireAuth } = require('../auth');
const { broadcastRealtime } = require('../realtime');
const { findOrCreateLabelForUser, updateNoteLabelReferencesForUser } = require('../labels');

function mountLabelRoutes(app) {
  app.get('/api/labels', requireAuth, asyncRoute(async (req, res) => {
    res.json(await all('SELECT id, name FROM labels WHERE userId = ? ORDER BY name COLLATE NOCASE, id', [req.user.id]));
  }));

  app.post('/api/labels/find-or-create', requireAuth, asyncRoute(async (req, res) => {
    const label = await findOrCreateLabelForUser(req.user.id, req.body.name);
    res.status(200).json(label);
  }));

  app.post('/api/labels', requireAuth, asyncRoute(async (req, res) => {
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Label name is required.' });
    const result = await run('INSERT INTO labels (name, userId) VALUES (?, ?)', [name, req.user.id]);
    res.status(201).json({ id: result.id, name });
  }));

  app.patch('/api/labels/:id', requireAuth, asyncRoute(async (req, res) => {
    const labelId = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Label name is required.' });
    const label = await get('SELECT id, name FROM labels WHERE id = ? AND userId = ?', [labelId, req.user.id]);
    if (!label) return res.status(404).json({ error: 'Label not found.' });
    const duplicate = await get(
      'SELECT id FROM labels WHERE userId = ? AND lower(name) = lower(?) AND id <> ?',
      [req.user.id, name, labelId]
    );
    if (duplicate) return res.status(409).json({ error: 'Label already exists.' });
    await run('UPDATE labels SET name = ? WHERE id = ? AND userId = ?', [name, labelId, req.user.id]);
    const { recipientIds } = await updateNoteLabelReferencesForUser(req.user.id, labelId, name, { oldName: label.name });
    broadcastRealtime([...recipientIds], { type: 'notes-changed', action: 'labels-updated' });
    res.json({ id: labelId, name });
  }));

  app.delete('/api/labels/:id', requireAuth, asyncRoute(async (req, res) => {
    const labelId = Number(req.params.id);
    const label = await get('SELECT id, name FROM labels WHERE id = ? AND userId = ?', [labelId, req.user.id]);
    if (!label) return res.status(404).json({ error: 'Label not found.' });
    await run('DELETE FROM labels WHERE id = ? AND userId = ?', [labelId, req.user.id]);
    const { recipientIds } = await updateNoteLabelReferencesForUser(req.user.id, labelId, '', { oldName: label.name });
    broadcastRealtime([...recipientIds], { type: 'notes-changed', action: 'labels-updated' });
    res.status(204).end();
  }));
}

module.exports = {
  mountLabelRoutes
};
