import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScenarioError, loadScenario } from "../src/scenario.js";

/**
 * The loader's whole job is the first thirty seconds of someone's experience.
 *
 * A scenario module is user code, and the ways it can be wrong are ordinary:
 * a missing export, a typo in a name, a file that does not parse. What comes
 * back has to say which file and which export, because the alternative -
 * "Cannot read properties of undefined" thrown from somewhere inside the
 * runner - is the reason people give up on a tool.
 */

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "eventlab-scenario-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeModule(source: string, name = "scenario.mjs"): string {
  const path = join(workspace, name);
  writeFileSync(path, source, "utf8");
  return path;
}

const complete = `
import { createPlan } from "@masterplaycoding/eventlab";
export const events = [{ id: "evt_a", body: {} }];
export const plan = createPlan({ events, seed: 1 });
export const run = { target: { baseUrl: "http://127.0.0.1:1", request: () => ({ method: "POST", path: "/" }) } };
`;

describe("a well-formed scenario", () => {
  it("loads named exports", async () => {
    const module = await loadScenario(writeModule(complete));

    expect(module.events).toHaveLength(1);
    expect(module.plan.attempts).toHaveLength(1);
    expect(module.run.target).toBeDefined();
  });

  it("loads a default export just as happily", async () => {
    // Both shapes are documented. A scenario should not have to wrap itself in
    // an object, and equally should not be prevented from doing so.
    const module = await loadScenario(
      writeModule(`
        import { createPlan } from "@masterplaycoding/eventlab";
        const events = [{ id: "evt_a", body: {} }];
        export default {
          events,
          plan: createPlan({ events, seed: 1 }),
          run: { target: { baseUrl: "http://127.0.0.1:1", request: () => ({ method: "POST", path: "/" }) } },
        };
      `),
    );

    expect(module.events).toHaveLength(1);
  });

  it("accepts a relative path", async () => {
    // resolve() against the working directory, so `eventlab run ./scenario.mjs`
    // behaves like every other command-line tool.
    const path = writeModule(complete);
    const module = await loadScenario(path);

    expect(module.plan).toBeDefined();
  });
});

describe("a scenario that is missing something", () => {
  const cases: Array<[string, string, string]> = [
    [
      "no events",
      `export const plan = { attempts: [] };
       export const run = { target: {} };`,
      '"events"',
    ],
    [
      "empty events",
      `export const events = [];
       export const plan = { attempts: [] };
       export const run = { target: {} };`,
      '"events"',
    ],
    [
      "no plan",
      `export const events = [{ id: "a", body: {} }];
       export const run = { target: {} };`,
      '"plan"',
    ],
    [
      "a plan that is not one",
      `export const events = [{ id: "a", body: {} }];
       export const plan = { nearly: true };
       export const run = { target: {} };`,
      '"plan"',
    ],
    [
      "no run",
      `export const events = [{ id: "a", body: {} }];
       export const plan = { attempts: [] };`,
      '"run"',
    ],
    [
      "a run with no target",
      `export const events = [{ id: "a", body: {} }];
       export const plan = { attempts: [] };
       export const run = { assertions: [] };`,
      '"run"',
    ],
  ];

  for (const [label, source, expected] of cases) {
    it(`says which export is wrong: ${label}`, async () => {
      const path = writeModule(source, `${label.replace(/\s+/g, "-")}.mjs`);

      const failure = await loadScenario(path).catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(ScenarioError);
      expect((failure as ScenarioError).message).toContain(expected);
      // And which file, because a CI log may hold several.
      expect((failure as ScenarioError).message).toContain(path);
    });
  }
});

describe("a scenario that will not load at all", () => {
  it("reports a file that does not exist", async () => {
    const failure = await loadScenario(join(workspace, "absent.mjs")).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toBeInstanceOf(ScenarioError);
    expect((failure as ScenarioError).message).toContain("could not import");
  });

  it("reports a syntax error rather than letting it escape", async () => {
    const path = writeModule("export const events = [", "broken.mjs");

    const failure = await loadScenario(path).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ScenarioError);
    expect((failure as ScenarioError).message).toContain("could not import");
  });

  it("describes a module that throws something that is not an Error", async () => {
    // `throw "nope"` is legal. Reading `.message` off it gives undefined, and
    // "could not import scenario.mjs: undefined" helps nobody.
    const path = writeModule(`throw "the database was unreachable";`, "throws.mjs");

    const failure = await loadScenario(path).catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ScenarioError);
    expect((failure as ScenarioError).message).not.toContain("undefined");
    expect((failure as ScenarioError).message).toContain("database was unreachable");
  });
});

describe("ScenarioError", () => {
  it("is named so it can be told apart from anything else thrown", () => {
    const error = new ScenarioError("nope");

    expect(error.name).toBe("ScenarioError");
    expect(error.message).toBe("nope");
    expect(error).toBeInstanceOf(Error);
  });
});
