import type { EventFixture } from "@masterplaycoding/eventlab";

import type { PaymentEvent } from "./server.js";

/**
 * Synthetic payment events. Two orders, one event each.
 *
 * The fixtures describe a *correct* provider: one payment, one event. The
 * duplication comes from the delivery plan, which is where an at-least-once
 * transport belongs in a model of the system.
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
];
