import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import type { DeliveryPlan, EventFixture, RunOptions } from "@masterplaycoding/eventlab";

/**
 * What a scenario module must export.
 *
 * A scenario is a JavaScript module, not a configuration file, because
 * building a request is code: signatures, tokens and per-attempt bodies cannot
 * be expressed in JSON without inventing a language. The consequence is stated
 * plainly in the CLI's help and in SECURITY.md — running a scenario runs its
 * author's code, exactly like running any script.
 */
export interface ScenarioModule {
  /** The fixtures. Required. */
  readonly events: readonly EventFixture[];
  /** The plan to execute. Required. */
  readonly plan: DeliveryPlan;
  /** Everything else `runPlan` needs, minus the plan and the events. */
  readonly run: Omit<RunOptions, "events">;
}

export class ScenarioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioError";
  }
}

/**
 * Imports a scenario module and checks it exports what it must.
 *
 * The checks are deliberately specific. "Cannot read properties of undefined"
 * from somewhere inside the runner is a much worse first experience than being
 * told which export is missing from which file.
 */
export async function loadScenario(path: string): Promise<ScenarioModule> {
  const absolute = resolve(path);

  let module: Record<string, unknown>;
  try {
    module = (await import(pathToFileURL(absolute).href)) as Record<string, unknown>;
  } catch (cause) {
    // Not `(cause as Error).message`. A module can reject with anything at
    // all - a string, an object, a value from another realm - and the cast
    // would then produce "could not import scenario.mjs: undefined", which is
    // the one message guaranteed to help nobody diagnose anything.
    const described = cause as { message?: unknown };
    const reason =
      typeof described?.message === "string" ? described.message : String(cause);
    throw new ScenarioError(`could not import ${path}: ${reason}`);
  }

  // A default export is the common shape, but named exports work too, so a
  // scenario can be a plain module without a wrapper object.
  const source = (module.default ?? module) as Record<string, unknown>;

  const events = source.events;
  if (!Array.isArray(events) || events.length === 0) {
    throw new ScenarioError(`${path} must export "events": a non-empty array of fixtures`);
  }

  const plan = source.plan;
  if (typeof plan !== "object" || plan === null || !("attempts" in plan)) {
    throw new ScenarioError(
      `${path} must export "plan", the result of createPlan(...)`,
    );
  }

  const run = source.run;
  if (typeof run !== "object" || run === null || !("target" in run)) {
    throw new ScenarioError(
      `${path} must export "run": the options for runPlan, including a target`,
    );
  }

  return {
    events: events as readonly EventFixture[],
    plan: plan as DeliveryPlan,
    run: run as Omit<RunOptions, "events">,
  };
}
