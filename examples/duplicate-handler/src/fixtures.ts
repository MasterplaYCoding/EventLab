import type { EventFixture } from "@masterplaycoding/eventlab";

import type { PaymentEvent } from "./server.js";

/**
 * Synthetic payment events for two orders.
 *
 * Note `evt_charge_1`: a *second* event, with its own event id, describing the
 * same payment as `evt_payment_1`. This is not a duplicate delivery - it is a
 * correct provider sending two notifications about one real-world occurrence,
 * which is exactly what Stripe documents when a payment produces both a
 * `payment_intent.succeeded` and a `charge.succeeded` event.
 *
 * Duplicate *delivery* is separate, and belongs in the plan rather than here,
 * because that is where an at-least-once transport lives in a model of the
 * system.
 */
export const paymentEvents: EventFixture[] = [
  {
    id: "evt_payment_1",
    body: { eventId: "evt_payment_1", orderId: "ord_1001", amount: 4_999 } satisfies PaymentEvent,
  },
  {
    id: "evt_payment_2",
    body: { eventId: "evt_payment_2", orderId: "ord_1002", amount: 12_500 } satisfies PaymentEvent,
  },
  {
    id: "evt_charge_1",
    body: { eventId: "evt_charge_1", orderId: "ord_1001", amount: 4_999 } satisfies PaymentEvent,
  },
];

/** Distinct orders described by {@link paymentEvents}. */
export const ORDER_COUNT = 2;
