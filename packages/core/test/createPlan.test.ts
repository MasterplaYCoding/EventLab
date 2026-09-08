import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createPlan } from "../src/plan/createPlan.js";
import { burst, delay, duplicate, shuffle } from "../src/plan/transforms.js";
import { HarnessError } from "../src/errors.js";
import { PLANNER_VERSION } from "../src/version.js";
import type { EventFixture } from "../src/types.js";
import { propertyConfig } from "./support/property.js";

const events: EventFixture[] = [
  { id: "evt_a", body: { order: "ord_1", version: 1 } },
  { id: "evt_b", body: { order: "ord_1", version: 2 } },
  { id: "evt_c", body: { order: "ord_2", version: 1 } },
];

describe("createPlan", () => {
  it("records provenance so a plan explains where it came from", () => {
    const plan = createPlan({ scenario: "duplicates", events, seed: 42 });

    expect(plan.plannerVersion).toBe(PLANNER_VERSION);
    expect(plan.scenario).toBe("duplicates");
    expect(plan.seed).toBe(42);
    expect(plan.fixtureDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(plan.attempts).toHaveLength(events.length);
  });

  it("digests fixtures by structure, not by literal key order", () => {
    const a = createPlan({ events: [{ id: "e", body: { x: 1, y: 2 } }], seed: 1 });
    const b = createPlan({ events: [{ id: "e", body: { y: 2, x: 1 } }], seed: 1 });

    expect(a.fixtureDigest).toBe(b.fixtureDigest);
  });

  it("applies transforms in declaration order", () => {
    // burst() after delay() flattens the delays; the reverse order keeps them.
    const flattened = createPlan({
      events,
      seed: 7,
      transforms: [delay({ minMs: 10, maxMs: 50 }), burst()],
    });
    const kept = createPlan({
      events,
      seed: 7,
      transforms: [burst(), delay({ minMs: 10, maxMs: 50 })],
    });

    expect(flattened.attempts.every((attempt) => attempt.delayMs === 0)).toBe(true);
    expect(kept.attempts.every((attempt) => attempt.delayMs >= 10)).toBe(true);
    expect(flattened.transforms.map((record) => record.kind)).toEqual(["delay", "burst"]);
  });

  it("keeps the logical event id on every duplicate and gives each a unique attempt id", () => {
    const plan = createPlan({ events, seed: 3, transforms: [duplicate({ copies: 3 })] });

    expect(plan.attempts).toHaveLength(events.length * 3);
    expect(new Set(plan.attempts.map((attempt) => attempt.attemptId)).size).toBe(
      plan.attempts.length,
    );
    for (const event of events) {
      const forEvent = plan.attempts.filter((attempt) => attempt.eventId === event.id);
      expect(forEvent).toHaveLength(3);
      expect(forEvent.map((attempt) => attempt.copyIndex).sort()).toEqual([0, 1, 2]);
    }
  });

  it("numbers plan order contiguously from zero", () => {
    const plan = createPlan({
      events,
      seed: 11,
      transforms: [duplicate({ copies: 2 }), shuffle()],
    });

    expect(plan.attempts.map((attempt) => attempt.order)).toEqual(
      plan.attempts.map((_unused, index) => index),
    );
  });

  describe("validation happens before anything is executed", () => {
    it("rejects duplicate event ids", () => {
      expect(() =>
        createPlan({ events: [{ id: "e", body: {} }, { id: "e", body: {} }], seed: 1 }),
      ).toThrow(HarnessError);
    });

    it('rejects "#" in event ids, because attempt ids are eventId#copyIndex', () => {
      expect(() => createPlan({ events: [{ id: "a#b", body: {} }], seed: 1 })).toThrow(
        /must not contain/,
      );
    });

    it("rejects an empty scenario", () => {
      expect(() => createPlan({ events: [], seed: 1 })).toThrow(/at least one event/);
    });

    it("rejects invalid concurrency and seeds", () => {
      expect(() => createPlan({ events, seed: 1, concurrency: 0 })).toThrow(/concurrency/);
      expect(() => createPlan({ events, seed: 1.5 })).toThrow(/seed/);
    });

    it("rejects invalid transform options at construction time", () => {
      expect(() => duplicate({ copies: 0 })).toThrow(/positive integer/);
      expect(() => delay({ minMs: 10, maxMs: 5 })).toThrow(/minMs <= maxMs/);
    });
  });
});

describe("planner properties", () => {
  const arbEvents = fc
    .uniqueArray(fc.string({ minLength: 1, maxLength: 12 }).filter((id) => !id.includes("#")), {
      minLength: 1,
      maxLength: 8,
    })
    .map((ids) => ids.map((id) => ({ id, body: { id } }) satisfies EventFixture));

  it("is a pure function of its inputs and seed", () => {
    fc.assert(
      fc.property(arbEvents, fc.integer(), fc.integer({ min: 1, max: 4 }), (given, seed, copies) => {
        const build = () =>
          createPlan({
            events: given,
            seed,
            transforms: [duplicate({ copies }), shuffle(), delay({ minMs: 0, maxMs: 100 })],
          });

        expect(build()).toEqual(build());
      }),
      propertyConfig,
    );
  });

  it("shuffling preserves the multiset of delivered events", () => {
    fc.assert(
      fc.property(arbEvents, fc.integer(), (given, seed) => {
        const ordered = createPlan({ events: given, seed, transforms: [duplicate({ copies: 2 })] });
        const shuffled = createPlan({
          events: given,
          seed,
          transforms: [duplicate({ copies: 2 }), shuffle()],
        });

        const count = (ids: readonly string[]) =>
          ids.reduce<Record<string, number>>(
            (acc, id) => ({ ...acc, [id]: (acc[id] ?? 0) + 1 }),
            {},
          );

        expect(count(shuffled.attempts.map((a) => a.eventId))).toEqual(
          count(ordered.attempts.map((a) => a.eventId)),
        );
      }),
      propertyConfig,
    );
  });

  it("keeps delays inside the declared bounds", () => {
    fc.assert(
      fc.property(
        arbEvents,
        fc.integer(),
        fc.integer({ min: 0, max: 50 }),
        fc.integer({ min: 0, max: 50 }),
        (given, seed, a, b) => {
          const minMs = Math.min(a, b);
          const maxMs = Math.max(a, b);
          const plan = createPlan({
            events: given,
            seed,
            transforms: [duplicate({ copies: 2 }), delay({ minMs, maxMs })],
          });

          for (const attempt of plan.attempts) {
            expect(attempt.delayMs).toBeGreaterThanOrEqual(minMs);
            expect(attempt.delayMs).toBeLessThanOrEqual(maxMs);
          }
        },
      ),
      propertyConfig,
    );
  });

  it("always produces unique attempt ids", () => {
    fc.assert(
      fc.property(arbEvents, fc.integer(), fc.integer({ min: 1, max: 3 }), (given, seed, copies) => {
        const plan = createPlan({
          events: given,
          seed,
          transforms: [duplicate({ copies }), duplicate({ copies: 2 }), shuffle()],
        });
        expect(new Set(plan.attempts.map((a) => a.attemptId)).size).toBe(plan.attempts.length);
      }),
      propertyConfig,
    );
  });
});
