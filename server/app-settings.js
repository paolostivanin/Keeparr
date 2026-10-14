// Key/value settings stored in the app_settings table.
const { get, run } = require('./db');

async function getAppSetting(key, defaultValue) {
  const row = await get('SELECT value FROM app_settings WHERE key = ?', [key]);
  return row ? row.value : defaultValue;
}

async function setAppSetting(key, value) {
  await run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, String(value)]);
}

module.exports = { getAppSetting, setAppSetting };
