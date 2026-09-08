import { describe, expect, it } from "vitest";

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
});
