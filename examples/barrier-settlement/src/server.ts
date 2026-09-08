import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Ledger } from "./store.js";

export interface LedgerEvent {
  readonly eventId: string;
  readonly type: "payment" | "refund";
  readonly orderId: string;
  readonly amount: number;
}

export type Mode = "broken" | "fixed";

export interface LedgerServer {
  readonly baseUrl: string;
  readonly ledger: Ledger;
  close: () => Promise<void>;
}

/**
 * The refund handler that trusts the ledger to already be correct.
 *
 * It subtracts the refund from whatever balance it can see. If the payment has
 * not settled yet, that balance is zero, and the order ends up owing money
 * that was never taken. No error is raised — the arithmetic is simply wrong,
 * which is the worst kind of wrong.
 */
function refundBroken(ledger: Ledger, event: LedgerEvent): { status: number } {
  if (!ledger.claimRefund(event.eventId)) {
    return { status: 200 };
  }
  ledger.applyRefund(event.orderId, event.amount);
  return { status: 200 };
}

/**
 * The refund handler that refuses to guess.
 *
 * A refund for an order with nothing settled is not "a refund against zero" —
 * it is a request that arrived too early, and the honest answer is to refuse
 * it so the sender retries. `409` rather than `400`, because the request is
 * valid and the *state* is not ready.
 */
function refundFixed(ledger: Ledger, event: LedgerEvent): { status: number } {
  // The readiness check comes first, deliberately. Claiming the event id
  // before knowing the refund can be applied would consume the id on a request
  // that did nothing, and the sender's retry would then be silently dropped.
  if (!ledger.isSettled(event.orderId)) {
    return { status: 409 };
  }
  if (!ledger.claimRefund(event.eventId)) {
    return { status: 200 };
  }
  ledger.applyRefund(event.orderId, event.amount);
  return { status: 200 };
}

export async function startLedgerServer(mode: Mode): Promise<LedgerServer> {
  const ledger = new Ledger();

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as LedgerEvent;

        if (event.type === "payment") {
          // Accepted, not yet applied. This is the whole point.
          ledger.enqueue(event.eventId, event.orderId, event.amount);
          response.statusCode = 202;
          response.end(JSON.stringify({ accepted: true }));
          return;
        }

        const result = mode === "broken" ? refundBroken(ledger, event) : refundFixed(ledger, event);
        response.statusCode = result.status;
        response.end(JSON.stringify({ ok: result.status < 300 }));
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
    ledger,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
