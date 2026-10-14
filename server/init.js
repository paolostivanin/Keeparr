// Database initialization used at startup and after a restore.
const { backfillImportedNoteLabels } = require('./labels');
const { initSchema } = require('./schema');
const { mcpTokenHash } = require('./auth');

// Runs at startup and after a backup restore.
const init = () => initSchema({ hashToken: mcpTokenHash, backfillImportedNoteLabels });

module.exports = {
  init
};
