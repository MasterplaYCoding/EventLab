import { afterEach, describe, expect, it } from "vitest";

import { createPlan } from "../src/plan/createPlan.js";
import { burst, duplicate } from "../src/plan/transforms.js";
import { parsePlan, serializePlan } from "../src/plan/savedPlan.js";
import { runPlan } from "../src/run/runPlan.js";
import { formatReport } from "../src/report/format.js";
import type { EventFixture, HttpTarget } from "../src/types.js";
import { startTestServer, type TestServer } from "./support/testServer.js";

const events: EventFixture[] = [
  { id: "evt_payment", body: { order: "ord_1" } },
  { id: "evt_refund", body: { order: "ord_1" } },
];

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

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

const twoPhasePlan = () =>
  createPlan({
    scenario: "payment settles, then a refund arrives",
    events,
    seed: 7,
    phases: [
      { deliver: ["evt_payment"], transforms: [duplicate({ copies: 2 }), burst()] },
      { barrier: "payment settled", checkpoint: "waitForSettlement" },
      { deliver: ["evt_refund"] },
    ],
  });

describe("planning with barriers", () => {
  it("assigns a phase to every attempt and records the barrier between them", () => {
    const plan = twoPhasePlan();

    // Phases are numbered across barriers: deliveries, barrier, deliveries.
    expect(plan.attempts.filter((attempt) => attempt.phase === 0)).toHaveLength(2);
    expect(plan.attempts.filter((attempt) => attempt.phase === 1)).toHaveLength(1);
    expect(plan.barriers).toEqual([
      { name: "payment settled", afterPhase: 0, checkpoint: "waitForSettlement" },
    ]);
  });

  it("keeps attempt ids unique across phases", () => {
    // The same event either side of a barrier would otherwise produce two
    // attempts called evt_payment#0, and attempt ids are the join key in
    // reports.
    const plan = createPlan({
      events,
      seed: 1,
      phases: [
        { deliver: ["evt_payment"] },
        { barrier: "settled" },
        { deliver: ["evt_payment"] },
      ],
    });

    expect(plan.attempts.map((attempt) => attempt.attemptId)).toEqual([
      "evt_payment#0",
      "evt_payment#1",
    ]);
    expect(plan.attempts.map((attempt) => attempt.order)).toEqual([0, 1]);
  });

  it("is still a pure function of its inputs", () => {
    expect(twoPhasePlan()).toEqual(twoPhasePlan());
  });

  it("round-trips through a saved plan", () => {
    const plan = twoPhasePlan();
    expect(parsePlan(serializePlan(plan))).toEqual(plan);
  });

  describe("rejects scenarios that cannot mean what they say", () => {
    it("a barrier with nothing before it", () => {
      expect(() =>
        createPlan({ events, seed: 1, phases: [{ barrier: "nothing" }, { deliver: ["evt_payment"] }] }),
      ).toThrow(/no deliveries before it/);
    });

    it("two barriers in a row", () => {
      expect(() =>
        createPlan({
          events,
          seed: 1,
          phases: [{ deliver: ["evt_payment"] }, { barrier: "a" }, { barrier: "b" }],
        }),
      ).toThrow(/no deliveries before it/);
    });

    it("duplicate barrier names", () => {
      expect(() =>
        createPlan({
          events,
          seed: 1,
          phases: [
            { deliver: ["evt_payment"] },
            { barrier: "settled" },
            { deliver: ["evt_refund"] },
            { barrier: "settled" },
          ],
        }),
      ).toThrow(/duplicate barrier name/);
    });

    it("a phase delivering an event that is not declared", () => {
      expect(() =>
        createPlan({ events, seed: 1, phases: [{ deliver: ["evt_missing"] }] }),
      ).toThrow(/unknown event "evt_missing"/);
    });

    it("an event listed twice in one phase", () => {
      expect(() =>
        createPlan({ events, seed: 1, phases: [{ deliver: ["evt_payment", "evt_payment"] }] }),
      ).toThrow(/use duplicate\(\)/);
    });

    it("both transforms and phases", () => {
      expect(() =>
        createPlan({
          events,
          seed: 1,
          transforms: [burst()],
          phases: [{ deliver: ["evt_payment"] }],
        }),
      ).toThrow(/not both/);
    });
  });
});

describe("running with barriers", () => {
  it("does not release a later phase until the earlier one has finished", async () => {
    // Every delivery is slow, so an implementation that ignored phases would
    // overlap them and the refund would arrive before both payments.
    server = await startTestServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      response.end("ok");
    });

    let settledAfter = -1;
    const report = await runPlan(twoPhasePlan(), {
      events,
      target: targetFor(server.baseUrl),
      hooks: {
        checkpoints: {
          waitForSettlement: () => {
            settledAfter = server?.requests.length ?? -1;
          },
        },
      },
    });

    expect(report.passed).toBe(true);
    // The checkpoint saw both payments and no refund.
    expect(settledAfter).toBe(2);

    const order = server.requests.map((request) => JSON.parse(request.body) as { order: string });
    expect(order).toHaveLength(3);
    expect(report.barriers[0]).toMatchObject({
      name: "payment settled",
      status: "passed",
      attemptsBefore: 2,
    });
  });

  it("rejects a barrier whose checkpoint was never supplied, before delivering anything", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));

    const report = await runPlan(twoPhasePlan(), {
      events,
      target: targetFor(server.baseUrl),
      hooks: { checkpoints: { somethingElse: () => {} } },
    });

    // Failing after thirty seconds of deliveries, with the application already
    // modified, would be a much worse way to learn about a typo.
    expect(report.harnessError?.code).toBe("InvalidScenario");
    expect(report.harnessError?.message).toContain("waitForSettlement");
    expect(report.harnessError?.message).toContain("somethingElse");
    expect(server.requests).toHaveLength(0);
  });

  it("stops the run when a checkpoint fails, and says which barrier", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));

    const report = await runPlan(twoPhasePlan(), {
      events,
      target: targetFor(server.baseUrl),
      hooks: {
        checkpoints: {
          waitForSettlement: () => {
            throw new Error("the worker never drained");
          },
        },
      },
    });

    expect(report.passed).toBe(false);
    expect(report.barriers[0]).toMatchObject({
      name: "payment settled",
      status: "failed",
      message: "the worker never drained",
    });
    // The refund phase never ran: continuing past a checkpoint that failed
    // would test a state nobody described.
    expect(server.requests).toHaveLength(2);
    expect(formatReport(report)).toContain('✗ barrier "payment settled"');
  });

  it("runs a barrier with no checkpoint as a pure synchronisation point", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));

    const plan = createPlan({
      events,
      seed: 3,
      phases: [{ deliver: ["evt_payment"] }, { barrier: "quiet" }, { deliver: ["evt_refund"] }],
    });
    const report = await runPlan(plan, { events, target: targetFor(server.baseUrl) });

    expect(report.passed).toBe(true);
    expect(report.barriers[0]).toMatchObject({ name: "quiet", status: "passed" });
    expect(formatReport(report)).toContain('⏸ barrier "quiet" after 1 deliveries');
  });

  it("reports a barrier the run never reached as skipped", async () => {
    server = await startTestServer((_request, response) => {
      response.statusCode = 500;
      response.end("nope");
    });

    const plan = createPlan({
      events,
      seed: 3,
      phases: [
        { deliver: ["evt_payment"] },
        { barrier: "first" },
        { deliver: ["evt_refund"] },
        { barrier: "second", checkpoint: "never" },
      ],
    });

    const controller = new AbortController();
    controller.abort();

    const report = await runPlan(plan, {
      events,
      target: targetFor(server.baseUrl),
      hooks: { checkpoints: { never: () => {} } },
      signal: controller.signal,
    });

    // A truncated run should be visibly truncated rather than quietly short.
    expect(report.barriers.map((barrier) => barrier.status)).toEqual(["skipped", "skipped"]);
    expect(formatReport(report)).toContain("harness error");
  });
});
