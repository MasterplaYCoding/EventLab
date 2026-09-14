import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fc from "fast-check";

import { burst, createPlan, delay, duplicate, shuffle } from "../src/index.js";
import { HarnessError } from "../src/errors.js";
import { parsePlan, serializePlan } from "../src/plan/savedPlan.js";
import { runPlan } from "../src/run/runPlan.js";
import type { DeliveryPlan } from "../src/types.js";
import { propertyConfig } from "./support/property.js";
import { startTestServer, type TestServer } from "./support/testServer.js";

/**
 * Saved plans are untrusted input.
 *
 * People attach them to bug reports, and `eventlab replay` runs whatever file
 * it is given. parsePlan's own documentation says it "checks it is safe to
 * execute" - which is a claim about every plan it does not refuse, and so a
 * claim a fuzzer can test.
 *
 * Each case takes a valid plan (phases, a barrier with a checkpoint, several
 * transforms) and mutates it: a value somewhere in the tree replaced with
 * something hostile, a key deleted, or a number rewritten as `1e999` - valid
 * JSON that parses to Infinity, which JSON.stringify can never produce and a
 * hand-edited file easily can. Then two oracles:
 *
 * - **Refused properly.** Anything parsePlan rejects, it rejects with a
 *   HarnessError - never a TypeError from reading a field that is not there.
 * - **Accepted means runnable as written.** A plan parsePlan accepts must
 *   satisfy the invariants createPlan guarantees for every plan it produces;
 *   and replaying it must never end in an `Unknown` harness error, which is
 *   how runPlan reports a crash it did not anticipate. When the replay runs
 *   cleanly, it must deliver every attempt and pass every barrier the plan
 *   declares - a saved plan is authoritative, so an instruction silently not
 *   carried out is a different experiment.
 */

const events = [
  { id: "evt_a", body: { order: "ord_1" } },
  { id: "evt_b", body: { order: "ord_2" } },
];

const base: DeliveryPlan = createPlan({
  scenario: "fuzzed",
  events,
  seed: 99,
  concurrency: 2,
  phases: [
    { deliver: ["evt_a"], transforms: [duplicate({ copies: 2 }), shuffle(), delay({ minMs: 0, maxMs: 5 })] },
    { barrier: "between", checkpoint: "settle" },
    { deliver: ["evt_b"], transforms: [burst()] },
  ],
});

/** Every path in the plan tree, so a mutation can land anywhere. */
function paths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  const here = prefix.length === 0 ? [] : [prefix];
  if (Array.isArray(value)) {
    return [...here, ...value.flatMap((item, index) => paths(item, [...prefix, index]))];
  }
  if (value !== null && typeof value === "object") {
    return [
      ...here,
      ...Object.entries(value).flatMap(([key, item]) => paths(item, [...prefix, key])),
    ];
  }
  return here;
}

const allPaths = paths(JSON.parse(serializePlan(base)));

/** Markers replaced after stringifying: JSON that JSON.stringify cannot emit. */
const INFINITY = "__FUZZ_INFINITY__";
const NEGATIVE_ZERO = "__FUZZ_NEGATIVE_ZERO__";

/** The values most likely to slip past a check that tests type but not shape. */
const EDGES: readonly unknown[] = [
  null, true, false, 0, -1, 1, 1.5, 2147483648, 1e21, "", "1", "x", [], {},
  INFINITY, NEGATIVE_ZERO,
];

const hostileValue = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom<unknown>(...EDGES) },
  { weight: 1, arbitrary: fc.integer() },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
  { weight: 1, arbitrary: fc.jsonValue({ maxDepth: 2 }) },
);

const mutation = fc.record({
  path: fc.constantFrom(...allPaths),
  action: fc.constantFrom("replace", "delete"),
  value: hostileValue,
});

function mutate(plan: DeliveryPlan, changes: { path: (string | number)[]; action: string; value: unknown }[]): string {
  const tree = JSON.parse(serializePlan(plan)) as Record<string, unknown>;
  for (const { path, action, value } of changes) {
    let parent: unknown = tree;
    for (const key of path.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") break;
      parent = (parent as Record<string | number, unknown>)[key];
    }
    if (parent === null || typeof parent !== "object") continue;
    const last = path[path.length - 1] as string | number;
    if (action === "delete") {
      if (Array.isArray(parent) && typeof last === "number") parent.splice(last, 1);
      else delete (parent as Record<string | number, unknown>)[last];
    } else {
      (parent as Record<string | number, unknown>)[last] = value;
    }
  }
  return JSON.stringify(tree)
    .replaceAll(`"${INFINITY}"`, "1e999")
    .replaceAll(`"${NEGATIVE_ZERO}"`, "-0");
}

/**
 * What createPlan guarantees about every plan it returns, restated
 * independently. A plan parsePlan accepts must satisfy all of it.
 */
function invariantViolations(plan: DeliveryPlan): string[] {
  const problems: string[] = [];
  const nonNegativeInteger = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

  if (!Number.isInteger(plan.concurrency) || plan.concurrency < 1) {
    problems.push(`concurrency ${String(plan.concurrency)} is not a positive integer`);
  }
  if (!Array.isArray(plan.transforms)) problems.push("transforms is not an array");
  if (!Array.isArray(plan.barriers)) problems.push("barriers is not an array");

  for (const attempt of Array.isArray(plan.attempts) ? plan.attempts : []) {
    if (!nonNegativeInteger(attempt.phase)) problems.push(`attempt phase ${String(attempt.phase)}`);
    if (!nonNegativeInteger(attempt.order)) problems.push(`attempt order ${String(attempt.order)}`);
    if (!nonNegativeInteger(attempt.copyIndex)) {
      problems.push(`attempt copyIndex ${String(attempt.copyIndex)}`);
    }
  }
  for (const barrier of Array.isArray(plan.barriers) ? plan.barriers : []) {
    if (barrier.checkpoint !== undefined && typeof barrier.checkpoint !== "string") {
      problems.push(`barrier checkpoint ${String(barrier.checkpoint)}`);
    }
  }
  return problems;
}

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer((_request, response) => response.end("ok"));
});

afterAll(async () => {
  await server.close();
});

/** Every checkpoint name exists and does nothing, so names are never the obstacle. */
const anyCheckpoint = new Proxy({}, { get: () => async () => {} }) as Record<string, () => Promise<void>>;

/** Both oracles, for one candidate saved plan. */
async function examine(text: string): Promise<void> {
  let plan: DeliveryPlan;
  try {
    plan = parsePlan(text);
  } catch (cause) {
    expect(cause, `parsePlan threw a ${String((cause as Error)?.name)} for ${text}`).toBeInstanceOf(
      HarnessError,
    );
    return;
  }

  expect(invariantViolations(plan), `parsePlan accepted ${text}`).toEqual([]);

  const report = await runPlan(plan, {
    events,
    target: { baseUrl: server.baseUrl, request: () => ({ method: "POST", path: "/" }) },
    hooks: { checkpoints: anyCheckpoint },
    limits: { requestTimeoutMs: 1_000, scenarioTimeoutMs: 3_000, teardownTimeoutMs: 500 },
  });

  expect(report.harnessError?.code, `replay crashed on ${text}: ${report.harnessError?.message}`).not.toBe(
    "Unknown",
  );
  if (report.harnessError === undefined) {
    expect(report.attempts.length, `not every attempt was delivered for ${text}`).toBe(
      plan.attempts.length,
    );
    for (const barrier of report.barriers) {
      expect(barrier.status, `barrier "${barrier.name}" for ${text}`).toBe("passed");
    }
  }
}

describe("saved plans under mutation", () => {
  it("every single-field mutation: each path, each edge value, and each deletion", async () => {
    // Deterministic and exhaustive, because random search is the wrong tool for
    // a bug that needs one particular field *and* one particular value: the
    // first version of this file, random only, missed a concurrency of 1.5 or
    // Infinity in 2,000 runs, and CI runs 100. Every path times every edge
    // value is a few hundred cases and well under a second.
    let cases = 0;
    for (const path of allPaths) {
      await examine(mutate(base, [{ path, action: "delete", value: null }]));
      cases += 1;
      for (const value of EDGES) {
        await examine(mutate(base, [{ path, action: "replace", value }]));
        cases += 1;
      }
    }
    expect(cases).toBe(allPaths.length * (EDGES.length + 1));
  }, 120_000);

  it("random combinations of mutations", async () => {
    // The search: several changes at once, values beyond the edge list. What
    // this finds that the sweep does not is an interaction between fields.
    await fc.assert(
      fc.asyncProperty(fc.array(mutation, { minLength: 1, maxLength: 3 }), async (changes) => {
        await examine(mutate(base, changes));
      }),
      propertyConfig,
    );
  }, 120_000);
});
