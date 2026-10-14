// Fires due reminders every 15 seconds: advances or completes them, tells the user's open clients and sends the push.
// The reminder helpers stay with the reminder routes and are passed in.
const { get, all, withDatabaseTransaction } = require('./db');
const { nextRepeatDueAt } = require('./reminder-recurrence');
const { parseRepeatRule } = require('./reminder-model');
const { serverLwwStamp } = require('./sync-protocol');
const { broadcastRealtime } = require('./realtime');
const { sendReminderPush } = require('./push');

function createReminderScheduler({
  visibleReminderJoin, visibleReminderWhere, enrichReminderResponses, reminderIsVisibleToUser, persistReminderOccurrence,
  floatReminderNoteToTop, recordReminderSyncChange
}) {
  async function processDueReminders(nowDate = new Date()) {
      try {
        const now = nowDate.toISOString();
        const due = await all(
          `SELECT reminders.* FROM reminders
         ${visibleReminderJoin}
         WHERE reminders.status = 'pending'
         AND reminders.dueAtUtc <= ?
         AND ${visibleReminderWhere}`,
          [now]
        );
        const enrichedDue = await enrichReminderResponses(due);
        let processed = 0;
        for (const reminder of enrichedDue) {
          if (!(await reminderIsVisibleToUser(reminder, reminder.userId))) continue;
          const repeat = parseRepeatRule(reminder.repeatRule);
          const nextDueAtUtc = repeat ? nextRepeatDueAt(reminder.dueAtUtc, repeat, reminder.timezone, nowDate.getTime(), reminder.scheduleAnchorAtUtc || reminder.dueAtUtc) : null;
          const stamp = serverLwwStamp();
          const updatedReminder = await withDatabaseTransaction(async () => {
            const updated = await get(
              `UPDATE reminders SET
               status = ?, dueAtUtc = ?, updatedAt = ?,
               lwwPhysicalMs = ?, lwwLogical = ?, lwwDeviceId = ?, lwwOperationId = ?
             WHERE id = ? AND userId = ? AND status = 'pending' AND dueAtUtc = ? AND scheduleVersion = ?
             RETURNING *`,
              [repeat && nextDueAtUtc ? 'pending' : 'fired', repeat && nextDueAtUtc ? nextDueAtUtc : reminder.dueAtUtc,
                now, stamp.physicalMs, stamp.logical, stamp.deviceId, stamp.operationId, reminder.id, reminder.userId,
                reminder.dueAtUtc, Number(reminder.scheduleVersion || 1)]
            );
            if (!updated) return null;
            await persistReminderOccurrence(reminder);
            if (repeat?.moveToTopOnTrigger) await floatReminderNoteToTop(reminder.userId, reminder.noteId);
            await recordReminderSyncChange(updated, 'upsert');
            return updated;
          });
          if (!updatedReminder) continue;
          processed += 1;
          if (!(await reminderIsVisibleToUser(updatedReminder, reminder.userId))) continue;
          broadcastRealtime([reminder.userId], {
            type: 'reminder-fired',
            reminderId: reminder.id,
            noteId: reminder.noteId,
            title: reminder.title,
            body: reminder.body,
            imageUrl: reminder.imageUrl
          });
          sendReminderPush(reminder).catch(err => console.error('Reminder push failed:', err.message));
        }
        return { dueCount: processed };
      } catch (err) {
        console.error('Reminder scheduler error:', err.message);
        throw err;
      }
  }

  function startReminderScheduler() {
    setInterval(() => { processDueReminders().catch(() => {}); }, 15_000);
  }

  return { processDueReminders, startReminderScheduler };
}

module.exports = { createReminderScheduler };
