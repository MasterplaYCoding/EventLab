import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertRunPassed, createPlan, runPlan } from "@masterplaycoding/eventlab";

import {
  notificationCount,
  startReceiver,
  type Mode,
  type Receiver,
} from "../src/receiver.js";

/**
 * A bug that only exists across a restart.
 *
 * Every other example here fails within one process. This one cannot: the
 * broken handler is correct for as long as it keeps running, and its
 * deduplication only forgets when the process it lives in goes away. A scenario
 * that never restarts the application will report it as fine, forever.
 *
 * There is nothing timing-dependent in any of this. The failure needs the
 * restart and nothing else, so it reproduces identically on every platform and
 * every run — see docs/decisions/001-determinism-boundary.md.
 */

let workspace: string;
let databasePath: string;
let receiver: Receiver | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "eventlab-restart-"));
  databasePath = join(workspace, "orders.db");
});

afterEach(async () => {
  await receiver?.close();
  receiver = undefined;
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * The same delivery schedule for both handlers.
 *
 * Two events, one order — a provider describing one payment twice, as Stripe
 * does with `payment_intent.succeeded` and `charge.succeeded`. Both arrive
 * before the restart and both are redelivered after it, which is what a
 * provider does when it is unsure an acknowledgement was received.
 */
const events = [
  { id: "evt_payment_1", body: { eventId: "evt_payment_1", orderId: "ord_1001" } },
  { id: "evt_charge_1", body: { eventId: "evt_charge_1", orderId: "ord_1001" } },
];

const plan = createPlan({
  scenario: "redelivery across a restart",
  events,
  seed: 20260910,
  phases: [
    { deliver: ["evt_payment_1", "evt_charge_1"] },
    { barrier: "receiver restarted", checkpoint: "restart" },
    // The provider redelivers what it already sent. Same events, same ids.
    { deliver: ["evt_payment_1", "evt_charge_1"] },
  ],
});

async function run(mode: Mode) {
  receiver = await startReceiver({ databasePath, mode });

  return runPlan(plan, {
    events,
    target: {
      // A function, not a string. The receiver comes back on a different port
      // and a captured address would point at a closed socket.
      baseUrl: () => {
        if (receiver === undefined) throw new Error("receiver is not running");
        return receiver.baseUrl;
      },
      request: ({ event }) => ({
        method: "POST",
        path: "/webhooks",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(event.body),
      }),
    },
    hooks: {
      checkpoints: {
        // The restart. The database file stays; everything the process was
        // holding does not.
        restart: async () => {
          await receiver?.close();
          receiver = await startReceiver({ databasePath, mode });
        },
      },
    },
    assertions: [
      {
        name: "the customer is notified exactly once",
        check: () => {
          const sent = notificationCount(databasePath, "ord_1001");
          if (sent !== 1) {
            throw new Error(`expected 1 notification, found ${sent}`);
          }
        },
      },
    ],
  });
}

describe("in-memory deduplication", () => {
  it("notifies the customer again after the process restarts", async () => {
    const report = await run("broken");

    expect(report.passed).toBe(false);
    // Twice, not four times. Within a phase the set does its job: the second
    // event for the same order notifies nobody, because the key is right. The
    // extra notification is the restart and nothing else - exactly one per
    // restart, which is what makes this so easy to miss in production.
    expect(report.assertions[0]?.message).toContain("found 2");

    // Every request returned 200. Nothing in a log or a status dashboard looks
    // wrong; the only evidence is the customer's inbox.
    for (const attempt of report.attempts) {
      expect(attempt.outcome).toMatchObject({ kind: "response", status: 200 });
    }
  });

  it("was reached on two different ports", async () => {
    // Proof the restart actually happened rather than the scenario quietly
    // talking to the original process the whole time.
    const report = await run("broken");
    const ports = new Set(report.attempts.map((a) => new URL(a.request.url).port));

    expect(ports.size).toBe(2);
  });
});

describe("deduplication that outlives the process", () => {
  it("notifies once across the restart", async () => {
    const report = await run("fixed");

    assertRunPassed(report);
    expect(notificationCount(databasePath, "ord_1001")).toBe(1);
  });

  it("still recorded four deliveries", async () => {
    // The fix is not "fewer requests arrive". The same traffic arrives and the
    // handler decides correctly what is owed.
    const report = await run("fixed");

    expect(report.attempts).toHaveLength(4);
    expect(report.barriers[0]?.status).toBe("passed");
  });
});
