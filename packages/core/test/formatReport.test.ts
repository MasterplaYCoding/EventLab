import { describe, expect, it } from "vitest";

import { assertRunPassed, formatReport } from "../src/report/format.js";
import { createPlan } from "../src/plan/createPlan.js";
import type {
  AssertionReport,
  AttemptReport,
  DeliveryOutcome,
  RunReport,
} from "../src/types.js";

const events = [{ id: "evt_a", body: { order: "ord_1" } }];
const plan = createPlan({ scenario: "example", events, seed: 20260908 });

function attempt(index: number, outcome: DeliveryOutcome): AttemptReport {
  return {
    attemptId: `evt_a#${index}`,
    eventId: "evt_a",
    copyIndex: index,
    order: index,
    intendedStartMs: 0,
    observedStartMs: 0,
    durationMs: 1,
    request: { method: "POST", url: "http://127.0.0.1/webhooks", headerNames: [], bodyBytes: 10 },
    outcome,
  };
}

const ok = (index: number, status = 200): AttemptReport =>
  attempt(index, { kind: "response", status, bodyPreview: "", bodyTruncated: false });

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    reportSchemaVersion: "2",
    plannerVersion: "2",
    scenario: "example",
    seed: 20260908,
    fixtureDigest: "sha256:8f2bcafe000000000000000000000000000000000000000000000000000000ff",
    plan,
    limits: { requestTimeoutMs: 5000, scenarioTimeoutMs: 30000, maxResponseBodyBytes: 65536 },
    startedAt: "2026-09-08T00:00:00.000Z",
    wallClockMs: 42,
    attempts: [],
    assertions: [],
    barriers: [],
    expectation: { deliveries: "all-2xx" },
    passed: true,
    cleanup: { status: "ok" },
    redaction: { requestBodies: "omitted", requestHeaders: "names-only" },
    reproduce: { note: "" },
    ...overrides,
  };
}

const passing = (name: string): AssertionReport => ({
  name,
  kind: "check",
  status: "passed",
  durationMs: 1,
});

const failing = (name: string, message: string): AssertionReport => ({
  name,
  kind: "check",
  status: "failed",
  durationMs: 1,
  message,
});

describe("formatReport", () => {
  it("renders the block the README prints", () => {
    const rendered = formatReport(
      report({
        attempts: Array.from({ length: 9 }, (_unused, index) => ok(index)),
        assertions: [
          failing("each order is fulfilled exactly once", "expected 2 fulfilment writes, found 3"),
        ],
        passed: false,
      }),
    );

    expect(rendered).toBe(
      [
        "✗ each order is fulfilled exactly once",
        "  expected 2 fulfilment writes, found 3",
        "",
        "  9 deliveries, all 200 OK",
        "  seed 20260908 · planner 2 · fixtures sha256:8f2b…",
      ].join("\n"),
    );
  });

  it("renders a passing run", () => {
    const rendered = formatReport(
      report({ attempts: [ok(0)], assertions: [passing("one fulfillment per order")] }),
    );

    expect(rendered).toContain("✓ one fulfillment per order");
    expect(rendered).toContain("1 delivery, all 200 OK");
  });

  it("keeps a timed-out assertion distinct from a failed one", () => {
    const rendered = formatReport(
      report({
        attempts: [ok(0)],
        passed: false,
        assertions: [
          {
            name: "the outbox drains",
            kind: "eventually",
            status: "timed-out",
            durationMs: 2000,
            polls: 40,
            message: "still failing after 2000ms and 40 polls: 3 notifications still pending",
          },
        ],
      }),
    );

    expect(rendered).toContain("✗ the outbox drains");
    expect(rendered).toContain("still failing after 2000ms");
  });

  it("breaks down mixed statuses and transport failures, ordered stably", () => {
    const rendered = formatReport(
      report({
        expectation: { deliveries: "declared" },
        attempts: [
          ok(0, 409),
          ok(1),
          ok(2),
          attempt(3, { kind: "timeout", afterMs: 5000 }),
          attempt(4, { kind: "transport-error", message: "ECONNREFUSED" }),
        ],
      }),
    );

    expect(rendered).toContain("5 deliveries: 2×200, 1×409, 1 timeout, 1 transport-error");
  });

  it("says when the delivery expectation is why the run failed", () => {
    const rendered = formatReport(
      report({
        attempts: [ok(0, 500)],
        assertions: [passing("state is unchanged")],
        passed: false,
      }),
    );

    // Without this the run reads as entirely healthy while reporting failure.
    expect(rendered).toContain("expected all 2xx");
  });

  it("does not claim an expectation problem when assertions are the cause", () => {
    const rendered = formatReport(
      report({
        attempts: [ok(0)],
        assertions: [failing("invariant", "nope")],
        passed: false,
      }),
    );

    expect(rendered).not.toContain("expected all 2xx");
  });

  it("reports a harness error instead of assertions that never ran", () => {
    const rendered = formatReport(
      report({
        passed: false,
        assertions: [],
        harnessError: {
          code: "RemoteTargetBlocked",
          message: 'refusing to deliver to non-loopback host "example.com"',
          at: "target.baseUrl",
        },
      }),
    );

    expect(rendered).toContain("⚠ harness error: RemoteTargetBlocked");
    expect(rendered).toContain("at target.baseUrl");
    expect(rendered).toContain("no deliveries executed");
    expect(rendered).toContain("not a failure of the application under test");
  });

  it("surfaces a cleanup failure, which is otherwise invisible", () => {
    const rendered = formatReport(
      report({
        attempts: [ok(0)],
        assertions: [passing("invariant")],
        passed: false,
        cleanup: { status: "failed", message: "could not drop schema" },
      }),
    );

    expect(rendered).toContain("teardown failed: could not drop schema");
  });

  it("surfaces a teardown that timed out, the reason a process will not exit", () => {
    const rendered = formatReport(
      report({
        attempts: [ok(0)],
        assertions: [passing("invariant")],
        passed: false,
        cleanup: { status: "timed-out", message: "teardown did not finish within 5000ms" },
      }),
    );

    expect(rendered).toContain("teardown timed out: teardown did not finish within 5000ms");
  });

  it("still surfaces a teardown problem after a harness error", () => {
    // The harness error explains the verdict; the teardown line explains the
    // hang that follows it. Dropping either leaves the reader guessing.
    const rendered = formatReport(
      report({
        passed: false,
        harnessError: { code: "ScenarioTimeout", message: "the run exceeded 30000ms" },
        cleanup: { status: "timed-out", message: "teardown did not finish within 5000ms" },
      }),
    );

    expect(rendered).toContain("⚠ harness error: ScenarioTimeout");
    expect(rendered).toContain("teardown timed out");
  });

  it("says so when a scenario declared no assertions", () => {
    expect(formatReport(report({ attempts: [ok(0)] }))).toContain("no assertions declared");
  });

  it("indents every line of a multi-line assertion message", () => {
    const rendered = formatReport(
      report({
        attempts: [ok(0)],
        passed: false,
        assertions: [failing("invariant", "first line\nsecond line")],
      }),
    );

    expect(rendered).toContain("  first line\n  second line");
  });

  it("omits timings by default so the output can be asserted on", () => {
    expect(formatReport(report({ attempts: [ok(0)] }))).not.toContain("42ms");
    expect(formatReport(report({ attempts: [ok(0)] }), { timings: true })).toContain("42ms");
  });

  it("honours digestChars", () => {
    expect(formatReport(report(), { digestChars: 8 })).toContain("sha256:8f2bcafe…");
  });
});

describe("assertRunPassed", () => {
  it("does nothing when the run passed", () => {
    expect(() => assertRunPassed(report({ attempts: [ok(0)] }))).not.toThrow();
  });

  it("throws with the formatted report, not just a boolean", () => {
    const failed = report({
      attempts: [ok(0)],
      passed: false,
      assertions: [failing("each order is fulfilled exactly once", "found 3")],
    });

    // The whole point: a runner shows this message instead of
    // "expected false to be true".
    expect(() => assertRunPassed(failed)).toThrow(/each order is fulfilled exactly once/);
    expect(() => assertRunPassed(failed)).toThrow(/found 3/);
  });

  it("surfaces a harness error, the case that is hardest to debug blind", () => {
    const failed = report({
      passed: false,
      harnessError: { code: "RemoteTargetBlocked", message: "not loopback" },
    });

    expect(() => assertRunPassed(failed)).toThrow(/RemoteTargetBlocked/);
  });
});
