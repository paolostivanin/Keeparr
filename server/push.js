// Web Push: sending a reminder to a user's subscribed browsers and the routes that manage the subscriptions.
const webPush = require('web-push');
const { run, all } = require('./db');
const { vapidKeys } = require('./config');
const { asyncRoute, requireAuth } = require('./auth');
const { plainText } = require('./note-text');

function buildReminderPushPayload(reminder) {
  return JSON.stringify({
    type: 'reminder-fired',
    reminderId: reminder.id,
    noteId: reminder.noteId,
    title: plainText(reminder.title) || 'Reminder',
    body: plainText(reminder.body),
    imageUrl: reminder.imageUrl || null,
    icon: '/assets/images/keeparr-icon-192.png',
    deepLink: reminder.deepLink || (reminder.noteId ? `keeparr://note/${reminder.noteId}` : null),
    url: '/'
  });
}

async function sendReminderPush(reminder) {
  const subscriptions = await all(
    'SELECT id, subscription FROM push_subscriptions WHERE userId = ?',
    [reminder.userId]
  );
  const payload = buildReminderPushPayload(reminder);

  await Promise.all(subscriptions.map(async row => {
    try {
      await webPush.sendNotification(JSON.parse(row.subscription), payload);
    } catch (error) {
      const sub = JSON.parse(row.subscription);
      const endpoint = sub.endpoint || '';
      const isApple = endpoint.includes('web.push.apple.com');
      if (error.statusCode === 404 || error.statusCode === 410) {
        await run('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
        console.warn(`Web Push: ${isApple ? '[Apple]' : ''} subscription gone (${error.statusCode}), removed.`);
      } else {
        console.error(
          `Web Push failed${isApple ? ' [Apple/iOS]' : ''}:`,
          'status=', error.statusCode,
          'body=', error.body,
          'msg=', error.message
        );
      }
    }
  }));
}

function mountPushRoutes(app) {
  app.get('/api/push/vapid-public-key', requireAuth, (_req, res) => {
    res.json({ publicKey: vapidKeys.publicKey });
  });

  app.post('/api/push/subscriptions', requireAuth, asyncRoute(async (req, res) => {
    const subscription = req.body.subscription;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return res.status(400).json({ error: 'A valid push subscription is required.' });
    }

    const now = new Date().toISOString();
    await run(
      `INSERT INTO push_subscriptions (userId, endpoint, subscription, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET userId = excluded.userId, subscription = excluded.subscription, updatedAt = excluded.updatedAt`,
      [req.user.id, subscription.endpoint, JSON.stringify(subscription), now, now]
    );
    res.status(201).json({ ok: true });
  }));

  app.delete('/api/push/subscriptions', requireAuth, asyncRoute(async (req, res) => {
    const endpoint = String(req.body.endpoint || '');
    if (endpoint) {
      await run('DELETE FROM push_subscriptions WHERE userId = ? AND endpoint = ?', [req.user.id, endpoint]);
    }
    res.status(204).end();
  }));
}

module.exports = { sendReminderPush, mountPushRoutes };
