// The SQLite connection and everything that serializes access to it: one queue, transactions that carry post-commit
// effects, and an exclusive mode for work that must see a stable database. A backup restore swaps the file under the
// connection, so callers reopen through openDatabase() instead of holding the handle.
const { AsyncLocalStorage } = require('async_hooks');
const sqlite3 = require('sqlite3').verbose();
const { dbPath } = require('./config');

function configureDatabase(database) {
  database.configure('busyTimeout', 5000);
  return database;
}

let db = configureDatabase(new sqlite3.Database(dbPath));
const databaseTransactionContext = new AsyncLocalStorage();
let databaseQueue = Promise.resolve();

function withDatabaseLock(operation) {
  const previous = databaseQueue;
  let release;
  databaseQueue = new Promise(resolve => { release = resolve; });
  return previous.then(operation).finally(release);
}

function queryDatabase(operation) {
  const transaction = databaseTransactionContext.getStore();
  if (transaction?.active) return operation(transaction.connection);
  return withDatabaseLock(() => operation(db));
}

function rawRun(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.run(sql, params, function onRun(error) {
      if (error) reject(error);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

async function withDatabaseTransaction(operation) {
  let committedEffects = [];
  const result = await withDatabaseLock(async () => {
    await rawRun(db, 'BEGIN IMMEDIATE');
    const transaction = { connection: db, afterCommit: [], active: true };
    try {
      const result = await databaseTransactionContext.run(transaction, operation);
      await rawRun(db, 'COMMIT');
      transaction.active = false;
      committedEffects = transaction.afterCommit;
      return result;
    } catch (error) {
      transaction.active = false;
      try { await rawRun(db, 'ROLLBACK'); }
      catch (rollbackError) { console.error('SQLite rollback failed:', rollbackError.message); }
      throw error;
    }
  });
  for (const effect of committedEffects) {
    try { await effect(); }
    catch (error) { console.error('Post-commit effect failed:', error.message); }
  }
  return result;
}

async function withDatabaseExclusive(operation) {
  return withDatabaseLock(async () => {
    const context = { connection: db, afterCommit: [], active: true, exclusive: true };
    try {
      return await databaseTransactionContext.run(context, () => operation(connection => { context.connection = connection; }));
    } finally {
      context.active = false;
    }
  });
}

function afterDatabaseCommit(effect) {
  const transaction = databaseTransactionContext.getStore();
  if (transaction?.active) transaction.afterCommit.push(effect);
  else effect();
}

function run(sql, params = []) {
  return queryDatabase(connection => rawRun(connection, sql, params));
}

function get(sql, params = []) {
  return queryDatabase(connection => new Promise((resolve, reject) => {
    connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  }));
}

function all(sql, params = []) {
  return queryDatabase(connection => new Promise((resolve, reject) => {
    connection.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
  }));
}

function openDatabase() {
  db = configureDatabase(new sqlite3.Database(dbPath));
  return db;
}

function closeDatabase() {
  return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

// A consistent snapshot that includes everything still in the -wal file. Call it inside withDatabaseLock.
function vacuumInto(snapshotPath) {
  return new Promise((resolve, reject) => {
    db.run(`VACUUM INTO ?`, [snapshotPath], err => err ? reject(err) : resolve());
  });
}

// Resolves once the work queued so far has finished, whether it succeeded or not.
async function databaseIdle() {
  try { await databaseQueue; } catch {}
}

function currentTransaction() {
  return databaseTransactionContext.getStore();
}

module.exports = {
  run, get, all, withDatabaseLock, withDatabaseTransaction, withDatabaseExclusive, afterDatabaseCommit,
  currentTransaction, openDatabase, closeDatabase, vacuumInto, databaseIdle
};
