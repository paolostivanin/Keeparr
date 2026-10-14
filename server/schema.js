// Table creation and migrations. initSchema runs at startup and again after a backup restore; every step must be safe
// to repeat. The two helpers that touch note and token code are injected so this file stays free of server logic.
const crypto = require('crypto');
const { run, get, all } = require('./db');
const { getAppSetting, setAppSetting } = require('./app-settings');
const { initNativeClientSchema } = require('./native-client');
const { initOAuthTables } = require('./oauth-mcp');

async function initSchema({ hashToken, backfillImportedNoteLabels }) {
  await run('PRAGMA journal_mode = WAL');
  await run('PRAGMA foreign_keys = ON');
  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      displayName TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'user')),
      passwordHash TEXT NOT NULL,
      passwordSalt TEXT NOT NULL,
      theme TEXT NOT NULL DEFAULT 'light',
      avatarDataUrl TEXT,
      avatarPreset TEXT NOT NULL DEFAULT 'cat',
      showPastReminders INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL
    )
  `);
  const userColumns = await all('PRAGMA table_info(users)');
  if (!userColumns.some(column => column.name === 'theme')) {
    await run(`ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'`);
  }
  if (!userColumns.some(column => column.name === 'avatarDataUrl')) {
    await run(`ALTER TABLE users ADD COLUMN avatarDataUrl TEXT`);
  }
  if (!userColumns.some(column => column.name === 'avatarPreset')) {
    await run(`ALTER TABLE users ADD COLUMN avatarPreset TEXT NOT NULL DEFAULT 'cat'`);
  }
  if (!userColumns.some(column => column.name === 'icsFeedToken')) {
    await run(`ALTER TABLE users ADD COLUMN icsFeedToken TEXT`);
  }
  if (!userColumns.some(column => column.name === 'totpSecret')) {
    await run(`ALTER TABLE users ADD COLUMN totpSecret TEXT`);
  }
  if (!userColumns.some(column => column.name === 'totpEnabled')) {
    await run(`ALTER TABLE users ADD COLUMN totpEnabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userColumns.some(column => column.name === 'totpBackupCodes')) {
    await run(`ALTER TABLE users ADD COLUMN totpBackupCodes TEXT`);
  }
  if (!userColumns.some(column => column.name === 'email')) {
    await run(`ALTER TABLE users ADD COLUMN email TEXT`);
  }
  if (!userColumns.some(column => column.name === 'enabled')) {
    await run(`ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`);
  }
  if (!userColumns.some(column => column.name === 'demoNotesCreatedAt')) {
    await run(`ALTER TABLE users ADD COLUMN demoNotesCreatedAt TEXT`);
  }
  if (!userColumns.some(column => column.name === 'showPastReminders')) {
    await run(`ALTER TABLE users ADD COLUMN showPastReminders INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userColumns.some(column => column.name === 'mcpEnabled')) {
    await run(`ALTER TABLE users ADD COLUMN mcpEnabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userColumns.some(column => column.name === 'oauthEnabled')) {
    await run(`ALTER TABLE users ADD COLUMN oauthEnabled INTEGER NOT NULL DEFAULT 0`);
    await run(`UPDATE users SET oauthEnabled = mcpEnabled`);
  }
  if (!userColumns.some(column => column.name === 'mcpAllowLockedNotes')) {
    await run(`ALTER TABLE users ADD COLUMN mcpAllowLockedNotes INTEGER NOT NULL DEFAULT 0`);
  }
  if (!userColumns.some(column => column.name === 'mcpAllowPermanentDelete')) {
    await run(`ALTER TABLE users ADD COLUMN mcpAllowPermanentDelete INTEGER NOT NULL DEFAULT 0`);
  }
  await run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      userId INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const sessionColumns = await all('PRAGMA table_info(sessions)');
  if (!sessionColumns.some(column => column.name === 'expiresAt')) {
    await run(`ALTER TABLE sessions ADD COLUMN expiresAt TEXT`);
  }
  // Tokens are stored as SHA-256 hashes, so a database or backup copy does not contain usable logins. Rows from before this
  // change are converted one by one and flagged, which keeps the conversion safe to repeat after an interruption.
  if (!sessionColumns.some(column => column.name === 'hashed')) {
    await run(`ALTER TABLE sessions ADD COLUMN hashed INTEGER NOT NULL DEFAULT 0`);
  }
  for (const legacy of await all('SELECT token FROM sessions WHERE hashed = 0')) {
    await run('UPDATE sessions SET token = ?, hashed = 1 WHERE token = ? AND hashed = 0', [hashToken(legacy.token), legacy.token]);
  }
  // Purge expired sessions on startup
  await run('DELETE FROM sessions WHERE expiresAt IS NOT NULL AND expiresAt <= ?', [new Date().toISOString()]);
  await run(`
    CREATE TABLE IF NOT EXISTS mcp_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      tokenHash TEXT NOT NULL UNIQUE,
      tokenPrefix TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      lastUsedAt TEXT,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS mcp_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      mcpTokenId INTEGER NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(mcpTokenId) REFERENCES mcp_tokens(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(userId, name)
    )
  `);
  const labelSchemaRow = await get(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'labels'`);
  const labelsUsesLegacyUnique = String(labelSchemaRow?.sql || '').includes('name TEXT NOT NULL UNIQUE');
  if (labelsUsesLegacyUnique) {
    await run('ALTER TABLE labels RENAME TO labels_legacy');
    const legacyLabelColumns = await all('PRAGMA table_info(labels_legacy)');
    const legacyHasUserId = legacyLabelColumns.some(column => column.name === 'userId');
    await run(`
      CREATE TABLE labels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId INTEGER NOT NULL,
        name TEXT NOT NULL,
        FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(userId, name)
      )
    `);
    if (legacyHasUserId) {
      await run(`
        INSERT INTO labels (id, userId, name)
        SELECT id, COALESCE(userId, (SELECT id FROM users ORDER BY role = 'admin' DESC, id LIMIT 1), 1), name
        FROM labels_legacy
      `);
    } else {
      await run(`
        INSERT INTO labels (id, userId, name)
        SELECT id, COALESCE((SELECT id FROM users ORDER BY role = 'admin' DESC, id LIMIT 1), 1), name
        FROM labels_legacy
      `);
    }
    await run('DROP TABLE labels_legacy');
  }
  await run(`
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ownerUserId INTEGER,
      noteTitle TEXT NOT NULL,
      noteBody TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      bgColor TEXT NOT NULL DEFAULT '',
      bgImage TEXT NOT NULL DEFAULT '',
      checkBoxes TEXT NOT NULL DEFAULT '[]',
      images TEXT NOT NULL DEFAULT '[]',
      isCbox INTEGER NOT NULL DEFAULT 0,
      labels TEXT NOT NULL DEFAULT '[]',
      binder TEXT NOT NULL DEFAULT '',
      extraFields TEXT NOT NULL DEFAULT '{}',
      locked INTEGER NOT NULL DEFAULT 0,
      lockSalt TEXT NOT NULL DEFAULT '',
      lockHash TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      trashed INTEGER NOT NULL DEFAULT 0,
      sortOrder REAL NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      isDemo INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(ownerUserId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  const noteColumns = await all('PRAGMA table_info(notes)');
  if (!noteColumns.some(column => column.name === 'isDemo')) {
    await run(`ALTER TABLE notes ADD COLUMN isDemo INTEGER NOT NULL DEFAULT 0`);
  }
  if (!noteColumns.some(column => column.name === 'ownerUserId')) {
    await run(`ALTER TABLE notes ADD COLUMN ownerUserId INTEGER`);
  }
  if (!noteColumns.some(column => column.name === 'trashedAt')) {
    await run(`ALTER TABLE notes ADD COLUMN trashedAt TEXT`);
  }
  if (!noteColumns.some(column => column.name === 'images')) {
    await run(`ALTER TABLE notes ADD COLUMN images TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!noteColumns.some(column => column.name === 'lastEditorUserId')) {
    await run(`ALTER TABLE notes ADD COLUMN lastEditorUserId INTEGER`);
  }
  if (!noteColumns.some(column => column.name === 'sortOrder')) {
    await run(`ALTER TABLE notes ADD COLUMN sortOrder REAL NOT NULL DEFAULT 0`);
  }
  if (!noteColumns.some(column => column.name === 'syncId')) {
    await run(`ALTER TABLE notes ADD COLUMN syncId TEXT`);
  }
  if (!noteColumns.some(column => column.name === 'lwwPhysicalMs')) {
    await run(`ALTER TABLE notes ADD COLUMN lwwPhysicalMs INTEGER NOT NULL DEFAULT 0`);
  }
  if (!noteColumns.some(column => column.name === 'lwwLogical')) {
    await run(`ALTER TABLE notes ADD COLUMN lwwLogical INTEGER NOT NULL DEFAULT 0`);
  }
  if (!noteColumns.some(column => column.name === 'lwwDeviceId')) {
    await run(`ALTER TABLE notes ADD COLUMN lwwDeviceId TEXT NOT NULL DEFAULT 'server'`);
  }
  if (!noteColumns.some(column => column.name === 'lwwOperationId')) {
    await run(`ALTER TABLE notes ADD COLUMN lwwOperationId TEXT NOT NULL DEFAULT ''`);
  }
  if (!noteColumns.some(column => column.name === 'binder')) {
    await run(`ALTER TABLE notes ADD COLUMN binder TEXT NOT NULL DEFAULT ''`);
  }
  if (!noteColumns.some(column => column.name === 'extraFields')) {
    await run(`ALTER TABLE notes ADD COLUMN extraFields TEXT NOT NULL DEFAULT '{}'`);
  }
  if (!noteColumns.some(column => column.name === 'locked')) {
    await run(`ALTER TABLE notes ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`);
  }
  if (!noteColumns.some(column => column.name === 'lockSalt')) {
    await run(`ALTER TABLE notes ADD COLUMN lockSalt TEXT NOT NULL DEFAULT ''`);
  }
  if (!noteColumns.some(column => column.name === 'lockHash')) {
    await run(`ALTER TABLE notes ADD COLUMN lockHash TEXT NOT NULL DEFAULT ''`);
  }
  await run('UPDATE notes SET sortOrder = id WHERE sortOrder = 0 OR sortOrder IS NULL');
  const notesWithoutSyncIds = await all(`SELECT id FROM notes WHERE syncId IS NULL OR syncId = ''`);
  for (const note of notesWithoutSyncIds) {
    await run(
      `UPDATE notes
       SET syncId = ?, lwwPhysicalMs = CASE WHEN lwwPhysicalMs = 0 THEN ? ELSE lwwPhysicalMs END,
           lwwOperationId = CASE WHEN lwwOperationId = '' THEN ? ELSE lwwOperationId END
       WHERE id = ?`,
      [`note-${crypto.randomUUID()}`, Date.now(), crypto.randomUUID(), note.id]
    );
  }
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS notes_sync_id_unique ON notes(syncId)`);
  await run(`
    CREATE TABLE IF NOT EXISTS mcp_unlock_challenges (
      token TEXT PRIMARY KEY,
      mcpTokenId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      noteId INTEGER NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      failedAttempts INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      FOREIGN KEY(mcpTokenId) REFERENCES mcp_tokens(id) ON DELETE CASCADE,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(noteId) REFERENCES notes(id) ON DELETE CASCADE
    )
  `);
  const mcpChallengeColumns = await all('PRAGMA table_info(mcp_unlock_challenges)');
  if (!mcpChallengeColumns.some(column => column.name === 'failedAttempts')) {
    await run(`ALTER TABLE mcp_unlock_challenges ADD COLUMN failedAttempts INTEGER NOT NULL DEFAULT 0`);
  }
  await run('DELETE FROM mcp_unlock_challenges WHERE expiresAt <= ?', [new Date().toISOString()]);
  await run(`
    CREATE TABLE IF NOT EXISTS external_unlock_challenges (
      token TEXT PRIMARY KEY,
      principalType TEXT NOT NULL CHECK(principalType IN ('mcp', 'oauth')),
      principalId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      noteId INTEGER NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      failedAttempts INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(noteId) REFERENCES notes(id) ON DELETE CASCADE
    )
  `);
  await run(`
    INSERT OR IGNORE INTO external_unlock_challenges
      (token, principalType, principalId, userId, noteId, approved, failedAttempts, createdAt, expiresAt)
    SELECT token, 'mcp', mcpTokenId, userId, noteId, approved, failedAttempts, createdAt, expiresAt
    FROM mcp_unlock_challenges
  `);
  await run('DELETE FROM external_unlock_challenges WHERE expiresAt <= ?', [new Date().toISOString()]);
  const firstUser = await get('SELECT id FROM users ORDER BY role = "admin" DESC, id LIMIT 1');
  if (firstUser) {
    await run('UPDATE notes SET ownerUserId = ? WHERE ownerUserId IS NULL', [firstUser.id]);
    await run('UPDATE labels SET userId = ? WHERE userId IS NULL', [firstUser.id]);
  }
  await run('UPDATE notes SET lastEditorUserId = ownerUserId WHERE lastEditorUserId IS NULL AND ownerUserId IS NOT NULL');
  await run('CREATE UNIQUE INDEX IF NOT EXISTS labels_user_name_unique ON labels(userId, name)');
  await run(`
    CREATE TABLE IF NOT EXISTS note_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId INTEGER REFERENCES notes(id) ON DELETE CASCADE,
      ownerUserId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      storedFilename TEXT NOT NULL,
      originalName TEXT NOT NULL,
      fileSize INTEGER NOT NULL,
      mimeType TEXT NOT NULL,
      uploadedAt TEXT NOT NULL,
      UNIQUE(noteId, storedFilename)
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS note_images_note_idx ON note_images(noteId)`);
  await run(`CREATE INDEX IF NOT EXISTS note_images_filename_idx ON note_images(storedFilename)`);
  const noteImageColumns = await all('PRAGMA table_info(note_images)');
  if (!noteImageColumns.some(column => column.name === 'uploadOperationId')) {
    await run('ALTER TABLE note_images ADD COLUMN uploadOperationId TEXT');
  }
  await run('CREATE UNIQUE INDEX IF NOT EXISTS note_images_upload_operation_unique ON note_images(ownerUserId, uploadOperationId)');
  await run(`
    CREATE TABLE IF NOT EXISTS note_collaborators (
      noteId INTEGER NOT NULL,
      userId INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      PRIMARY KEY(noteId, userId),
      FOREIGN KEY(noteId) REFERENCES notes(id) ON DELETE CASCADE,
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_pins (
      userId INTEGER NOT NULL,
      noteId INTEGER NOT NULL,
      PRIMARY KEY(userId, noteId),
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(noteId) REFERENCES notes(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_note_positions (
      userId INTEGER NOT NULL,
      noteId INTEGER NOT NULL,
      sortOrder REAL NOT NULL,
      PRIMARY KEY(userId, noteId),
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(noteId) REFERENCES notes(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS user_note_view_states (
      userId INTEGER NOT NULL,
      noteId INTEGER NOT NULL,
      completedChecklistCollapsed INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY(userId, noteId),
      FOREIGN KEY(userId) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(noteId) REFERENCES notes(id) ON DELETE CASCADE
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId INTEGER UNIQUE REFERENCES notes(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dueAtUtc TEXT,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      repeatRule TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','fired','dismissed','snoozed')),
      title TEXT,
      body TEXT,
      imageUrl TEXT,
      locationName TEXT,
      latitude REAL,
      longitude REAL,
      radiusMeters REAL DEFAULT 120,
      locationTrigger TEXT NOT NULL DEFAULT 'arrive' CHECK(locationTrigger IN ('arrive','leave')),
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  const reminderColumns = await all('PRAGMA table_info(reminders)');
  if (!reminderColumns.some(column => column.name === 'imageUrl')) {
    await run(`ALTER TABLE reminders ADD COLUMN imageUrl TEXT`);
  }
  if (!reminderColumns.some(column => column.name === 'gcalEventId')) {
    await run(`ALTER TABLE reminders ADD COLUMN gcalEventId TEXT`);
  }
  if (!reminderColumns.some(column => column.name === 'locationName')) {
    await run(`ALTER TABLE reminders ADD COLUMN locationName TEXT`);
  }
  if (!reminderColumns.some(column => column.name === 'latitude')) {
    await run(`ALTER TABLE reminders ADD COLUMN latitude REAL`);
  }
  if (!reminderColumns.some(column => column.name === 'longitude')) {
    await run(`ALTER TABLE reminders ADD COLUMN longitude REAL`);
  }
  if (!reminderColumns.some(column => column.name === 'radiusMeters')) {
    await run(`ALTER TABLE reminders ADD COLUMN radiusMeters REAL DEFAULT 120`);
  }
  if (!reminderColumns.some(column => column.name === 'locationTrigger')) {
    await run(`ALTER TABLE reminders ADD COLUMN locationTrigger TEXT NOT NULL DEFAULT 'arrive'`);
  }
  if (!reminderColumns.some(column => column.name === 'syncId')) {
    await run(`ALTER TABLE reminders ADD COLUMN syncId TEXT`);
  }
  if (!reminderColumns.some(column => column.name === 'lwwPhysicalMs')) {
    await run(`ALTER TABLE reminders ADD COLUMN lwwPhysicalMs INTEGER NOT NULL DEFAULT 0`);
  }
  if (!reminderColumns.some(column => column.name === 'lwwLogical')) {
    await run(`ALTER TABLE reminders ADD COLUMN lwwLogical INTEGER NOT NULL DEFAULT 0`);
  }
  if (!reminderColumns.some(column => column.name === 'lwwDeviceId')) {
    await run(`ALTER TABLE reminders ADD COLUMN lwwDeviceId TEXT NOT NULL DEFAULT 'server'`);
  }
  if (!reminderColumns.some(column => column.name === 'lwwOperationId')) {
    await run(`ALTER TABLE reminders ADD COLUMN lwwOperationId TEXT NOT NULL DEFAULT ''`);
  }
  const remindersWithoutSyncIds = await all(`SELECT id FROM reminders WHERE syncId IS NULL OR syncId = ''`);
  for (const reminder of remindersWithoutSyncIds) {
    await run(
      `UPDATE reminders
       SET syncId = ?, lwwPhysicalMs = CASE WHEN lwwPhysicalMs = 0 THEN ? ELSE lwwPhysicalMs END,
           lwwOperationId = CASE WHEN lwwOperationId = '' THEN ? ELSE lwwOperationId END
       WHERE id = ?`,
      [`reminder-${crypto.randomUUID()}`, Date.now(), crypto.randomUUID(), reminder.id]
    );
  }
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS reminders_sync_id_unique ON reminders(syncId)`);
  await run(`CREATE INDEX IF NOT EXISTS reminders_user_idx ON reminders(userId)`);
  await run(`CREATE INDEX IF NOT EXISTS reminders_due_idx ON reminders(dueAtUtc, status)`);
  await run(`
    CREATE TABLE IF NOT EXISTS location_saved_places (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      address TEXT,
      placeType TEXT NOT NULL DEFAULT 'other' CHECK(placeType IN ('home','work','gym','other')),
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radiusMeters REAL NOT NULL DEFAULT 100,
      locationTrigger TEXT NOT NULL DEFAULT 'arrive' CHECK(locationTrigger IN ('arrive','leave')),
      mapPreviewUrl TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS location_saved_places_user_idx ON location_saved_places(userId, updatedAt)`);
  // Performance indexes for the /api/notes query, which JOINs by note id and
  // filters by ownerUserId. Without these, listing all notes degrades to
  // O(n*m) scans once the user has hundreds of notes (visible after a takeout
  // import). Indexes are cheap to maintain.
  await run(`CREATE INDEX IF NOT EXISTS notes_owner_idx ON notes(ownerUserId, trashed)`);
  await run(`CREATE INDEX IF NOT EXISTS note_collaborators_user_idx ON note_collaborators(userId, noteId)`);
  await run(`CREATE INDEX IF NOT EXISTS note_collaborators_note_idx ON note_collaborators(noteId)`);
  await run(`
    CREATE TABLE IF NOT EXISTS note_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      noteId INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      syncId TEXT,
      originalName TEXT NOT NULL,
      storedFilename TEXT NOT NULL UNIQUE,
      fileSize INTEGER NOT NULL,
      mimeType TEXT NOT NULL,
      uploadedAt TEXT NOT NULL,
      lwwPhysicalMs INTEGER NOT NULL DEFAULT 0,
      lwwLogical INTEGER NOT NULL DEFAULT 0,
      lwwDeviceId TEXT NOT NULL DEFAULT 'server',
      lwwOperationId TEXT NOT NULL DEFAULT ''
    )
  `);
  const attachmentColumns = await all('PRAGMA table_info(note_attachments)');
  if (!attachmentColumns.some(column => column.name === 'syncId')) {
    await run(`ALTER TABLE note_attachments ADD COLUMN syncId TEXT`);
  }
  if (!attachmentColumns.some(column => column.name === 'lwwPhysicalMs')) {
    await run(`ALTER TABLE note_attachments ADD COLUMN lwwPhysicalMs INTEGER NOT NULL DEFAULT 0`);
  }
  if (!attachmentColumns.some(column => column.name === 'lwwLogical')) {
    await run(`ALTER TABLE note_attachments ADD COLUMN lwwLogical INTEGER NOT NULL DEFAULT 0`);
  }
  if (!attachmentColumns.some(column => column.name === 'lwwDeviceId')) {
    await run(`ALTER TABLE note_attachments ADD COLUMN lwwDeviceId TEXT NOT NULL DEFAULT 'server'`);
  }
  if (!attachmentColumns.some(column => column.name === 'lwwOperationId')) {
    await run(`ALTER TABLE note_attachments ADD COLUMN lwwOperationId TEXT NOT NULL DEFAULT ''`);
  }
  const attachmentsWithoutSyncIds = await all(`SELECT id FROM note_attachments WHERE syncId IS NULL OR syncId = ''`);
  for (const attachment of attachmentsWithoutSyncIds) {
    await run(
      `UPDATE note_attachments
       SET syncId = ?, lwwPhysicalMs = CASE WHEN lwwPhysicalMs = 0 THEN ? ELSE lwwPhysicalMs END,
           lwwOperationId = CASE WHEN lwwOperationId = '' THEN ? ELSE lwwOperationId END
       WHERE id = ?`,
      [`attachment-${crypto.randomUUID()}`, Date.now(), crypto.randomUUID(), attachment.id]
    );
  }
  await run(`CREATE UNIQUE INDEX IF NOT EXISTS note_attachments_sync_id_unique ON note_attachments(syncId)`);
  await run(`CREATE INDEX IF NOT EXISTS note_attachments_note_idx ON note_attachments(noteId)`);
  await run(`
    CREATE TABLE IF NOT EXISTS sync_changes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      resourceType TEXT NOT NULL CHECK(resourceType IN ('note','reminder','attachment')),
      resourceSyncId TEXT NOT NULL,
      operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
      payload TEXT,
      lwwPhysicalMs INTEGER NOT NULL,
      lwwLogical INTEGER NOT NULL DEFAULT 0,
      lwwDeviceId TEXT NOT NULL,
      lwwOperationId TEXT NOT NULL,
      changedAt TEXT NOT NULL
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS sync_changes_user_sequence_idx ON sync_changes(userId, sequence)`);
  await backfillImportedNoteLabels();
  await run(`
    CREATE TABLE IF NOT EXISTS note_collaborator_rejoin_grants (
      noteId INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      grantedAt TEXT NOT NULL,
      PRIMARY KEY (noteId, userId)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS update_dismissals (
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      dismissedAt TEXT NOT NULL,
      forever INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (userId, version)
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      subscription TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(userId)`);
  await run(`
    CREATE TABLE IF NOT EXISTS caldav_settings (
      userId INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      serverUrl TEXT NOT NULL DEFAULT '',
      calendarUrl TEXT NOT NULL,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS google_calendar_tokens (
      userId INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      clientId TEXT NOT NULL,
      clientSecret TEXT NOT NULL,
      accessToken TEXT,
      refreshToken TEXT,
      tokenExpiry TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS ai_action_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER NOT NULL,
      transcript TEXT NOT NULL,
      proposedPlanJson TEXT NOT NULL,
      executedPlanJson TEXT,
      status TEXT NOT NULL,
      createdAt TEXT NOT NULL
    )
  `);
  await initNativeClientSchema({ run, get, all });
  await initOAuthTables({ run, all });
  const originalAdminUserId = await getAppSetting('originalAdminUserId', '');
  if (!originalAdminUserId) {
    const firstUser = await get('SELECT id FROM users ORDER BY id LIMIT 1');
    if (firstUser) await setAppSetting('originalAdminUserId', String(firstUser.id));
  }
}

module.exports = { initSchema };
