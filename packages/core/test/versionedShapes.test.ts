import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PLANNER_VERSION, REPORT_SCHEMA_VERSION } from "../src/version.js";

/**
 * A shape change without a version bump fails here.
 *
 * REPORT_SCHEMA_VERSION tells a report's consumers which shape to expect, and
 * PLANNER_VERSION tells replay whether a saved plan is one this build can run.
 * Both are only honest if they move when the shape does - and in 0.3 the
 * report gained `limits.teardownTimeoutMs` and a `timed-out` cleanup status
 * while the schema version stayed at 2. A careful reading caught it; nothing
 * would have.
 *
 * The shapes are read from etc/eventlab.api.md, the API report that
 * `npm run api:check` keeps identical to the built declarations. For each
 * versioned artifact this extracts the types it is made of, drops comment
 * lines (documenting a field is not a shape change), and compares them with
 * the snapshot recorded for the *current* version. Changing a shape therefore
 * means bumping the version, which means a new snapshot, which is the review
 * moment. The old snapshots stay, as the history of every version's shape.
 *
 * `EVENTLAB_RECORD_SHAPES=1` writes the snapshot for a version that has none
 * yet. It never overwrites one.
 */

const apiReport = readFileSync(
  fileURLToPath(new URL("../etc/eventlab.api.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");
const snapshots = fileURLToPath(new URL("./versioned-shapes/", import.meta.url));

/** One declaration from the API report, without comment lines. */
function declaration(name: string): string {
  const start = apiReport.search(new RegExp(`^export (interface|type) ${name}\\b`, "m"));
  if (start < 0) throw new Error(`etc/eventlab.api.md declares no ${name}`);
  const end = apiReport.indexOf("\n\n", start);
  return apiReport
    .slice(start, end < 0 ? undefined : end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

const artifacts = [
  {
    // What a saved plan is. Serialised by serializePlan, read by parsePlan.
    name: "plan",
    version: PLANNER_VERSION,
    constant: "PLANNER_VERSION",
    types: ["DeliveryPlan", "DeliveryAttempt", "PlanBarrier", "TransformRecord"],
  },
  {
    // What a JSON report is, including the plan it embeds.
    name: "report",
    version: REPORT_SCHEMA_VERSION,
    constant: "REPORT_SCHEMA_VERSION",
    types: [
      "RunReport",
      "AttemptReport",
      "AssertionReport",
      "BarrierReport",
      "DeliveryOutcome",
      "RunLimits",
      "DeliveryExpectation",
      "DeliveryPlan",
      "DeliveryAttempt",
      "PlanBarrier",
      "TransformRecord",
    ],
  },
];

describe("versioned shapes", () => {
  for (const artifact of artifacts) {
    it(`the ${artifact.name} shape is the one recorded for ${artifact.constant} ${artifact.version}`, () => {
      const shape = artifact.types.map(declaration).join("\n\n") + "\n";
      const file = join(snapshots, `${artifact.name}-${artifact.version}.txt`);

      if (!existsSync(file) && process.env.EVENTLAB_RECORD_SHAPES === "1") {
        mkdirSync(snapshots, { recursive: true });
        writeFileSync(file, shape);
      }

      expect(
        existsSync(file),
        `no recorded ${artifact.name} shape for ${artifact.constant} ${artifact.version}. ` +
          `If you bumped it on purpose, record it with EVENTLAB_RECORD_SHAPES=1.`,
      ).toBe(true);
      expect(
        shape,
        `the ${artifact.name} shape changed but ${artifact.constant} is still ` +
          `${artifact.version}. Bump it, record the new shape, and add a changelog migration note.`,
      ).toBe(readFileSync(file, "utf8").replace(/\r\n/g, "\n"));
    });
  }
});
