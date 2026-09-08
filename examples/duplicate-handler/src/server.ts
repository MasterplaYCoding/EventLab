import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { OrderStore } from "./store.js";

export interface PaymentEvent {
  readonly eventId: string;
  readonly orderId: string;
  readonly amount: number;
}

/** Which handler the example server mounts. */
export type Mode = "broken" | "fixed";

export interface ExampleServer {
  readonly baseUrl: string;
  readonly store: OrderStore;
  close: () => Promise<void>;
}

/**
 * The handler almost everyone writes first.
 *
 * "Have we fulfilled this order? No? Then fulfil it." It reads correctly and
 * it is wrong under at-least-once delivery: two copies of the same event can
 * both pass the check before either writes. Providers that document duplicate
 * webhook deliveries - Stripe among them - make this a routine production
 * condition rather than an exotic one.
 */
async function handleBroken(store: OrderStore, event: PaymentEvent): Promise<void> {
  const alreadyFulfilled = await store.hasFulfillment(event.orderId);
  if (!alreadyFulfilled) {
    await store.recordFulfillment(event.orderId);
  }
}

/**
 * The corrected handler.
 *
 * Two independent defences, because they cover different failures:
 *
 * 1. Claiming the event id makes redelivery of the *same* event a no-op. This
 *    is the cheap common case.
 * 2. The conditional insert makes fulfilment idempotent per order even when
 *    two *different* event ids describe the same outcome, or when two claims
 *    race. This is the one that actually holds the invariant; the first is an
 *    optimisation on top of it.
 *
 * Note what is missing: no sleep, no retry, no "check again just in case".
 * Correctness comes from a single indivisible operation, not from timing.
 */
async function handleFixed(store: OrderStore, event: PaymentEvent): Promise<void> {
  const claimed = await store.claimEvent(event.eventId);
  if (!claimed) {
    return;
  }
  await store.recordFulfillmentOnce(event.orderId);
}

/** Starts the example webhook receiver on an ephemeral loopback port. */
export async function startExampleServer(mode: Mode): Promise<ExampleServer> {
  const store = new OrderStore();

  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/webhooks") {
      response.statusCode = 404;
      response.end();
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        try {
          const event = JSON.parse(Buffer.concat(chunks).toString("utf8")) as PaymentEvent;
          if (mode === "broken") {
            await handleBroken(store, event);
          } else {
            await handleFixed(store, event);
          }
          response.statusCode = 200;
          response.end(JSON.stringify({ ok: true }));
        } catch (cause) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: (cause as Error).message }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
