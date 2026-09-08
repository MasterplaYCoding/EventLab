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
 * The handler almost everyone writes second.
 *
 * The first attempt has no idempotency at all and is obviously wrong. This one
 * is the version written after reading the provider's documentation: it
 * deduplicates on the provider's event id, so redelivering an event is a
 * no-op. That part is correct, and `claimEvent` is genuinely indivisible, so
 * there is no race in it.
 *
 * It is still wrong, because event-id deduplication answers the question
 * "have I seen this *message* before?" when the invariant the business cares
 * about is "has this *order* been fulfilled before?". Providers routinely send
 * more than one event for a single real-world occurrence - Stripe describes
 * both `payment_intent.succeeded` and `charge.succeeded` for one payment - and
 * two different event ids sail straight past this check.
 *
 * No timing is involved. This handler fulfils the order twice on every
 * platform, on every run.
 */
async function handleBroken(store: OrderStore, event: PaymentEvent): Promise<void> {
  if (!(await store.claimEvent(event.eventId))) {
    return;
  }
  await store.recordFulfillment(event.orderId);
}

/**
 * The corrected handler.
 *
 * One line different, and the difference is which thing is unique. Claiming
 * the event id stays, because it is a cheap way to drop redeliveries early -
 * but it is an optimisation, not the guarantee. The guarantee is the
 * conditional insert, which makes fulfilment idempotent per *order*, whatever
 * combination of events describes it.
 *
 * Note what is absent: no sleep, no retry, no second look. Correctness comes
 * from a single indivisible operation, not from timing.
 */
async function handleFixed(store: OrderStore, event: PaymentEvent): Promise<void> {
  if (!(await store.claimEvent(event.eventId))) {
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
