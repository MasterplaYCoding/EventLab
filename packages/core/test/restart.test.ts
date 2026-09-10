import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createPlan } from "../src/plan/createPlan.js";
import { runPlan } from "../src/run/runPlan.js";
import { duplicate } from "../src/plan/transforms.js";

/**
 * Restarting the application under test, mid-scenario.
 *
 * A barrier already provides the quiet moment to do it in, and a checkpoint
 * already runs arbitrary code there. What was missing was smaller and more
 * fundamental: the base URL was resolved once, before the first delivery, so a
 * process that came back on a fresh ephemeral port could not be reached
 * afterwards. Everything here exists because of that one line.
 */

const events = [
  { id: "evt_a", body: { order: "ord_1" } },
  { id: "evt_b", body: { order: "ord_2" } },
];

/** An application that can be stopped and started again on a new port. */
class Restartable {
  private server: Server | undefined;
  /** Every request this process instance has seen, by port. */
  readonly seen: Array<{ port: number; path: string }> = [];
  starts = 0;

  async start(): Promise<void> {
    this.starts += 1;
    const server = createServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        this.seen.push({ port: this.port(), path: request.url ?? "" });
        response.statusCode = 200;
        response.end("{}");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.server = server;
  }

  port(): number {
    if (this.server === undefined) throw new Error("not started");
    return (this.server.address() as AddressInfo).port;
  }

  baseUrl(): string {
    return `http://127.0.0.1:${this.port()}`;
  }

  async stop(): Promise<void> {
    const closing = this.server;
    this.server = undefined;
    if (closing === undefined) return;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
}

const app = new Restartable();

afterEach(async () => {
  await app.stop();
});

const request = () => ({
  method: "POST" as const,
  path: "/webhooks",
  headers: { "content-type": "application/json" },
  body: "{}",
});

describe("a target that restarts between phases", () => {
  it("delivers to the port the application came back on", async () => {
    await app.start();
    const firstPort = app.port();

    const plan = createPlan({
      scenario: "restart between phases",
      events,
      seed: 7,
      phases: [
        { deliver: ["evt_a"] },
        { barrier: "restarted", checkpoint: "restart" },
        { deliver: ["evt_b"] },
      ],
    });

    const report = await runPlan(plan, {
      events,
      target: { baseUrl: () => app.baseUrl(), request },
      hooks: {
        checkpoints: {
          restart: async () => {
            await app.stop();
            await app.start();
          },
        },
      },
    });

    const secondPort = app.port();

    expect(report.harnessError).toBeUndefined();
    expect(app.starts).toBe(2);
    expect(secondPort).not.toBe(firstPort);

    // The evidence: deliveries landed on both ports, in phase order.
    const ports = report.attempts.map((attempt) => new URL(attempt.request.url).port);
    expect(ports).toEqual([String(firstPort), String(secondPort)]);
    expect(report.passed).toBe(true);
  });

  it("still works when baseUrl is a plain string", async () => {
    // The overwhelmingly common case, and the one that must not have been made
    // more complicated by any of this.
    await app.start();

    const plan = createPlan({ scenario: "static target", events, seed: 7 });
    const report = await runPlan(plan, {
      events,
      target: { baseUrl: app.baseUrl(), request },
    });

    expect(report.harnessError).toBeUndefined();
    expect(report.attempts).toHaveLength(2);
  });

  it("resolves the address once per phase, not once per attempt", async () => {
    // Within a phase, deliveries are concurrent and must all reach the same
    // process. A per-attempt resolution would let them straddle a restart.
    await app.start();
    let resolutions = 0;

    const plan = createPlan({
      scenario: "resolution count",
      events,
      seed: 7,
      phases: [
        { deliver: ["evt_a"], transforms: [duplicate({ copies: 4 })] },
        { barrier: "midpoint" },
        { deliver: ["evt_b"], transforms: [duplicate({ copies: 4 })] },
      ],
    });

    const report = await runPlan(plan, {
      events,
      target: {
        baseUrl: () => {
          resolutions += 1;
          return app.baseUrl();
        },
        request,
      },
    });

    expect(report.attempts).toHaveLength(8);
    // Once before setup, once after the barrier. Not eight times.
    expect(resolutions).toBe(2);
  });
});

describe("a restart that goes wrong", () => {
  it("reports a harness error when the application comes back unreachable", async () => {
    await app.start();
    let restarted = false;

    const plan = createPlan({
      scenario: "bad restart",
      events,
      seed: 7,
      phases: [
        { deliver: ["evt_a"] },
        { barrier: "restarted", checkpoint: "restart" },
        { deliver: ["evt_b"] },
      ],
    });

    const report = await runPlan(plan, {
      events,
      target: { baseUrl: () => (restarted ? "not a url" : app.baseUrl()), request },
      hooks: { checkpoints: { restart: () => { restarted = true; } } },
    });

    // A broken experiment, not a failing application. The distinction is the
    // whole reason harnessError exists.
    expect(report.harnessError?.code).toBe("InvalidTarget");
    expect(report.passed).toBe(false);
    // The first phase still happened and is still reported.
    expect(report.attempts).toHaveLength(1);
  });

  it("refuses a restart that moves the target off loopback", async () => {
    await app.start();
    let restarted = false;

    const plan = createPlan({
      scenario: "escaping restart",
      events,
      seed: 7,
      phases: [
        { deliver: ["evt_a"] },
        { barrier: "restarted", checkpoint: "restart" },
        { deliver: ["evt_b"] },
      ],
    });

    const report = await runPlan(plan, {
      events,
      target: {
        baseUrl: () => (restarted ? "https://example.com" : app.baseUrl()),
        request,
      },
      hooks: { checkpoints: { restart: () => { restarted = true; } } },
    });

    // The loopback guard runs on every resolution. Checking only the first
    // address would make the restart hook a way around it.
    expect(report.harnessError?.code).toBe("RemoteTargetBlocked");
  });

  it("reports a baseUrl function that throws as a harness error", async () => {
    const plan = createPlan({ scenario: "throwing target", events, seed: 7 });

    const report = await runPlan(plan, {
      events,
      target: {
        baseUrl: () => {
          throw new Error("the application did not come back");
        },
        request,
      },
    });

    expect(report.harnessError?.code).toBe("InvalidTarget");
    expect(report.harnessError?.message).toContain("did not come back");
    expect(report.attempts).toHaveLength(0);
  });
});
