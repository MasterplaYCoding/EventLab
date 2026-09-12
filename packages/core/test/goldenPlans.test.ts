import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as eventlab from "../src/index.js";
import { HarnessError } from "../src/errors.js";
import { scenarios } from "./golden-plans/scenarios.mjs";

/**
 * The same seed and inputs produce the same plan - across releases, not just
 * within one.
 *
 * Every report tells its reader to "rebuild with seed X and planner version
 * Y", and the README's first guarantee is that a seed reproduces a plan. The
 * planner's own tests only prove it is deterministic *within* a build: a
 * refactor that changed the shuffle would pass all of them, keep
 * PLANNER_VERSION at the same value, and quietly make every published seed
 * mean a different plan.
 *
 * The files in golden-plans/<version>/ were written by the *released* npm
 * packages (tools/golden-plans), from the inputs in scenarios.mjs. While the
 * planner version matches, this build must serialise every scenario to the
 * same text; a plan from a different planner version must be refused by
 * parsePlan, which is the other half of the promise. Line endings are
 * normalised because a Windows checkout may convert them; nothing else is.
 */

const root = fileURLToPath(new URL("./golden-plans/", import.meta.url));
const versions = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const current = new Map(scenarios(eventlab).map(({ name, plan }) => [name, plan]));
const read = (version: string, name: string) =>
  readFileSync(join(root, version, `${name}.json`), "utf8").replace(/\r\n/g, "\n");

describe("golden plans from released versions", () => {
  it("cover every release since saved plans existed, and every scenario", () => {
    // A directory that silently lost files would make the loop below vacuous.
    for (const release of ["0.2.0", "0.2.1", "0.3.0", "0.4.0"]) expect(versions).toContain(release);
    for (const version of versions) {
      const names = readdirSync(join(root, version)).map((file) => file.replace(/\.json$/, "")).sort();
      expect(names, `scenarios in ${version}`).toEqual([...current.keys()].sort());
    }
  });

  for (const version of versions) {
    it(`this build plans what ${version} planned`, () => {
      for (const [name, plan] of current) {
        const golden = read(version, name);
        const recorded = JSON.parse(golden) as { plannerVersion: string };

        if (recorded.plannerVersion === eventlab.PLANNER_VERSION) {
          expect(eventlab.serializePlan(plan), `${version}/${name}`).toBe(golden);
          // And a plan saved by that release still loads.
          expect(eventlab.parsePlan(golden)).toEqual(plan);
        } else {
          // A different planner version is a different experiment: replay
          // must refuse rather than regenerate.
          expect(() => eventlab.parsePlan(golden)).toThrow(HarnessError);
        }
      }
    });
  }
});
