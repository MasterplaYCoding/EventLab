import { DatabaseSync } from "node:sqlite";

/**
 * The four tables the inbox/outbox pattern needs.
 *
 * SQLite rather than PostgreSQL, and the difference is worth being explicit
 * about. What this example demonstrates is **crash recovery**: a worker killed
 * mid-transaction, and what the system looks like afterwards. That needs
 * storage which outlives the process, which is the only reason a database
 * appears in an otherwise dependency-free toolkit. `node:sqlite` is built into
 * Node 22+, so it costs nothing to install and runs on every platform CI
 * covers.
 *
 * What SQLite cannot show is `SELECT … FOR UPDATE SKIP LOCKED` — several
 * workers competing for inbox rows. That is a scaling mechanism rather than one
 * of the failure modes here, and with a single worker a transaction is
 * sufficient. See docs/decisions/003 for the full accounting.
 */
export function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    -- Deduplication is a uniqueness constraint, not application logic. Two
    -- concurrent deliveries of one event cannot both insert, whatever order
    -- the handler's statements happen to run in.
    CREATE TABLE IF NOT EXISTS inbox (
      event_id         TEXT PRIMARY KEY,
      order_id         TEXT NOT NULL,
      resource_version INTEGER NOT NULL,
      payload          TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      received_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      order_id                 TEXT PRIMARY KEY,
      last_applied_version     INTEGER NOT NULL,
      status                   TEXT NOT NULL
    );

    -- One fulfilment per order, enforced by the primary key rather than by a
    -- prior read.
    CREATE TABLE IF NOT EXISTS fulfillments (
      order_id  TEXT PRIMARY KEY,
      event_id  TEXT NOT NULL
    );

    -- A notification the system owes the outside world. Written in the same
    -- transaction as the business change, so it cannot be lost by a crash
    -- between the two.
    CREATE TABLE IF NOT EXISTS outbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id   TEXT NOT NULL,
      event_id   TEXT NOT NULL,
      dispatched INTEGER NOT NULL DEFAULT 0
    );
  `);
}

/** Opens a database at `path`, creating the schema if it is new. */
export function open(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  createSchema(database);
  return database;
}
