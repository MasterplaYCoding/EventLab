import type { DatabaseSync } from "node:sqlite";

/**
 * A named point at which the worker will stop, hard.
 *
 * These exist so a test can say "die *here*" instead of killing the process at
 * an arbitrary moment and hoping it lands somewhere interesting. A crash test
 * built on timing tells you about your machine; a crash test built on a named
 * boundary tells you about your system.
 */
export type CrashPoint =
  /** After the transaction opens, before anything is written. */
  | "before-commit"
  /** After commit, before the inbox row is reported processed to anyone. */
  | "after-commit"
  /** After commit, before the outbox notification is dispatched. */
  | "before-dispatch";

export interface WorkerOptions {
  readonly database: DatabaseSync;
  /** Where to stop, if anywhere. */
  readonly crashAt?: CrashPoint;
  /** Called for each dispatched notification. Must be idempotent. */
  readonly dispatch?: (orderId: string, eventId: string) => void;
}

export class CrashedDeliberately extends Error {
  constructor(readonly at: CrashPoint) {
    super(`worker stopped at ${at}`);
    this.name = "CrashedDeliberately";
  }
}

/**
 * Processes one pending inbox row, or reports that there was nothing to do.
 *
 * The whole point is step 2: the business change, the outbox row and the
 * inbox row's status all move in **one** transaction. Either every one of them
 * becomes visible or none does, so there is no state in which the order was
 * fulfilled but the system has forgotten it owes a notification.
 *
 * @returns the event id processed, or null when the inbox was empty.
 */
export function processOne(options: WorkerOptions): string | null {
  const { database, crashAt, dispatch } = options;

  const pending = database
    .prepare(
      `SELECT event_id, order_id, resource_version FROM inbox
       WHERE status = 'pending'
       ORDER BY received_at, event_id
       LIMIT 1`,
    )
    .get() as { event_id: string; order_id: string; resource_version: number } | undefined;

  if (pending === undefined) {
    return null;
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    if (crashAt === "before-commit") {
      // Nothing has been written. A rollback must leave the row pending, and
      // that is what the recovery test checks.
      throw new CrashedDeliberately("before-commit");
    }

    const current = database
      .prepare(`SELECT last_applied_version FROM orders WHERE order_id = ?`)
      .get(pending.order_id) as { last_applied_version: number } | undefined;

    // An older version arriving after a newer one is applied to nothing. The
    // version is carried by the event itself; it is not inferred from arrival
    // order or from a provider timestamp, neither of which is an ordering
    // contract.
    const stale = current !== undefined && pending.resource_version <= current.last_applied_version;

    if (!stale) {
      database
        .prepare(
          `INSERT INTO orders (order_id, last_applied_version, status)
           VALUES (?, ?, 'fulfilled')
           ON CONFLICT(order_id) DO UPDATE SET
             last_applied_version = excluded.last_applied_version,
             status = excluded.status`,
        )
        .run(pending.order_id, pending.resource_version);

      // The primary key does the work. Even if this row were reached twice,
      // the second attempt changes nothing.
      database
        .prepare(
          `INSERT INTO fulfillments (order_id, event_id) VALUES (?, ?)
           ON CONFLICT(order_id) DO NOTHING`,
        )
        .run(pending.order_id, pending.event_id);

      database
        .prepare(`INSERT INTO outbox (order_id, event_id) VALUES (?, ?)`)
        .run(pending.order_id, pending.event_id);
    }

    database
      .prepare(`UPDATE inbox SET status = 'processed' WHERE event_id = ?`)
      .run(pending.event_id);

    database.exec("COMMIT");
  } catch (cause) {
    database.exec("ROLLBACK");
    throw cause;
  }

  if (crashAt === "after-commit") {
    // Everything is durably committed. A restart must not redo any of it.
    throw new CrashedDeliberately("after-commit");
  }

  dispatchPending(database, {
    ...(crashAt === undefined ? {} : { crashAt }),
    ...(dispatch === undefined ? {} : { dispatch }),
  });
  return pending.event_id;
}

/**
 * Dispatches outbox rows that have not been sent.
 *
 * Deliberately *after* the commit and outside the transaction. Sending a
 * notification is not something a database can roll back, so it cannot be part
 * of the atomic step — which is exactly why the outbox row exists.
 *
 * The consequence is at-least-once, not exactly-once: a dispatch that succeeds
 * and whose acknowledgement is lost is indistinguishable from one that failed,
 * so it is sent again. The receiver must be idempotent, and no arrangement of
 * this code changes that.
 */
export function dispatchPending(
  database: DatabaseSync,
  options: Pick<WorkerOptions, "crashAt" | "dispatch">,
): void {
  const rows = database
    .prepare(`SELECT id, order_id, event_id FROM outbox WHERE dispatched = 0 ORDER BY id`)
    .all() as Array<{ id: number; order_id: string; event_id: string }>;

  for (const row of rows) {
    if (options.crashAt === "before-dispatch") {
      throw new CrashedDeliberately("before-dispatch");
    }
    options.dispatch?.(row.order_id, row.event_id);
    database.prepare(`UPDATE outbox SET dispatched = 1 WHERE id = ?`).run(row.id);
  }
}

/** Drains the inbox, returning how many rows it processed. */
export function drain(options: WorkerOptions): number {
  let processed = 0;
  while (processOne(options) !== null) {
    processed += 1;
  }
  return processed;
}
