import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertFixturesMatch,
  formatReport,
  parsePlan,
  REPORT_SCHEMA_VERSION,
  runPlan,
  type RunReport,
} from "@masterplaycoding/eventlab";

import { renderHtml } from "./html.js";
import { loadScenario, ScenarioError } from "./scenario.js";

export { renderHtml } from "./html.js";
export { loadScenario, ScenarioError, type ScenarioModule } from "./scenario.js";

/**
 * Exit codes, which are this tool's real interface because CI is where it runs.
 *
 * `1` and `2` are kept apart on purpose: "your application failed the scenario"
 * and "your scenario is not runnable" call for entirely different reactions,
 * and a pipeline that cannot tell them apart teaches people to ignore both.
 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_HARNESS = 2;

export interface Streams {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

export const USAGE = `eventlab — run, replay and render EventLab scenarios

Usage:
  eventlab run    <scenario.js> [--json <file>] [--html <file>]
  eventlab replay <plan.json> <scenario.js> [--json <file>] [--html <file>]
  eventlab report <report.json> --html <file>

Commands:
  run      Execute the plan a scenario module exports.
  replay   Execute a saved plan against a scenario module's target and
           fixtures. The saved plan wins; the module's own plan is ignored.
  report   Render an existing JSON report as a standalone HTML timeline.

Options:
  --json <file>   Write the run report as JSON.
  --html <file>   Write a standalone HTML timeline.
  -h, --help      Show this message.

Exit codes:
  0  the scenario passed
  1  the scenario failed — your application did not hold its invariants
  2  the scenario could not be run — bad arguments, a missing export,
     a blocked target, a failing setup

A scenario is a JavaScript module and running one runs its author's code,
exactly like running any script. It is not a sandboxed data format.`;

/** Runs the CLI and returns an exit code. Never calls process.exit. */
export async function run(argv: readonly string[], streams: Streams): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    streams.out(USAGE);
    return EXIT_OK;
  }

  let options: ParsedOptions;
  try {
    options = parseOptions(rest);
  } catch (cause) {
    return usageError(streams, (cause as Error).message);
  }

  try {
    switch (command) {
      case "run":
        return await commandRun(options, streams);
      case "replay":
        return await commandReplay(options, streams);
      case "report":
        return await commandReport(options, streams);
      default:
        return usageError(streams, `unknown command "${command}"`);
    }
  } catch (cause) {
    if (cause instanceof ScenarioError) {
      return usageError(streams, cause.message);
    }
    // Anything else is the environment: a missing file, a permission problem.
    streams.err(`eventlab: ${(cause as Error).message}`);
    return EXIT_HARNESS;
  }
}

async function commandRun(options: ParsedOptions, streams: Streams): Promise<number> {
  const [scenarioPath] = options.positional;
  if (scenarioPath === undefined || options.positional.length > 1) {
    return usageError(streams, "run takes exactly one scenario module");
  }

  const scenario = await loadScenario(scenarioPath);
  const report = await runPlan(scenario.plan, { ...scenario.run, events: scenario.events });

  return await finish(report, options, streams);
}

async function commandReplay(options: ParsedOptions, streams: Streams): Promise<number> {
  const [planPath, scenarioPath] = options.positional;
  if (planPath === undefined || scenarioPath === undefined || options.positional.length > 2) {
    return usageError(streams, "replay takes a saved plan and a scenario module");
  }

  const scenario = await loadScenario(scenarioPath);
  const plan = parsePlan(await readFile(resolve(planPath), "utf8"));

  // Checked before running, so a drifted fixture is reported as such rather
  // than as a mysteriously different result. The saved plan is authoritative:
  // the module's own plan is deliberately not consulted.
  assertFixturesMatch(plan, scenario.events);

  const report = await runPlan(plan, { ...scenario.run, events: scenario.events });
  return await finish(report, options, streams);
}

async function commandReport(options: ParsedOptions, streams: Streams): Promise<number> {
  const [reportPath] = options.positional;
  if (reportPath === undefined || options.positional.length > 1) {
    return usageError(streams, "report takes exactly one JSON report");
  }
  if (options.html === undefined) {
    return usageError(streams, "report needs --html <file>; there is nothing else to produce");
  }

  const parsed = JSON.parse(await readFile(resolve(reportPath), "utf8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as Partial<RunReport>).attempts)
  ) {
    return usageError(streams, `${reportPath} is not an EventLab report`);
  }

  const report = parsed as RunReport;
  const refusal = unrenderableSchema(report.reportSchemaVersion);
  if (refusal !== undefined) {
    // Not a usage error: the arguments were fine, the file is the problem.
    streams.err(`eventlab: ${reportPath} ${refusal}`);
    return EXIT_HARNESS;
  }

  await writeFile(resolve(options.html), renderHtml(report), "utf8");
  streams.out(`wrote ${options.html}`);
  return EXIT_OK;
}

/**
 * Report schemas the timeline can render: this build's own, and every older
 * one whose shape it still reads correctly.
 *
 * Schema 3 only added fields, so a schema-2 report from a 0.2.x CI job renders
 * unchanged. Schema 1 predates `barriers`, which the timeline reads
 * unconditionally.
 *
 * A *newer* schema is refused rather than rendered on a best-effort basis,
 * because best effort is silent about exactly the part that matters: a report
 * can carry a status this build has never heard of, and a renderer that skips
 * what it does not recognise would drop it without a word. The timeline did
 * precisely that with `harnessError` and `cleanup` until 0.3.0.
 */
const RENDERABLE_REPORT_SCHEMAS: readonly string[] = ["2", REPORT_SCHEMA_VERSION];

/** Why a report cannot be rendered, or undefined when it can. */
function unrenderableSchema(version: unknown): string | undefined {
  if (typeof version === "string" && RENDERABLE_REPORT_SCHEMAS.includes(version)) {
    return undefined;
  }
  const supported = `this build renders report schemas ${RENDERABLE_REPORT_SCHEMAS.join(" and ")}`;
  if (typeof version !== "string") {
    return `has no reportSchemaVersion; ${supported}`;
  }
  if (/^\d+$/.test(version) && Number(version) > Number(REPORT_SCHEMA_VERSION)) {
    return (
      `was written with report schema ${version}, which is newer than this build ` +
      `understands; ${supported}. Upgrade @masterplaycoding/eventlab-cli to render it.`
    );
  }
  return (
    `was written with report schema ${version}; ${supported}. ` +
    `Run the scenario again with this release to get a report it can render.`
  );
}

/** Writes any requested artifacts, prints the report, and picks an exit code. */
async function finish(
  report: RunReport,
  options: ParsedOptions,
  streams: Streams,
): Promise<number> {
  if (options.json !== undefined) {
    await writeFile(resolve(options.json), `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  if (options.html !== undefined) {
    await writeFile(resolve(options.html), renderHtml(report), "utf8");
  }

  streams.out(formatReport(report));

  for (const artifact of [options.json, options.html]) {
    if (artifact !== undefined) streams.out(`\nwrote ${artifact}`);
  }

  // A harness error means the experiment never happened, which is not a
  // verdict on the application under test.
  if (report.harnessError !== undefined) return EXIT_HARNESS;
  return report.passed ? EXIT_OK : EXIT_FAILED;
}

interface ParsedOptions {
  readonly positional: readonly string[];
  readonly json?: string;
  readonly html?: string;
}

function parseOptions(args: readonly string[]): ParsedOptions {
  const positional: string[] = [];
  let json: string | undefined;
  let html: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--json" || argument === "--html") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${argument} needs a file path`);
      }
      if (argument === "--json") json = value;
      else html = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      throw new Error(`unknown option "${argument}"`);
    } else {
      positional.push(argument);
    }
  }

  return {
    positional,
    ...(json === undefined ? {} : { json }),
    ...(html === undefined ? {} : { html }),
  };
}

function usageError(streams: Streams, message: string): number {
  streams.err(`eventlab: ${message}`);
  streams.err("");
  streams.err(USAGE);
  return EXIT_HARNESS;
}
