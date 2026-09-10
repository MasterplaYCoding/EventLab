import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";

export interface OrderEvent {
  readonly eventId: string;
  readonly orderId: string;
}

export type Mode = "broken" | "fixed";

export interface Receiver {
  readonly baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Two tables, and the difference between them is the whole example.
 *
 * `fulfillments` is keyed by order, so writing it twice is harmless — the
 * second write conflicts and does nothing. `notifications` is an append-only
 * log of a side effect that left the building: an email, an SMS, a push. There
 * is no constraint that can un-send one, which is why what guards it matters.
 *
 * The file outlives the process. That is the only reason any of this is
 * testable.
 */
function openDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE IF NOT EXISTS fulfillments (
      order_id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL
    );
  `);
  return database;
}

/**
 * The handler that deduplicates in memory.
 *
 * This is the bug *after* the one in the README, and it is worth being precise
 * about the difference. The README's handler deduplicates on the wrong key —
 * the event id — and two events describing one payment sail past it. This
 * handler has learned that lesson: it keys on the order, so a second event for
 * the same order notifies nobody. Within one process it is correct, and every
 * test that runs against one process passes.
 *
 * What it gets wrong is not the key but the *lifetime*. The set lives in the
 * process. Restart it — a deploy, a crash, an OOM kill, a container
 * rescheduled — and the set is empty while the database still holds every
 * fulfilment it made. The next redelivery of an order it already handled is,
 * as far as this handler can tell, brand new.
 *
 * Note that the fulfilment write is already idempotent. That is what makes it
 * survive review: the dangerous line is the one *after* the safe one, and the
 * safe one is what your eye stops on.
 */
function receiveBroken(database: DatabaseSync, seen: Set<string>, event: OrderEvent): number {
  // Keyed on the order, which is the right thing to make unique. Held in a
  // Set, which is the wrong place to hold it.
  if (seen.has(event.orderId)) return 200;
  seen.add(event.orderId);

  database
    .prepare(
      `INSERT INTO fulfillments (order_id, event_id) VALUES (?, ?)
       ON CONFLICT(order_id) DO NOTHING`,
    )
    .run(event.orderId, event.eventId);

  database.prepare(`INSERT INTO notifications (order_id) VALUES (?)`).run(event.orderId);

  return 200;
}

/**
 * The handler whose deduplication outlives the process.
 *
 * One line different, and the difference is *what the side effect is gated on*.
 * The durable write decides: if the insert changed a row, this is the first
 * time this order has been fulfilled and the notification goes out. If it
 * conflicted, someone already did this — possibly a process that no longer
 * exists — and nothing more is owed.
 *
 * Both handlers agree on what is unique — the order, not the event. They
 * disagree about where that knowledge is kept, and only one of the two answers
 * survives the process being replaced.
 */
function receiveFixed(database: DatabaseSync, event: OrderEvent): number {
  const result = database
    .prepare(
      `INSERT INTO fulfillments (order_id, event_id) VALUES (?, ?)
       ON CONFLICT(order_id) DO NOTHING`,
    )
    .run(event.orderId, event.eventId);

  if (result.changes > 0) {
    database.prepare(`INSERT INTO notifications (order_id) VALUES (?)`).run(event.orderId);
  }

  return 200;
}

/**
 * Starts a receiver on an ephemeral port against a database file.
 *
 * The port is not the caller's to choose, which is the point: restarting gives
 * a different one, exactly as a real process does after a deploy. A scenario
 * reaches it through a `baseUrl` function rather than a captured string.
 */
export async function startReceiver(options: {
  databasePath: string;
  mode: Mode;
}): Promise<Receiver> {
  const database = openDatabase(options.databasePath);

  // Empty on every start. In the broken mode that is the bug; in the fixed
  // mode it is simply unused.
  const seen = new Set<string>();

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      let status = 400;
      try {
        const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OrderEvent;
        status =
          options.mode === "broken"
            ? receiveBroken(database, seen, event)
            : receiveFixed(database, event);
      } catch {
        status = 400;
      }
      response.statusCode = status;
      response.end("{}");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      database.close();
    },
  };
}

/** How many notifications were sent for one order. The number that matters. */
export function notificationCount(databasePath: string, orderId: string): number {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database
      .prepare(`SELECT COUNT(*) AS n FROM notifications WHERE order_id = ?`)
      .get(orderId) as { n: number } | undefined;
    return row?.n ?? 0;
  } finally {
    database.close();
  }
}
