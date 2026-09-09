import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";

import { open } from "./schema.js";

export interface OrderEvent {
  readonly eventId: string;
  readonly orderId: string;
  /** Carried by the event. Not a timestamp, and not an arrival order. */
  readonly resourceVersion: number;
}

export type Mode = "broken" | "fixed";

export interface InboxServer {
  readonly baseUrl: string;
  readonly database: DatabaseSync;
  close: () => Promise<void>;
}

/**
 * The endpoint that does the work in the request.
 *
 * It looks efficient and it is the wrong shape. The business change happens
 * before the acknowledgement, so a slow database turns into provider retries —
 * which is to say duplicates — and there is no record that a notification is
 * owed, so a crash between fulfilling and notifying loses the notification with
 * nothing to recover from.
 *
 * It also deduplicates by reading first, which is a check-then-act with a
 * suspension point in the middle.
 */
function receiveBroken(database: DatabaseSync, event: OrderEvent): number {
  const seen = database
    .prepare(`SELECT 1 FROM fulfillments WHERE order_id = ?`)
    .get(event.orderId);

  if (seen === undefined) {
    database
      .prepare(`INSERT INTO fulfillments (order_id, event_id) VALUES (?, ?)`)
      .run(event.orderId, event.eventId);
    database
      .prepare(
        `INSERT INTO orders (order_id, last_applied_version, status)
         VALUES (?, ?, 'fulfilled')
         ON CONFLICT(order_id) DO UPDATE SET last_applied_version = excluded.last_applied_version`,
      )
      .run(event.orderId, event.resourceVersion);
  }

  return 200;
}

/**
 * The endpoint that only records the event and acknowledges.
 *
 * Three lines, one insert, no business logic. Duplicate delivery is a primary
 * key conflict rather than a decision the handler makes, and the acknowledgement
 * goes out as soon as the event is durable — so a slow worker cannot cause
 * provider retries.
 *
 * Everything else happens in the worker, on its own schedule, in a transaction
 * this request knows nothing about.
 */
function receiveFixed(database: DatabaseSync, event: OrderEvent): number {
  database
    .prepare(
      `INSERT INTO inbox (event_id, order_id, resource_version, payload, received_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(event_id) DO NOTHING`,
    )
    .run(
      event.eventId,
      event.orderId,
      event.resourceVersion,
      JSON.stringify(event),
      Date.now(),
    );

  // 202: recorded, not yet applied. Saying 200 would imply the work is done.
  return 202;
}

export async function startInboxServer(mode: Mode, databasePath: string): Promise<InboxServer> {
  const database = open(databasePath);

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as OrderEvent;
        const status = mode === "broken"
          ? receiveBroken(database, event)
          : receiveFixed(database, event);
        response.statusCode = status;
        response.end(JSON.stringify({ ok: true }));
      } catch (cause) {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: (cause as Error).message }));
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    database,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          database.close();
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
