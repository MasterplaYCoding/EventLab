import { afterEach, describe, expect, it } from "vitest";
import { burst, createPlan, duplicate, runPlan, shuffle } from "@masterplaycoding/eventlab";
import type { HttpTarget, RunReport } from "@masterplaycoding/eventlab";

import { paymentEvents } from "../src/fixtures.js";
import { startExampleServer, type ExampleServer, type Mode } from "../src/server.js";

let app: ExampleServer | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * The scenario both handlers face: every payment event delivered three times,
 * shuffled, all released at once against a concurrency of four.
 *
 * The seed is fixed, so this is the same experiment every run.
 */
async function runDuplicateScenario(mode: Mode): Promise<{
  report: RunReport;
  fulfillments: number;
  writes: number;
}> {
  app = await startExampleServer(mode);
  const server = app;

  const plan = createPlan({
    scenario: "payment delivered three times",
    events: paymentEvents,
    seed: 20260908,
    concurrency: 4,
    transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
  });

  const target: HttpTarget = {
    baseUrl: server.baseUrl,
    request: ({ event }) => ({
      method: "POST",
      path: "/webhooks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event.body),
    }),
  };

  const report = await runPlan(plan, {
    events: paymentEvents,
    target,
    hooks: { reset: () => server.store.reset() },
    assertions: [
      {
        name: "each order is fulfilled exactly once",
        check: () => {
          const writes = server.store.writeCount();
          if (writes !== paymentEvents.length) {
            throw new Error(
              `expected ${paymentEvents.length} fulfilment writes, found ${writes}`,
            );
          }
        },
      },
    ],
  });

  return {
    report,
    fulfillments: server.store.fulfillmentCount(),
    writes: server.store.writeCount(),
  };
}

describe("duplicate delivery against a check-then-act handler", () => {
  it("delivers every planned attempt successfully, and still fulfils orders twice", async () => {
    const { report, fulfillments, writes } = await runDuplicateScenario("broken");

    // Every delivery succeeded at the transport level. This is the trap: an
    // HTTP-level view of the system shows six clean 200s and nothing wrong.
    expect(report.attempts).toHaveLength(6);
    expect(report.attempts.every((a) => a.outcome.kind === "response")).toBe(true);

    // The business invariant is the thing that broke.
    expect(fulfillments).toBe(2);
    expect(writes).toBeGreaterThan(2);
    expect(report.passed).toBe(false);
    expect(report.assertions[0]).toMatchObject({
      name: "each order is fulfilled exactly once",
      status: "failed",
    });
  });
});

describe("the same scenario against the corrected handler", () => {
  it("passes", async () => {
    const { report, fulfillments, writes } = await runDuplicateScenario("fixed");

    expect(report.attempts).toHaveLength(6);
    expect(fulfillments).toBe(2);
    expect(writes).toBe(2);
    expect(report.passed).toBe(true);
    expect(report.assertions[0]?.status).toBe("passed");
  });

  it("is reproducible: the same seed plans the same deliveries", async () => {
    const build = () =>
      createPlan({
        scenario: "payment delivered three times",
        events: paymentEvents,
        seed: 20260908,
        concurrency: 4,
        transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
      });

    expect(build()).toEqual(build());
  });
});
