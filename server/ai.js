// Smart actions: planning, validating and executing the actions an assistant proposes.
const { enrichReminderResponses } = require('./sync-changes');
const { escapeHtml, parseJson, plainText } = require('./note-text');
const { findLabelForUser, findOrCreateLabelForUser } = require('./labels');
const {
  firstDefined, normalizeLocationTrigger, normalizeRepeatRule, reminderScheduleDefinitionChanged
} = require('./reminder-model');
const { gcalPushReminder } = require('./google-calendar');
const { get, run } = require('./db');
const { getAccessibleNote, getNoteRecipientIds, getOwnedNote, nextTrashedAt } = require('./note-data');
const { pushReminderToCaldav } = require('./calendar');
const { syncNoteImagesForNote } = require('./files');

const SMART_ACTION_TYPES = new Set([
  'create_text_note',
  'create_todo_note',
  'append_to_note',
  'add_checklist_items',
  'add_labels',
  'set_reminder',
  'share_note',
  'archive_note',
  'trash_note'
]);

const NOTE_TARGET_ACTION_TYPES = new Set([
  'append_to_note',
  'add_checklist_items',
  'add_labels',
  'share_note',
  'archive_note',
  'trash_note'
]);

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function actionNoteId(action) {
  return Number(action.noteId || action.targetNoteId || action.targetId || 0);
}

function resolveActionNoteId(action, state) {
  return action.noteId || state.lastCreatedNoteId || null;
}

function actionText(action) {
  return String(action.text ?? action.body ?? action.content ?? action.noteBody ?? '').trim();
}

function actionTitle(action) {
  return String(action.title ?? action.noteTitle ?? '').trim();
}

function actionChecklistItems(action) {
  return asArray(action.items ?? action.checklistItems ?? action.todos).map(item => {
    if (typeof item === 'string') return item.trim();
    return String(item?.data ?? item?.text ?? item?.title ?? '').trim();
  }).filter(Boolean);
}

function actionLabelNames(action) {
  return asArray(action.labels ?? action.labelNames ?? action.names).map(label => {
    if (typeof label === 'string') return label.trim();
    return String(label?.name ?? '').trim();
  }).filter(Boolean);
}

function actionUserIds(action) {
  return asArray(action.userIds ?? action.users ?? action.collaboratorUserIds ?? action.shareWithUserIds)
    .map(user => Number(typeof user === 'object' ? user?.id : user))
    .filter(Boolean);
}

function normalizeAction(action) {
  let type = String(action?.type || '').trim();
  if (['archive', 'archiveNote'].includes(type)) type = 'archive_note';
  if (['trash', 'trashNote'].includes(type)) type = 'trash_note';
  const normalized = { ...action, type };
  if (actionNoteId(action)) normalized.noteId = actionNoteId(action);
  const title = actionTitle(action);
  if (title) normalized.title = title;
  const text = actionText(action);
  if (text) normalized.text = text;
  const checklistItems = actionChecklistItems(action);
  if (checklistItems.length) normalized.items = checklistItems;
  const labelNames = actionLabelNames(action);
  if (labelNames.length) normalized.labels = labelNames;
  const userIds = actionUserIds(action);
  if (userIds.length) normalized.userIds = userIds;
  if (action.dueAtUtc || action.dueAt || action.datetime || action.dateTime) {
    normalized.dueAtUtc = String(action.dueAtUtc || action.dueAt || action.datetime || action.dateTime);
  }
  const location = action.location && typeof action.location === 'object' ? action.location : {};
  const locationName = firstDefined(action.locationName, action.location_name, action.triggerLocationName, location.displayName, location.name, location.address);
  const latitude = firstDefined(action.latitude, action.lat, location.latitude, location.lat);
  const longitude = firstDefined(action.longitude, action.lng, action.lon, location.longitude, location.lng, location.lon);
  const radiusMeters = firstDefined(action.radiusMeters, action.radius_meters, action.radius, location.radiusMeters, location.radius_meters, location.radius);
  const locationTrigger = firstDefined(action.locationTrigger, action.location_trigger, action.triggerType, location.locationTrigger, location.triggerType);
  if (locationName) normalized.locationName = String(locationName);
  if (latitude != null) normalized.latitude = Number(latitude);
  if (longitude != null) normalized.longitude = Number(longitude);
  if (radiusMeters != null) normalized.radiusMeters = Number(radiusMeters);
  if (locationTrigger) normalized.locationTrigger = normalizeLocationTrigger(locationTrigger);
  if (action.timezone) normalized.timezone = String(action.timezone);
  if (action.repeatRule) normalized.repeatRule = String(action.repeatRule);
  if (action.createMissingLabels !== undefined) normalized.createMissingLabels = !!action.createMissingLabels;
  return normalized;
}

function isLocationReminderAction(action) {
  return action?.latitude != null
    && action?.longitude != null
    && action?.locationName
    && action?.locationTrigger;
}

function reminderNoteTextFromTranscript(transcript) {
  return String(transcript || '')
    .replace(/\b(can you|please|could you)\b/gi, ' ')
    .replace(/\b(remind me|reminder|set a reminder|create a reminder)\b/gi, ' ')
    .replace(/\b(today|tomorrow|tonight|this evening|this morning|this afternoon)\b/gi, ' ')
    .replace(/\b(at|by|around)\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*to\s+/i, '')
    .trim();
}

function fallbackReminderNoteText(action, transcript) {
  return action.text || action.title || reminderNoteTextFromTranscript(transcript) || String(transcript || '').trim() || 'Reminder';
}

function normalizeActionPlan(actionPlan, transcript = '') {
  const input = actionPlan && typeof actionPlan === 'object' ? actionPlan : {};
  const rawActions = Array.isArray(input.actions) ? input.actions.map(normalizeAction) : [];
  const actions = [];
  let createdNoteAvailable = false;
  for (const action of rawActions) {
    if (action.type === 'set_reminder' && !action.noteId && !createdNoteAvailable) {
      const noteText = fallbackReminderNoteText(action, transcript);
      actions.push({
        type: 'create_text_note',
        title: action.title || noteText,
        text: action.text || noteText
      });
      createdNoteAvailable = true;
    }
    actions.push(action);
    if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
      createdNoteAvailable = true;
    }
  }
  const confidence = ['low', 'medium', 'high'].includes(input.confidence) ? input.confidence : 'medium';
  return {
    summary: String(input.summary || '').trim(),
    confidence,
    requiresConfirmation: !!input.requiresConfirmation,
    actions,
    unresolvedQuestions: asArray(input.unresolvedQuestions).map(String).filter(Boolean)
  };
}

function actionRequiresCreatedNote(action) {
  return !action.noteId && (
    NOTE_TARGET_ACTION_TYPES.has(action.type) ||
    action.type === 'set_reminder'
  );
}

function selectedActionsWithDependencies(actions, selected) {
  if (!selected) return actions;
  const expanded = new Set(selected);
  let latestCreateIndex = null;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index];
    if (expanded.has(index) && actionRequiresCreatedNote(action) && latestCreateIndex !== null) {
      expanded.add(latestCreateIndex);
    }
    if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
      latestCreateIndex = index;
    }
  }
  return actions.filter((_action, index) => expanded.has(index));
}

async function validateKeeparrActionPlan(userId, transcript, actionPlan) {
  const normalizedPlan = normalizeActionPlan(actionPlan, transcript);
  const errors = [];
  const warnings = [];
  const noteCache = new Map();
  let risky = normalizedPlan.requiresConfirmation || normalizedPlan.confidence === 'low' || normalizedPlan.actions.length > 1;

  if (!String(transcript || '').trim()) warnings.push('Transcript is empty.');
  if (!normalizedPlan.summary) warnings.push('Plan summary is empty.');
  if (!Array.isArray(actionPlan?.actions)) errors.push('actions must be an array.');
  if (!normalizedPlan.actions.length) errors.push('At least one action is required.');

  let createdNoteAvailable = false;
  for (let index = 0; index < normalizedPlan.actions.length; index += 1) {
    const action = normalizedPlan.actions[index];
    const label = `actions[${index}]`;
    if (!SMART_ACTION_TYPES.has(action.type)) {
      errors.push(`${label}.type is not supported.`);
      continue;
    }

    if (NOTE_TARGET_ACTION_TYPES.has(action.type) && !action.noteId && !createdNoteAvailable) {
      errors.push(`${label}.noteId is required unless a previous action creates a note.`);
    }
    if (action.type === 'set_reminder' && !action.noteId && !createdNoteAvailable) {
      errors.push(`${label}.noteId is required unless a previous action creates a note.`);
    }
    if (['append_to_note'].includes(action.type) && !action.text) errors.push(`${label}.text is required.`);
    if (action.type === 'create_text_note' && !action.title && !action.text) errors.push(`${label}.title or text is required.`);
    if (action.type === 'create_todo_note' && !action.items?.length) errors.push(`${label}.items are required.`);
    if (action.type === 'add_checklist_items' && !action.items?.length) errors.push(`${label}.items are required.`);
    if (action.type === 'add_labels' && !action.labels?.length) errors.push(`${label}.labels are required.`);
    if (action.type === 'set_reminder' && !action.dueAtUtc && !isLocationReminderAction(action)) {
      risky = true;
      warnings.push(`${label}.dueAtUtc is missing; ask for a reminder time before executing.`);
      if (!normalizedPlan.unresolvedQuestions.includes('When should Keeparr remind you?')) {
        normalizedPlan.unresolvedQuestions.push('When should Keeparr remind you?');
      }
    }
    if (action.type === 'share_note') {
      risky = true;
      if (!action.userIds?.length) errors.push(`${label}.userIds are required.`);
    }

    if (action.noteId && !noteCache.has(action.noteId)) {
      noteCache.set(action.noteId, await getAccessibleNote(action.noteId, userId));
    }
    let note = action.noteId ? noteCache.get(action.noteId) : null;
    if (action.type === 'share_note' && action.noteId && createdNoteAvailable && (!note || note.ownerUserId !== userId)) {
      warnings.push(`${label}.noteId was ignored because a previous action creates the note to share.`);
      delete action.noteId;
      note = null;
    }
    if (action.noteId && !note) errors.push(`${label}.noteId is not accessible.`);
    if (action.type === 'share_note' && note && note.ownerUserId !== userId) {
      errors.push(`${label}.noteId must be owned by you to share it.`);
    }
    if ((action.type === 'archive_note' || action.type === 'trash_note') && note && note.ownerUserId !== userId) {
      errors.push(`${label}.noteId must be owned by you to ${action.type === 'archive_note' ? 'archive' : 'trash'} it.`);
    }

    if (action.type === 'share_note') {
      for (const userIdTarget of action.userIds || []) {
        const user = await get('SELECT id FROM users WHERE id = ? AND enabled = 1', [userIdTarget]);
        if (!user) errors.push(`${label}.userIds contains an unknown user: ${userIdTarget}.`);
        if (userIdTarget === userId) warnings.push(`${label}.userIds includes the current user; it will be ignored.`);
      }
    }

    if (action.type === 'add_labels' && !action.createMissingLabels) {
      for (const labelName of action.labels || []) {
        const existingLabel = await findLabelForUser(userId, labelName);
        if (!existingLabel) errors.push(`${label}.labels contains an unknown label: ${labelName}.`);
      }
    }

    if (action.type === 'set_reminder' && action.dueAtUtc) {
      const due = new Date(action.dueAtUtc);
      if (Number.isNaN(due.getTime())) errors.push(`${label}.dueAtUtc must be a valid date.`);
      else action.dueAtUtc = due.toISOString();
    }
    if (action.type === 'set_reminder' && isLocationReminderAction(action)) {
      if (!Number.isFinite(Number(action.latitude))) errors.push(`${label}.latitude must be a valid number.`);
      if (!Number.isFinite(Number(action.longitude))) errors.push(`${label}.longitude must be a valid number.`);
      action.latitude = Number(action.latitude);
      action.longitude = Number(action.longitude);
      action.locationTrigger = action.locationTrigger === 'leave' ? 'leave' : 'arrive';
      if (action.radiusMeters != null) action.radiusMeters = Number(action.radiusMeters);
      if (action.radiusMeters != null && (!Number.isFinite(action.radiusMeters) || action.radiusMeters <= 0)) {
        errors.push(`${label}.radiusMeters must be a positive number.`);
      }
    }

    if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
      createdNoteAvailable = true;
    }
  }

  normalizedPlan.requiresConfirmation = risky;
  return {
    valid: errors.length === 0,
    ok: errors.length === 0,
    errors,
    warnings,
    normalizedPlan,
    requiresConfirmation: normalizedPlan.requiresConfirmation
  };
}

async function insertAiActionHistory(userId, transcript, proposedPlan, executedPlan, status) {
  await run(
    `INSERT INTO ai_action_history (userId, transcript, proposedPlanJson, executedPlanJson, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId,
      String(transcript || ''),
      JSON.stringify(proposedPlan || null),
      executedPlan ? JSON.stringify(executedPlan) : null,
      status,
      new Date().toISOString()
    ]
  );
}

async function smartCreateNote(userId, action, options = {}) {
  const now = new Date().toISOString();
  const isTodo = action.type === 'create_todo_note';
  const labels = [];
  for (const name of action.labels || []) {
    const label = await findOrCreateLabelForUser(userId, name);
    labels.push({ id: label.id, name: label.name, added: true });
    if (label.created) options.createdLabelIds?.add(label.id);
  }
  const checkBoxes = isTodo
    ? (action.items || []).map((item, index) => ({ id: Date.now() + index, data: escapeHtml(item), done: false }))
    : [];
  const result = await run(
    `INSERT INTO notes
	     (ownerUserId, noteTitle, noteBody, bgColor, bgImage, checkBoxes, images, isCbox, labels, binder, archived, trashed, trashedAt, sortOrder, createdAt, updatedAt, lastEditorUserId, isDemo)
	     VALUES (?, ?, ?, ?, '', ?, '[]', ?, ?, '', 0, 0, NULL, ?, ?, ?, ?, 0)`,
	    [
	      userId,
          escapeHtml(action.title || ''),
          escapeHtml(action.text || ''),
	      String(action.bgColor || ''),
	      JSON.stringify(checkBoxes),
      isTodo ? 1 : 0,
      JSON.stringify(labels),
      Date.now(),
      now,
      now,
      userId
    ]
  );
  return result.id;
}

async function smartAppendToNote(userId, noteId, text) {
  const note = await getAccessibleNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  const separator = note.noteBody && String(note.noteBody).trim() ? '<br>' : '';
  const nextBody = `${note.noteBody || ''}${separator}${escapeHtml(text)}`;
  await run('UPDATE notes SET noteBody = ?, updatedAt = ?, lastEditorUserId = ? WHERE id = ?', [
    nextBody,
    new Date().toISOString(),
    userId,
    noteId
  ]);
  await syncNoteImagesForNote(noteId, note.ownerUserId, { noteBody: nextBody, images: parseJson(note.images || '[]', []) });
}

async function smartAddChecklistItems(userId, noteId, items) {
  const note = await getAccessibleNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  const current = parseJson(note.checkBoxes || '[]', []);
  const base = Date.now();
  const next = [
    ...current,
    ...items.map((item, index) => ({ id: base + index, data: escapeHtml(item), done: false }))
  ];
  await run('UPDATE notes SET checkBoxes = ?, isCbox = 1, updatedAt = ?, lastEditorUserId = ? WHERE id = ?', [
    JSON.stringify(next),
    new Date().toISOString(),
    userId,
    noteId
  ]);
}

async function smartAddLabels(userId, noteId, labelNames, createdLabelIds, createMissingLabels = false) {
  const note = await getAccessibleNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  if (note.ownerUserId !== userId) throw new Error(`Only the note owner can change labels for note ${noteId}.`);
  const labels = parseJson(note.labels || '[]', []);
  const byName = new Map(labels.map(label => [String(label.name || '').toLowerCase(), label]));
  for (const name of labelNames) {
    const label = createMissingLabels
      ? await findOrCreateLabelForUser(userId, name)
      : await findLabelForUser(userId, name);
    if (!label) throw new Error(`Label does not exist: ${name}`);
    if (createMissingLabels && label.created) createdLabelIds.add(label.id);
    const key = label.name.toLowerCase();
    if (!byName.has(key)) {
      const entry = { id: label.id, name: label.name, added: true };
      labels.push(entry);
      byName.set(key, entry);
    }
  }
  await run('UPDATE notes SET labels = ?, updatedAt = ?, lastEditorUserId = ? WHERE id = ?', [
    JSON.stringify(labels),
    new Date().toISOString(),
    userId,
    noteId
  ]);
}

async function smartSetReminder(userId, action, fallbackNoteId) {
  const noteId = action.noteId || fallbackNoteId || null;
  if (noteId) {
    const note = await getAccessibleNote(Number(noteId), userId);
    if (!note) throw new Error(`Note ${noteId} is not accessible.`);
  }
  const now = new Date().toISOString();
  const dueAtUtc = action.dueAtUtc ? new Date(action.dueAtUtc).toISOString() : null;
  const locationName = action.locationName ? String(action.locationName) : null;
  const latitude = action.latitude != null ? Number(action.latitude) : null;
  const longitude = action.longitude != null ? Number(action.longitude) : null;
  const radiusMeters = action.radiusMeters != null ? Number(action.radiusMeters) : (locationName ? 120 : null);
  const locationTrigger = action.locationTrigger === 'leave' ? 'leave' : 'arrive';
  const existing = noteId ? await get('SELECT * FROM reminders WHERE noteId = ? AND userId = ?', [noteId, userId]) : null;
  const timezone = action.timezone || 'UTC';
  const repeatRule = normalizeRepeatRule(action.repeatRule);
  const nextSchedule = { dueAtUtc, timezone, repeatRule };
  const scheduleChanged = existing ? reminderScheduleDefinitionChanged(existing, nextSchedule) : false;
  const scheduleVersion = existing ? Number(existing.scheduleVersion || 1) + (scheduleChanged ? 1 : 0) : 1;
  const scheduleAnchorAtUtc = scheduleChanged ? dueAtUtc : (existing?.scheduleAnchorAtUtc || existing?.dueAtUtc || dueAtUtc);
  const reminder = await get(
    `INSERT INTO reminders
       (noteId, userId, dueAtUtc, timezone, repeatRule, status, title, body, imageUrl, locationName, latitude, longitude, radiusMeters, locationTrigger, scheduleVersion, scheduleAnchorAtUtc, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(userId, noteId) DO UPDATE SET
       userId = excluded.userId,
       dueAtUtc = excluded.dueAtUtc,
       timezone = excluded.timezone,
       repeatRule = excluded.repeatRule,
       status = 'pending',
       title = excluded.title,
       body = excluded.body,
       imageUrl = excluded.imageUrl,
       locationName = excluded.locationName,
       latitude = excluded.latitude,
       longitude = excluded.longitude,
       radiusMeters = excluded.radiusMeters,
       locationTrigger = excluded.locationTrigger,
       scheduleAnchorAtUtc = CASE
         WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
         THEN excluded.scheduleAnchorAtUtc ELSE COALESCE(reminders.scheduleAnchorAtUtc, reminders.dueAtUtc) END,
       scheduleVersion = reminders.scheduleVersion + CASE
         WHEN reminders.dueAtUtc IS NOT excluded.dueAtUtc OR reminders.timezone IS NOT excluded.timezone OR reminders.repeatRule IS NOT excluded.repeatRule
         THEN 1 ELSE 0 END,
       updatedAt = excluded.updatedAt
     RETURNING *`,
    [
      noteId || null,
      userId,
      dueAtUtc,
      timezone,
      repeatRule,
      plainText(action.title) || null,
      plainText(action.text) || null,
      String(action.imageUrl || '') || null,
      locationName,
      latitude,
      longitude,
      radiusMeters,
      locationTrigger,
      scheduleVersion,
      scheduleAnchorAtUtc,
      now,
      now
    ]
  );
  return reminder || await get('SELECT * FROM reminders WHERE id = ?', [existing?.id]);
}

async function smartShareNote(userId, noteId, userIds) {
  const note = await getOwnedNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not owned by you.`);
  const previousRecipients = await getNoteRecipientIds(noteId);
  for (const targetUserId of new Set(userIds.filter(id => id !== userId))) {
    const exists = await get('SELECT id FROM users WHERE id = ? AND enabled = 1', [targetUserId]);
    if (!exists) throw new Error(`User ${targetUserId} does not exist.`);
    await run(
      'INSERT OR IGNORE INTO note_collaborators (noteId, userId, createdAt) VALUES (?, ?, ?)',
      [noteId, targetUserId, new Date().toISOString()]
    );
  }
  return previousRecipients;
}

async function setOwnedNoteLifecycleState(userId, noteId, updates) {
  const note = await getOwnedNote(noteId, userId);
  if (!note) throw new Error(`Note ${noteId} is not owned by you.`);
  const now = new Date().toISOString();
  const next = {
    archived: updates.archived === undefined ? !!note.archived : !!updates.archived,
    trashed: updates.trashed === undefined ? !!note.trashed : !!updates.trashed
  };
  const trashedAt = nextTrashedAt(note, next);
  await run(
    'UPDATE notes SET archived = ?, trashed = ?, trashedAt = ?, updatedAt = ?, lastEditorUserId = ? WHERE id = ?',
    [next.archived ? 1 : 0, next.trashed ? 1 : 0, trashedAt, now, userId, noteId]
  );
  return {
    noteId,
    archived: next.archived,
    trashed: next.trashed,
    trashedAt: trashedAt || '',
    updatedAt: now
  };
}

async function executeSmartAction(userId, action, state) {
  const result = { type: action.type, ok: true };
  if (action.type === 'create_text_note' || action.type === 'create_todo_note') {
    const noteId = await smartCreateNote(userId, action, state);
    state.createdNoteIds.push(noteId);
    state.lastCreatedNoteId = noteId;
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'append_to_note') {
    const noteId = resolveActionNoteId(action, state);
    await smartAppendToNote(userId, noteId, action.text);
    state.updatedNoteIds.add(noteId);
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'add_checklist_items') {
    const noteId = resolveActionNoteId(action, state);
    await smartAddChecklistItems(userId, noteId, action.items || []);
    state.updatedNoteIds.add(noteId);
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'add_labels') {
    const noteId = resolveActionNoteId(action, state);
    await smartAddLabels(userId, noteId, action.labels || [], state.createdLabelIds, !!action.createMissingLabels);
    state.updatedNoteIds.add(noteId);
    result.noteId = noteId;
    return result;
  }
  if (action.type === 'set_reminder') {
    const reminder = await smartSetReminder(userId, action, state.lastCreatedNoteId);
    state.reminderIds.push(reminder.id);
    state.remindersToSync.push(reminder);
    if (reminder.noteId) state.updatedNoteIds.add(reminder.noteId);
    result.reminderId = reminder.id;
    result.noteId = reminder.noteId || null;
    return result;
  }
  if (action.type === 'share_note') {
    const noteId = resolveActionNoteId(action, state);
    const previousRecipients = await smartShareNote(userId, noteId, action.userIds || []);
    state.updatedNoteIds.add(noteId);
    state.shareBroadcasts.push({ noteId, previousRecipients });
    result.noteId = noteId;
    result.userIds = (action.userIds || []).filter(id => id !== userId);
    return result;
  }
  if (action.type === 'archive_note') {
    const noteId = resolveActionNoteId(action, state);
    const status = await setOwnedNoteLifecycleState(userId, noteId, { archived: true, trashed: false });
    state.updatedNoteIds.add(noteId);
    return { ...result, ...status };
  }
  if (action.type === 'trash_note') {
    const noteId = resolveActionNoteId(action, state);
    const status = await setOwnedNoteLifecycleState(userId, noteId, { archived: false, trashed: true });
    state.updatedNoteIds.add(noteId);
    return { ...result, ...status };
  }
  throw new Error(`Unsupported action type: ${action.type}`);
}

async function syncSmartReminderIntegrations(userId, reminders) {
  if (!reminders.length) return;
  const enrichedReminders = await enrichReminderResponses(reminders);
  const caldav = await get('SELECT * FROM caldav_settings WHERE userId = ? AND enabled = 1', [userId]);
  for (const reminder of enrichedReminders) {
    if (caldav) pushReminderToCaldav(caldav, reminder).catch(err => console.error('CalDAV push failed:', err.message));
    gcalPushReminder(userId, reminder).catch(err => console.error('GCal push failed:', err.message));
  }
}

module.exports = {
  executeSmartAction, insertAiActionHistory, selectedActionsWithDependencies, setOwnedNoteLifecycleState, syncSmartReminderIntegrations, validateKeeparrActionPlan
};
