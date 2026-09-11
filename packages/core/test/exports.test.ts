import { describe, expect, it } from "vitest";
import vm from "node:vm";

import { HarnessError, isHarnessError } from "../src/errors.js";
import { countDeliveries, deliveriesFor, summariseStatuses } from "../src/report/summary.js";
import { PLANNER_VERSION, REPORT_SCHEMA_VERSION } from "../src/version.js";
import { createPlan } from "../src/plan/createPlan.js";
import type { AttemptReport, DeliveryOutcome, RunReport } from "../src/types.js";

/**
 * The exports nothing referenced.
 *
 * Every symbol here is public, documented, and had no test naming it — the
 * state in which a function's behaviour is whatever it happens to be rather
 * than what it says it is. One of them was wrong.
 */

const events = [
  { id: "evt_a", body: { order: "ord_1" } },
  { id: "evt_b", body: { order: "ord_2" } },
];
const plan = createPlan({ scenario: "exports", events, seed: 1 });

function attempt(
  eventId: string,
  order: number,
  outcome: DeliveryOutcome,
  observedStartMs = order,
): AttemptReport {
  return {
    attemptId: `${eventId}#${order}`,
    eventId,
    copyIndex: order,
    order,
    intendedStartMs: 0,
    observedStartMs,
    durationMs: 1,
    request: { method: "POST", url: "http://127.0.0.1/webhooks", headerNames: [], bodyBytes: 4 },
    outcome,
  };
}

const responded = (status: number): DeliveryOutcome => ({
  kind: "response",
  status,
  bodyPreview: "",
  bodyTruncated: false,
});

function report(attempts: AttemptReport[]): RunReport {
  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    plannerVersion: PLANNER_VERSION,
    scenario: "exports",
    seed: 1,
    fixtureDigest: `sha256:${"0".repeat(64)}`,
    plan,
    limits: {
      requestTimeoutMs: 5000,
      scenarioTimeoutMs: 30000,
      maxResponseBodyBytes: 65536,
      teardownTimeoutMs: 5000,
    },
    startedAt: "2026-09-10T00:00:00.000Z",
    wallClockMs: 10,
    attempts,
    assertions: [],
    barriers: [],
    expectation: { deliveries: "all-2xx" },
    passed: true,
    cleanup: { status: "ok" },
    redaction: { requestBodies: "omitted", requestHeaders: "names-only" },
    reproduce: { note: "" },
  };
}

describe("deliveriesFor", () => {
  it("returns only the attempts for that logical event", () => {
    const subject = report([
      attempt("evt_a", 0, responded(200)),
      attempt("evt_b", 1, responded(200)),
      attempt("evt_a", 2, responded(409)),
    ]);

    expect(deliveriesFor(subject, "evt_a").map((a) => a.order)).toEqual([0, 2]);
    expect(deliveriesFor(subject, "evt_b").map((a) => a.order)).toEqual([1]);
  });

  it("preserves the report's observed order rather than re-sorting", () => {
    // runPlan sorts attempts by observed start before building the report, so
    // filtering is all this needs to do. If it ever sorted again by `order`,
    // it would quietly undo that and misrepresent what happened.
    const subject = report([
      attempt("evt_a", 5, responded(200), 10),
      attempt("evt_a", 1, responded(200), 20),
    ]);

    expect(deliveriesFor(subject, "evt_a").map((a) => a.order)).toEqual([5, 1]);
  });

  it("returns nothing for an event that was never delivered", () => {
    expect(deliveriesFor(report([]), "evt_missing")).toEqual([]);
  });
});

describe("countDeliveries", () => {
  it("counts attempts for one event, not events", () => {
    const subject = report([
      attempt("evt_a", 0, responded(200)),
      attempt("evt_a", 1, responded(200)),
      attempt("evt_a", 2, responded(500)),
      attempt("evt_b", 3, responded(200)),
    ]);

    // Three deliveries of one event. The whole premise of the library is that
    // this is the number people get wrong.
    expect(countDeliveries(subject, "evt_a")).toBe(3);
    expect(countDeliveries(subject, "evt_b")).toBe(1);
    expect(countDeliveries(subject, "evt_absent")).toBe(0);
  });

  it("counts a failed delivery as a delivery", () => {
    // It reached the application. Whether the response was 500 or a timeout is
    // a separate question from whether the request arrived.
    const subject = report([
      attempt("evt_a", 0, responded(500)),
      attempt("evt_a", 1, { kind: "timeout", afterMs: 5000 }),
    ]);

    expect(countDeliveries(subject, "evt_a")).toBe(2);
  });
});

describe("summariseStatuses", () => {
  it("counts response statuses by code", () => {
    const subject = report([
      attempt("evt_a", 0, responded(200)),
      attempt("evt_a", 1, responded(200)),
      attempt("evt_b", 2, responded(409)),
    ]);

    expect(summariseStatuses(subject)).toEqual({ "200": 2, "409": 1 });
  });

  it("keeps transport failures as their own buckets", () => {
    // A timeout is not a status code, and folding it into one would invent a
    // response the server never sent — the exact claim docs/decisions/002
    // exists to refuse.
    const subject = report([
      attempt("evt_a", 0, responded(200)),
      attempt("evt_a", 1, { kind: "timeout", afterMs: 5000 }),
      attempt("evt_b", 2, { kind: "transport-error", message: "ECONNRESET" }),
    ]);

    expect(summariseStatuses(subject)).toEqual({
      "200": 1,
      timeout: 1,
      "transport-error": 1,
    });
  });

  it("returns an empty summary for a run with no attempts", () => {
    expect(summariseStatuses(report([]))).toEqual({});
  });
});

describe("isHarnessError", () => {
  it("recognises a HarnessError", () => {
    expect(isHarnessError(new HarnessError("InvalidPlan", "no"))).toBe(true);
  });

  it("rejects an ordinary error and non-errors", () => {
    expect(isHarnessError(new Error("ordinary"))).toBe(false);
    expect(isHarnessError("HarnessError")).toBe(false);
    expect(isHarnessError(null)).toBe(false);
    expect(isHarnessError(undefined)).toBe(false);
    expect(isHarnessError({ name: "HarnessError", code: "InvalidPlan" })).toBe(false);
  });

  it("rejects an error that only borrowed the name", () => {
    const impostor = new Error("not ours");
    impostor.name = "HarnessError";

    // No code, so it is something else wearing the name.
    expect(isHarnessError(impostor)).toBe(false);
  });

  it("recognises a HarnessError thrown in another realm", () => {
    // The documented promise, and what the previous implementation broke:
    // `instanceof Error` compares against this realm's Error constructor, so
    // an error crossing a vm boundary failed the check however genuine it was.
    // A scenario module is free to run the application under test inside one.
    const context = vm.createContext({});
    const foreign = vm.runInContext(
      `const e = new Error("blocked"); e.name = "HarnessError"; e.code = "RemoteTargetBlocked"; e;`,
      context,
    ) as unknown;

    expect(foreign instanceof Error).toBe(false);
    expect(isHarnessError(foreign)).toBe(true);
  });
});

describe("version constants", () => {
  it("are the values a saved plan and a report are checked against", () => {
    // Strings, not numbers: they appear in serialised reports, and a schema
    // version that changes type between releases is worse than one that
    // changes value.
    expect(typeof PLANNER_VERSION).toBe("string");
    expect(typeof REPORT_SCHEMA_VERSION).toBe("string");
    expect(PLANNER_VERSION).toMatch(/^\d+$/);
    expect(REPORT_SCHEMA_VERSION).toMatch(/^\d+$/);
  });

  it("are what createPlan stamps into a plan", () => {
    expect(plan.plannerVersion).toBe(PLANNER_VERSION);
  });
});
