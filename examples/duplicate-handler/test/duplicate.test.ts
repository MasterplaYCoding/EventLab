import { afterEach, describe, expect, it } from "vitest";
import { burst, createPlan, duplicate, runPlan, shuffle } from "@masterplaycoding/eventlab";
import type { HttpTarget, RunReport } from "@masterplaycoding/eventlab";

import { ORDER_COUNT, paymentEvents } from "../src/fixtures.js";
import { startExampleServer, type ExampleServer, type Mode } from "../src/server.js";

let app: ExampleServer | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * The scenario both handlers face: every event delivered three times,
 * shuffled, all released at once against a concurrency of four.
 *
 * The seed is fixed, so this is the same experiment every run. The failure it
 * exposes does not depend on how those deliveries interleave - see the note in
 * the assertions below.
 */
async function runDuplicateScenario(mode: Mode): Promise<{
  report: RunReport;
  app: ExampleServer;
}> {
  app = await startExampleServer(mode);
  const server = app;

  const plan = createPlan({
    scenario: "payments delivered three times",
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
          if (writes !== ORDER_COUNT) {
            throw new Error(`expected ${ORDER_COUNT} fulfilment writes, found ${writes}`);
          }
        },
      },
    ],
  });

  return { report, app: server };
}

describe("duplicate delivery against a handler that deduplicates on event id", () => {
  it("delivers every attempt successfully, and still fulfils one order twice", async () => {
    const { report, app: server } = await runDuplicateScenario("broken");

    // Every delivery succeeded at the transport level. This is the trap: an
    // HTTP-level view of the system shows nine clean 200s and nothing wrong.
    expect(report.attempts).toHaveLength(paymentEvents.length * 3);
    expect(report.attempts.every((attempt) => attempt.outcome.kind === "response")).toBe(true);

    // The business invariant is what broke, and it broke for a reason that has
    // nothing to do with scheduling: two different event ids describe order
    // ord_1001, so event-id deduplication lets both through. This assertion
    // holds identically on every platform and every run - if it depended on
    // deliveries interleaving a particular way, it would be a bad regression
    // test rather than a demonstration.
    expect(server.store.writesFor("ord_1001")).toBe(2);
    expect(server.store.writesFor("ord_1002")).toBe(1);
    expect(server.store.fulfillmentCount()).toBe(ORDER_COUNT);

    expect(report.passed).toBe(false);
    expect(report.assertions[0]).toMatchObject({
      name: "each order is fulfilled exactly once",
      status: "failed",
      message: "expected 2 fulfilment writes, found 3",
    });
  });
});

describe("the same scenario against the corrected handler", () => {
  it("passes", async () => {
    const { report, app: server } = await runDuplicateScenario("fixed");

    expect(report.attempts).toHaveLength(paymentEvents.length * 3);
    expect(server.store.writesFor("ord_1001")).toBe(1);
    expect(server.store.writesFor("ord_1002")).toBe(1);
    expect(report.passed).toBe(true);
    expect(report.assertions[0]?.status).toBe("passed");
  });

  it("is reproducible: the same seed plans the same deliveries", async () => {
    const build = () =>
      createPlan({
        scenario: "payments delivered three times",
        events: paymentEvents,
        seed: 20260908,
        concurrency: 4,
        transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
      });

    expect(build()).toEqual(build());
  });
});
