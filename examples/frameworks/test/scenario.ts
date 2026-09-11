import { createHmac } from "node:crypto";

import {
  burst,
  createPlan,
  duplicate,
  runPlan,
  shuffle,
  type Assertion,
  type RunReport,
} from "@masterplaycoding/eventlab";

import { Ledger, sign } from "../src/webhook.js";
import type { RunningApp } from "../src/running.js";

/**
 * One scenario, run unchanged against every framework.
 *
 * That it needs no changes is most of what the recipes demonstrate: EventLab
 * talks HTTP to a URL, and everything framework-shaped stops at
 * {@link RunningApp}.
 */

export type Start = (ledger: Ledger) => Promise<RunningApp>;

const events = [
  { id: "evt_1", body: { eventId: "evt_1", orderId: "ord_1" } },
  { id: "evt_2", body: { eventId: "evt_2", orderId: "ord_2" } },
  { id: "evt_3", body: { eventId: "evt_3", orderId: "ord_3" } },
];

/** Nine deliveries, three of each event, shuffled and released at once. */
const plan = createPlan({
  scenario: "framework recipe",
  events,
  seed: 20260911,
  concurrency: 4,
  transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
});

/**
 * How the provider formats a body: pretty-printed.
 *
 * Deliberately not what `JSON.stringify` produces, because real providers do
 * not promise compact JSON and a handler that re-serialises the parsed body
 * to check the signature only works if they happen to send it. With this, a
 * recipe that verifies anything but the raw bytes gets a 401 on every
 * delivery - `pitfalls.test.ts` shows it.
 */
function providerBody(body: unknown): string {
  return JSON.stringify(body, null, 2);
}

export interface Outcome {
  readonly report: RunReport;
  readonly ledger: Ledger;
  readonly baseUrl: string;
}

interface Delivery {
  readonly signatureFor: (body: string) => string;
  readonly assertions: (ledger: Ledger) => Assertion[];
  /** Forgeries are meant to be refused, so a 401 is not a failed delivery. */
  readonly rejectionsExpected: boolean;
}

/**
 * Starts the app, delivers the plan, and closes the app in `teardown`.
 *
 * Started *before* `runPlan` rather than in `hooks.setup`: the target's
 * `baseUrl` is resolved before setup runs - so a bad target fails before
 * anything is started - and an ephemeral port does not exist until the app
 * is listening. Closing in `teardown` rather than in the test's `afterEach`
 * puts the shutdown in the report, so a framework that hangs on close shows
 * up as `cleanup.status: "timed-out"` instead of as a test that never ends.
 */
async function deliver(start: Start, delivery: Delivery): Promise<Outcome> {
  const ledger = new Ledger();
  const app = await start(ledger);

  const report = await runPlan(plan, {
    events,
    target: {
      baseUrl: app.baseUrl,
      request: ({ event }) => {
        const body = providerBody(event.body);
        return {
          method: "POST",
          path: "/webhooks",
          headers: {
            "content-type": "application/json",
            "x-signature": delivery.signatureFor(body),
          },
          body,
        };
      },
    },
    hooks: { teardown: () => app.close() },
    ...(delivery.rejectionsExpected ? { expect: { deliveries: "declared" as const } } : {}),
    assertions: delivery.assertions(ledger),
  });

  return { report, ledger, baseUrl: app.baseUrl };
}

/** What the provider sends: duplicates of correctly signed events. */
export const deliverDuplicates = (start: Start): Promise<Outcome> =>
  deliver(start, {
    signatureFor: sign,
    rejectionsExpected: false,
    assertions: (ledger) => [
      {
        name: "each order is fulfilled exactly once",
        check: () => {
          for (const { body } of events) {
            const count = ledger.fulfilmentsOf(body.orderId);
            if (count !== 1) {
              throw new Error(`${body.orderId} fulfilled ${count} times, expected 1`);
            }
          }
        },
      },
    ],
  });

/**
 * What an attacker can send: the right bytes, signed with the wrong key.
 *
 * Without this, a recipe that forgot to verify at all would pass
 * {@link deliverDuplicates} - nothing there depends on the signature being
 * checked.
 */
export const deliverForgeries = (start: Start): Promise<Outcome> =>
  deliver(start, {
    signatureFor: (body) =>
      `sha256=${createHmac("sha256", "not_the_secret").update(body).digest("hex")}`,
    rejectionsExpected: true,
    assertions: (ledger) => [
      {
        name: "nothing was fulfilled",
        check: () => {
          if (ledger.handled !== 0) {
            throw new Error(`${ledger.handled} forged events were handled`);
          }
        },
      },
    ],
  });

/** Response statuses by attempt, with transport failures named rather than dropped. */
export function statusesOf(report: RunReport): (number | string)[] {
  return report.attempts.map((attempt) =>
    attempt.outcome.kind === "response" ? attempt.outcome.status : attempt.outcome.kind,
  );
}
