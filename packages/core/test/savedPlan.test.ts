import { describe, expect, it } from "vitest";

import { HarnessError } from "../src/errors.js";
import { createPlan } from "../src/plan/createPlan.js";
import { duplicate, shuffle } from "../src/plan/transforms.js";
import { assertFixturesMatch, parsePlan, serializePlan } from "../src/plan/savedPlan.js";
import type { EventFixture } from "../src/types.js";

const events: EventFixture[] = [
  { id: "evt_a", body: { amount: 100 } },
  { id: "evt_b", body: { amount: 250 } },
];

const plan = createPlan({
  scenario: "saved",
  events,
  seed: 99,
  transforms: [duplicate({ copies: 2 }), shuffle()],
});

describe("saved plans", () => {
  it("round-trips without changing a single instruction", () => {
    expect(parsePlan(serializePlan(plan))).toEqual(plan);
  });

  it("never embeds fixture bodies", () => {
    expect(serializePlan(plan)).not.toContain("250");
  });

  it("accepts fixtures whose digest still matches", () => {
    expect(() => assertFixturesMatch(plan, events)).not.toThrow();
  });

  it("refuses to replay against edited fixtures", () => {
    const edited: EventFixture[] = [events[0]!, { id: "evt_b", body: { amount: 999 } }];

    expect(() => assertFixturesMatch(plan, edited)).toThrow(/fixtures have changed/);
  });

  it("refuses to replay when a referenced fixture is gone", () => {
    // Rebuild a plan over one event, then hand replay a differently named one:
    // the digest check fires first, which is the honest error either way.
    const single = createPlan({ events: [events[0]!], seed: 1 });
    expect(() => assertFixturesMatch(single, [{ id: "evt_z", body: { amount: 100 } }])).toThrow(
      /fixtures have changed/,
    );
  });

  it("rejects a plan built by a different planner version", () => {
    const stale = JSON.parse(serializePlan(plan)) as Record<string, unknown>;
    stale.plannerVersion = "0";

    expect(() => parsePlan(JSON.stringify(stale))).toThrow(/planner version/);
  });

  it("rejects structurally invalid plans instead of executing them", () => {
    expect(() => parsePlan("not json")).toThrow(/valid JSON/);
    expect(() => parsePlan("{}")).toThrow(/plannerVersion/);
    expect(() => parsePlan(JSON.stringify({ ...plan, attempts: [] }))).toThrow(/no attempts/);
    expect(() =>
      parsePlan(
        JSON.stringify({
          ...plan,
          attempts: [plan.attempts[0], plan.attempts[0]],
        }),
      ),
    ).toThrow(/duplicate attempt id/);
  });

  /** The plan as JSON text, with `edit` applied to its parsed form. */
  const editedPlan = (edit: (tree: Record<string, any>) => void, raw?: (text: string) => string) => {
    const tree = JSON.parse(serializePlan(plan)) as Record<string, any>;
    edit(tree);
    const text = JSON.stringify(tree);
    return raw === undefined ? text : raw(text);
  };

  it("refuses a plan without barriers, which replay used to crash on", () => {
    // Found by savedPlanFuzz.test.ts. parsePlan treated `barriers` as
    // optional; runPlan reads it unconditionally, so the plan was accepted and
    // the replay ended in an "Unknown" harness error - a crash, reported as
    // one, instead of a refusal naming the field.
    expect(() => parsePlan(editedPlan((tree) => delete tree.barriers))).toThrow(/barriers must be an array/);
  });

  it("refuses a concurrency createPlan would never have produced", () => {
    // 1e999 is valid JSON for Infinity: JSON.stringify can never write it, and
    // a hand-edited file easily can. It used to pass `>= 1` and run unbounded.
    const infinite = editedPlan((tree) => (tree.concurrency = 7), (text) => text.replace('"concurrency":7', '"concurrency":1e999'));
    expect(JSON.parse(infinite).concurrency).toBe(Infinity);
    expect(() => parsePlan(infinite)).toThrow(/concurrency must be a positive integer/);
    expect(() => parsePlan(editedPlan((tree) => (tree.concurrency = 1.5)))).toThrow(/positive integer/);
  });

  it("refuses attempt fields the scheduler sorts and groups on, when they are not integers", () => {
    for (const field of ["phase", "order", "copyIndex"]) {
      expect(() => parsePlan(editedPlan((tree) => (tree.attempts[0][field] = "")))).toThrow(
        new RegExp(`${field} must be a non-negative integer`),
      );
      expect(() => parsePlan(editedPlan((tree) => (tree.attempts[0][field] = -1)))).toThrow(HarnessError);
    }
  });

  it("refuses transforms that are not records, and a checkpoint that is not a hook name", () => {
    expect(() => parsePlan(editedPlan((tree) => (tree.transforms = "duplicate")))).toThrow(/transforms must be an array/);
    expect(() => parsePlan(editedPlan((tree) => (tree.transforms = [{ kind: "shuffle", options: [] }])))).toThrow(
      /kind and an options object/,
    );
    expect(() =>
      parsePlan(editedPlan((tree) => (tree.barriers = [{ name: "b", afterPhase: 0, checkpoint: 5 }]))),
    ).toThrow(/checkpoint must be a hook name/);
  });
});
