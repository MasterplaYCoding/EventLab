import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createPlan } from "../src/plan/createPlan.js";
import { runPlan } from "../src/run/runPlan.js";
import { assertRunPassed, formatReport } from "../src/report/format.js";

/**
 * Teardown runs last, and used to run unbounded.
 *
 * It has to run after the scenario timeout has been cleared - a run that timed
 * out still needs cleaning up - which meant nothing was left to stop it. A hook
 * that never settled made `runPlan` never return, and a test that hangs with no
 * report at all is a worse outcome than any failure the report might have
 * described.
 */

let server: Server | undefined;
let baseUrl = "";

async function startTarget(): Promise<void> {
  server = createServer((incoming, response) => {
    incoming.on("data", () => {});
    incoming.on("end", () => {
      response.statusCode = 200;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing !== undefined) {
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

const events = [{ id: "evt_a", body: { order: "ord_1" } }];
const plan = createPlan({ scenario: "teardown", events, seed: 1 });
const request = () => ({ method: "POST" as const, path: "/webhooks" });

describe("a teardown that never finishes", () => {
  it("returns a report instead of hanging forever", async () => {
    await startTarget();
    let released: (() => void) | undefined;
    const stuck = new Promise<void>((resolve) => {
      released = resolve;
    });

    const started = Date.now();
    const report = await runPlan(plan, {
      events,
      target: { baseUrl, request },
      hooks: { teardown: () => stuck },
      limits: { teardownTimeoutMs: 200 },
    });
    const elapsed = Date.now() - started;

    expect(report.cleanup.status).toBe("timed-out");
    expect(elapsed).toBeLessThan(5_000);

    // Let the hook finish so the test does not leave it pending.
    released?.();
  });

  it("says plainly that it stopped waiting rather than stopped the hook", async () => {
    await startTarget();
    let released: (() => void) | undefined;
    const stuck = new Promise<void>((resolve) => {
      released = resolve;
    });

    const report = await runPlan(plan, {
      events,
      target: { baseUrl, request },
      hooks: { teardown: () => stuck },
      limits: { teardownTimeoutMs: 200 },
    });

    // The distinction matters: a reader whose process will not exit needs to
    // know the hook is still holding whatever it held.
    expect(report.cleanup.message).toContain("still running");
    expect(report.cleanup.message).toContain("cannot stop");

    released?.();
  });

  it("still reports everything the run actually did", async () => {
    await startTarget();
    let released: (() => void) | undefined;
    const stuck = new Promise<void>((resolve) => {
      released = resolve;
    });

    const report = await runPlan(plan, {
      events,
      target: { baseUrl, request },
      hooks: { teardown: () => stuck },
      limits: { teardownTimeoutMs: 200 },
      assertions: [{ name: "the target answered", check: () => {} }],
    });

    // Cleanup is the last thing that happens. Failing it must not erase the
    // deliveries and assertions that already succeeded - those are the answer
    // the run was asked for.
    expect(report.attempts).toHaveLength(1);
    expect(report.attempts[0]?.outcome).toMatchObject({ kind: "response", status: 200 });
    expect(report.assertions[0]?.status).toBe("passed");
    expect(report.harnessError).toBeUndefined();

    released?.();
  });

  it("fails the run, as a teardown that throws does, and says why", async () => {
    await startTarget();
    let released: (() => void) | undefined;
    const stuck = new Promise<void>((resolve) => {
      released = resolve;
    });

    const report = await runPlan(plan, {
      events,
      target: { baseUrl, request },
      hooks: { teardown: () => stuck },
      limits: { teardownTimeoutMs: 200 },
      assertions: [{ name: "the target answered", check: () => {} }],
    });

    // Every assertion is green, so the only thing standing between this run
    // and a pass is the hook it could not finish. A hook that overran holds
    // whatever it held - that is worse than one that threw, not better - and
    // the CI log is where a reader has to find out why the job then hangs.
    expect(report.passed).toBe(false);
    expect(formatReport(report)).toContain("teardown timed out");
    expect(() => assertRunPassed(report)).toThrow("still running");

    released?.();
  });
});

describe("a teardown that behaves", () => {
  it("is reported ok and is not delayed by the budget", async () => {
    await startTarget();
    let torn = false;

    const started = Date.now();
    const report = await runPlan(plan, {
      events,
      target: { baseUrl, request },
      hooks: { teardown: () => { torn = true; } },
      limits: { teardownTimeoutMs: 5_000 },
    });

    // A synchronous hook must not wait for a timer that is only there for the
    // hook that never returns.
    expect(report.cleanup.status).toBe("ok");
    expect(torn).toBe(true);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it("reports a teardown that throws as failed, not timed out", async () => {
    await startTarget();

    const report = await runPlan(plan, {
      events,
      target: { baseUrl, request },
      hooks: { teardown: () => { throw new Error("the container was already gone"); } },
      limits: { teardownTimeoutMs: 200 },
    });

    expect(report.cleanup.status).toBe("failed");
    expect(report.cleanup.message).toContain("already gone");
  });

  it("is skipped when there is nothing to tear down", async () => {
    await startTarget();

    const report = await runPlan(plan, { events, target: { baseUrl, request } });

    expect(report.cleanup.status).toBe("skipped");
  });

  it("is skipped when setup never completed", async () => {
    await startTarget();
    let torn = false;

    const report = await runPlan(plan, {
      events,
      target: { baseUrl, request },
      hooks: {
        setup: () => { throw new Error("the port was taken"); },
        teardown: () => { torn = true; },
      },
    });

    // Nothing was built, so there is nothing this hook owns. Running it would
    // ask it to dismantle a world that was never made.
    expect(report.cleanup.status).toBe("skipped");
    expect(report.cleanup.message).toContain("setup did not complete");
    expect(torn).toBe(false);
    expect(report.harnessError?.code).toBe("SetupFailed");
  });
});
