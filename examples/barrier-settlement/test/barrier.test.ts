import { afterEach, describe, expect, it } from "vitest";
import { burst, createPlan, duplicate, runPlan } from "@masterplaycoding/eventlab";
import type { EventFixture, HttpTarget, PlanPhase } from "@masterplaycoding/eventlab";

import { startLedgerServer, type LedgerServer, type Mode } from "../src/server.js";

let app: LedgerServer | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** One payment and one refund for the same order, each delivered twice. */
const events: EventFixture[] = [
  { id: "evt_payment", body: { eventId: "evt_payment", type: "payment", orderId: "ord_1", amount: 5000 } },
  { id: "evt_refund", body: { eventId: "evt_refund", type: "refund", orderId: "ord_1", amount: 5000 } },
];

function targetFor(baseUrl: string): HttpTarget {
  return {
    baseUrl,
    request: ({ event }) => ({
      method: "POST",
      path: "/webhooks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event.body),
    }),
  };
}

interface RunOptions {
  /**
   * Hold the settlement worker for the whole run.
   *
   * This is how "the refund arrived before its payment settled" becomes a
   * property of the scenario instead of a race the test hopes to win. An
   * earlier version of these tests just delivered everything at once and
   * assumed the refund would overtake the worker: reliable on Windows, never
   * true on Linux, and a red CI run on three of six configurations.
   */
  readonly holdSettlement?: boolean;
}

async function run(mode: Mode, phases: readonly PlanPhase[], options: RunOptions = {}) {
  app = await startLedgerServer(mode);
  const server = app;

  const plan = createPlan({
    scenario: "payment settles, then a refund arrives",
    events,
    seed: 4242,
    concurrency: 4,
    phases,
  });

  const report = await runPlan(plan, {
    events,
    target: targetFor(server.baseUrl),
    // Payments answer 202 and refunds may answer 409, so transport outcomes
    // are declared and the assertions carry the judgement.
    expect: { deliveries: "declared" },
    hooks: {
      reset: () => {
        server.ledger.reset();
        if (options.holdSettlement === true) {
          server.ledger.pauseSettlement();
        }
      },
      checkpoints: {
        // The application decides when it is quiescent. The test waits for
        // that signal rather than guessing with a sleep.
        settlementDrained: () => server.ledger.whenSettled(),
      },
    },
    assertions: [
      {
        name: "an order never owes money it was never paid",
        check: () => {
          // The lowest balance ever held, not the final one. The failure is
          // transient: settlement afterwards restores the balance and hides it.
          const lowest = server.ledger.lowestBalance("ord_1");
          if (lowest < 0) {
            throw new Error(`ord_1 fell to a balance of ${lowest}`);
          }
        },
      },
    ],
  });

  return { report, server };
}

const withBarrier: PlanPhase[] = [
  { deliver: ["evt_payment"], transforms: [duplicate({ copies: 2 }), burst()] },
  { barrier: "settlement drained", checkpoint: "settlementDrained" },
  { deliver: ["evt_refund"], transforms: [duplicate({ copies: 2 }), burst()] },
];

const withoutBarrier: PlanPhase[] = [
  {
    deliver: ["evt_payment", "evt_refund"],
    transforms: [duplicate({ copies: 2 }), burst()],
  },
];

describe("a refund delivered after settlement", () => {
  it("is applied correctly, and the barrier is what makes that testable", async () => {
    const { report, server } = await run("fixed", withBarrier);

    expect(report.passed).toBe(true);
    expect(report.barriers[0]).toMatchObject({
      name: "settlement drained",
      status: "passed",
      attemptsBefore: 2,
    });

    // Paid once, refunded once. Reaching this state at all depends on the
    // refund arriving after the worker finished, which is precisely what the
    // barrier guarantees and what no arrangement of delays can.
    expect(server.ledger.balance("ord_1")).toBe(0);
    expect(server.ledger.isSettled("ord_1")).toBe(true);
  });
});

describe("a refund delivered while settlement is still running", () => {
  it("is refused by the corrected handler", async () => {
    const { report, server } = await run("fixed", withoutBarrier, { holdSettlement: true });

    expect(report.passed).toBe(true);
    // Refused rather than applied against a balance that does not exist yet.
    const refused = report.attempts.filter(
      (attempt) => attempt.outcome.kind === "response" && attempt.outcome.status === 409,
    );
    expect(refused.length).toBeGreaterThan(0);
    expect(server.ledger.lowestBalance("ord_1")).toBeGreaterThanOrEqual(0);
  });

  it("is silently mis-applied by the handler that trusts the ledger", async () => {
    const { report, server } = await run("broken", withoutBarrier, { holdSettlement: true });

    // Every delivery succeeded. The ledger is simply wrong.
    expect(report.attempts.every((attempt) => attempt.outcome.kind === "response")).toBe(true);
    expect(report.passed).toBe(false);
    expect(report.assertions[0]).toMatchObject({
      name: "an order never owes money it was never paid",
      status: "failed",
    });
    expect(server.ledger.lowestBalance("ord_1")).toBeLessThan(0);
  });
});

describe("the barrier itself", () => {
  it("refuses to run if the application does not supply the checkpoint", async () => {
    app = await startLedgerServer("fixed");
    const server = app;

    const plan = createPlan({ scenario: "typo", events, seed: 1, phases: withBarrier });
    const report = await runPlan(plan, {
      events,
      target: targetFor(server.baseUrl),
      hooks: { checkpoints: { settlementDrainedTypo: () => {} } },
    });

    expect(report.harnessError?.code).toBe("InvalidScenario");
    // Nothing was delivered, so the application is untouched.
    expect(server.ledger.isSettled("ord_1")).toBe(false);
  });
});
