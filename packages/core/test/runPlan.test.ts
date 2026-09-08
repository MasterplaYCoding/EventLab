import { afterEach, describe, expect, it } from "vitest";

import { createPlan } from "../src/plan/createPlan.js";
import { burst, duplicate } from "../src/plan/transforms.js";
import { runPlan } from "../src/run/runPlan.js";
import type { EventFixture, HttpTarget } from "../src/types.js";
import { startTestServer, type TestServer } from "./support/testServer.js";

const events: EventFixture[] = [
  { id: "evt_a", body: { order: "ord_1" } },
  { id: "evt_b", body: { order: "ord_2" } },
];

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function targetFor(baseUrl: string, path = "/webhooks"): HttpTarget {
  return {
    baseUrl,
    request: ({ event }) => ({
      method: "POST",
      path,
      headers: { "content-type": "application/json", authorization: "Bearer super-secret" },
      body: JSON.stringify(event.body),
    }),
  };
}

describe("runPlan", () => {
  it("delivers every planned attempt and reports both timings", async () => {
    server = await startTestServer((_request, response) => {
      response.statusCode = 200;
      response.end("ok");
    });

    const plan = createPlan({ events, seed: 1, transforms: [duplicate({ copies: 2 })] });
    const report = await runPlan(plan, { events, target: targetFor(server.baseUrl) });

    expect(report.passed).toBe(true);
    expect(report.attempts).toHaveLength(4);
    expect(server.requests).toHaveLength(4);
    for (const attempt of report.attempts) {
      expect(attempt.intendedStartMs).toBe(0);
      expect(attempt.observedStartMs).toBeGreaterThanOrEqual(0);
      expect(attempt.outcome).toMatchObject({ kind: "response", status: 200 });
    }
  });

  it("sends the request body through unchanged", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));

    const unicode: EventFixture[] = [{ id: "evt_u", body: { note: "héllo — ünïcode ✅" } }];
    const plan = createPlan({ events: unicode, seed: 1 });
    await runPlan(plan, { events: unicode, target: targetFor(server.baseUrl) });

    expect(server.requests[0]?.body).toBe(JSON.stringify(unicode[0]!.body));
  });

  it("keeps secrets out of the report", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));

    const plan = createPlan({ events, seed: 1 });
    const report = await runPlan(plan, { events, target: targetFor(server.baseUrl) });

    expect(JSON.stringify(report)).not.toContain("super-secret");
    expect(report.attempts[0]?.request.headerNames).toEqual(["authorization", "content-type"]);
    expect(report.redaction).toEqual({ requestBodies: "omitted", requestHeaders: "names-only" });
  });

  it("honours the concurrency limit", async () => {
    server = await startTestServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      response.end("ok");
    });

    const plan = createPlan({
      events,
      seed: 5,
      concurrency: 2,
      transforms: [duplicate({ copies: 4 }), burst()],
    });
    const report = await runPlan(plan, { events, target: targetFor(server.baseUrl) });

    expect(report.attempts).toHaveLength(8);
    expect(server.peakConcurrency()).toBeLessThanOrEqual(2);
  });

  it("releases same-instant attempts in plan order", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));

    const plan = createPlan({
      events,
      seed: 5,
      concurrency: 1,
      transforms: [duplicate({ copies: 2 }), burst()],
    });
    const report = await runPlan(plan, { events, target: targetFor(server.baseUrl) });

    expect(report.attempts.map((attempt) => attempt.attemptId)).toEqual(
      plan.attempts.map((attempt) => attempt.attemptId),
    );
  });

  it("reports non-2xx responses as a failed expectation, not as an error", async () => {
    server = await startTestServer((_request, response) => {
      response.statusCode = 409;
      response.end("conflict");
    });

    const plan = createPlan({ events, seed: 1 });
    const report = await runPlan(plan, { events, target: targetFor(server.baseUrl) });

    expect(report.passed).toBe(false);
    expect(report.harnessError).toBeUndefined();
    expect(report.attempts[0]?.outcome).toMatchObject({ kind: "response", status: 409 });
  });

  it("accepts declared transport failures when the scenario opts in", async () => {
    server = await startTestServer((_request, response) => {
      response.statusCode = 429;
      response.end("slow down");
    });

    const plan = createPlan({ events, seed: 1 });
    const report = await runPlan(plan, {
      events,
      target: targetFor(server.baseUrl),
      expect: { deliveries: "declared" },
    });

    expect(report.passed).toBe(true);
  });

  it("records redirects instead of following them", async () => {
    server = await startTestServer((_request, response) => {
      response.statusCode = 302;
      response.setHeader("location", "/elsewhere");
      response.end();
    });

    const plan = createPlan({ events: [events[0]!], seed: 1 });
    const report = await runPlan(plan, {
      events: [events[0]!],
      target: targetFor(server.baseUrl),
      expect: { deliveries: "declared" },
    });

    expect(report.attempts[0]?.outcome).toMatchObject({ kind: "response", status: 302 });
    expect(server.requests).toHaveLength(1);
  });

  it("reports a slow response as a timeout, not as a failed write", async () => {
    server = await startTestServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      response.end("late");
    });

    const plan = createPlan({ events: [events[0]!], seed: 1 });
    const report = await runPlan(plan, {
      events: [events[0]!],
      target: targetFor(server.baseUrl),
      limits: { requestTimeoutMs: 60 },
      expect: { deliveries: "declared" },
    });

    expect(report.attempts[0]?.outcome.kind).toBe("timeout");
    // The server did receive it. A timeout says nothing about the far side.
    expect(server.requests).toHaveLength(1);
  });

  it("reports a refused connection as a transport error", async () => {
    const closed = await startTestServer((_request, response) => response.end());
    const baseUrl = closed.baseUrl;
    await closed.close();

    const plan = createPlan({ events: [events[0]!], seed: 1 });
    const report = await runPlan(plan, {
      events: [events[0]!],
      target: targetFor(baseUrl),
      expect: { deliveries: "declared" },
    });

    expect(report.attempts[0]?.outcome.kind).toBe("transport-error");
  });

  it("truncates a large response body and says so", async () => {
    server = await startTestServer((_request, response) => response.end("x".repeat(5_000)));

    const plan = createPlan({ events: [events[0]!], seed: 1 });
    const report = await runPlan(plan, {
      events: [events[0]!],
      target: targetFor(server.baseUrl),
      limits: { maxResponseBodyBytes: 100 },
    });

    const outcome = report.attempts[0]?.outcome;
    expect(outcome).toMatchObject({ kind: "response", bodyTruncated: true });
    expect(outcome?.kind === "response" && outcome.bodyPreview).toHaveLength(100);
  });

  it("resolves paths against a base URL that has its own prefix", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));

    const plan = createPlan({ events: [events[0]!], seed: 1 });
    await runPlan(plan, {
      events: [events[0]!],
      target: targetFor(`${server.baseUrl}/api/v2`, "/hooks"),
    });

    expect(server.requests[0]?.url).toBe("/api/v2/hooks");
  });
});

describe("runPlan failure handling", () => {
  it("refuses a non-loopback target unless asked twice", async () => {
    const plan = createPlan({ events, seed: 1 });
    const report = await runPlan(plan, { events, target: targetFor("https://example.com") });

    expect(report.passed).toBe(false);
    expect(report.harnessError?.code).toBe("RemoteTargetBlocked");
  });

  it("refuses to run against fixtures that no longer match the plan", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));

    const plan = createPlan({ events, seed: 1 });
    const report = await runPlan(plan, {
      events: [{ id: "evt_a", body: { order: "changed" } }, events[1]!],
      target: targetFor(server.baseUrl),
    });

    expect(report.harnessError?.code).toBe("FixtureDigestMismatch");
    expect(report.attempts).toHaveLength(0);
  });

  it("reports a failing setup as a harness error and skips teardown", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));
    let torndown = false;

    const plan = createPlan({ events, seed: 1 });
    const report = await runPlan(plan, {
      events,
      target: targetFor(server.baseUrl),
      hooks: {
        setup: () => {
          throw new Error("database unavailable");
        },
        teardown: () => {
          torndown = true;
        },
      },
    });

    expect(report.harnessError?.code).toBe("SetupFailed");
    expect(report.cleanup).toEqual({ status: "skipped", message: "setup did not complete" });
    expect(torndown).toBe(false);
  });

  it("still runs teardown when delivery fails", async () => {
    let torndown = false;
    const plan = createPlan({ events, seed: 1 });

    const report = await runPlan(plan, {
      events,
      target: targetFor("http://127.0.0.1:1"),
      hooks: {
        setup: () => {},
        teardown: () => {
          torndown = true;
        },
      },
      expect: { deliveries: "declared" },
    });

    expect(torndown).toBe(true);
    expect(report.cleanup.status).toBe("ok");
  });

  it("reports a failing teardown separately from the run result", async () => {
    server = await startTestServer((_request, response) => response.end("ok"));

    const plan = createPlan({ events, seed: 1 });
    const report = await runPlan(plan, {
      events,
      target: targetFor(server.baseUrl),
      hooks: {
        teardown: () => {
          throw new Error("could not drop schema");
        },
      },
    });

    expect(report.harnessError).toBeUndefined();
    expect(report.cleanup).toEqual({ status: "failed", message: "could not drop schema" });
    expect(report.passed).toBe(false);
  });

  it("stops releasing attempts on cancellation but still tears down", async () => {
    server = await startTestServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      response.end("ok");
    });

    const controller = new AbortController();
    let torndown = false;

    const plan = createPlan({
      events,
      seed: 1,
      concurrency: 1,
      transforms: [duplicate({ copies: 10 }), burst()],
    });
    setTimeout(() => controller.abort(), 40);

    const report = await runPlan(plan, {
      events,
      target: targetFor(server.baseUrl),
      signal: controller.signal,
      hooks: {
        teardown: () => {
          torndown = true;
        },
      },
    });

    expect(report.harnessError?.code).toBe("Cancelled");
    expect(report.attempts.length).toBeLessThan(20);
    expect(torndown).toBe(true);
  });

  it("fails the scenario when it exceeds its overall budget", async () => {
    server = await startTestServer(async (_request, response) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      response.end("ok");
    });

    const plan = createPlan({
      events,
      seed: 1,
      concurrency: 1,
      transforms: [duplicate({ copies: 6 }), burst()],
    });
    const report = await runPlan(plan, {
      events,
      target: targetFor(server.baseUrl),
      limits: { scenarioTimeoutMs: 120 },
    });

    expect(report.harnessError?.code).toBe("ScenarioTimeout");
    expect(report.limits.scenarioTimeoutMs).toBe(120);
  });
});
