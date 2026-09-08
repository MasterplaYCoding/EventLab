import { describe, expect, it } from "vitest";

import { createPlan } from "../src/plan/createPlan.js";
import { runAssertions } from "../src/run/assertions.js";
import type { AssertionContext, EventFixture } from "../src/types.js";

const events: EventFixture[] = [{ id: "evt_a", body: {} }];
const context: AssertionContext = {
  plan: createPlan({ events, seed: 1 }),
  attempts: [],
};

describe("assertions", () => {
  it("records a passing check", async () => {
    const [report] = await runAssertions([{ name: "trivial", check: () => {} }], context);

    expect(report).toMatchObject({ name: "trivial", kind: "check", status: "passed" });
  });

  it("records a failing check with its message, not as a thrown error", async () => {
    const [report] = await runAssertions(
      [
        {
          name: "one fulfillment per order",
          check: () => {
            throw new Error("expected 1 fulfillment, found 2");
          },
        },
      ],
      context,
    );

    expect(report).toMatchObject({
      status: "failed",
      message: "expected 1 fulfillment, found 2",
    });
  });

  it("runs every assertion even after one fails", async () => {
    const reports = await runAssertions(
      [
        {
          name: "first",
          check: () => {
            throw new Error("nope");
          },
        },
        { name: "second", check: () => {} },
      ],
      context,
    );

    expect(reports.map((report) => report.status)).toEqual(["failed", "passed"]);
  });

  it("polls an eventually assertion until it succeeds", async () => {
    let observed = 0;

    const [report] = await runAssertions(
      [
        {
          name: "worker catches up",
          intervalMs: 5,
          eventually: () => {
            observed += 1;
            if (observed < 3) {
              throw new Error(`only ${observed} of 3 processed`);
            }
          },
        },
      ],
      context,
    );

    expect(report).toMatchObject({ status: "passed", kind: "eventually" });
    expect(report?.polls).toBe(3);
  });

  it("distinguishes a timed-out eventually from a failed check, and keeps the last reason", async () => {
    const [report] = await runAssertions(
      [
        {
          name: "never happens",
          timeoutMs: 40,
          intervalMs: 5,
          eventually: () => {
            throw new Error("outbox still empty");
          },
        },
      ],
      context,
    );

    expect(report?.status).toBe("timed-out");
    expect(report?.message).toContain("outbox still empty");
    expect(report?.polls).toBeGreaterThan(1);
  });
});
