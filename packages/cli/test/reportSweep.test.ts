import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createPlan, duplicate, runPlan } from "@masterplaycoding/eventlab";

import { EXIT_HARNESS, EXIT_OK, run } from "../src/index.js";
import { scratchDirectory } from "./support/scratch.js";

/**
 * JSON reports are untrusted input to `eventlab report`.
 *
 * CI jobs save them, people attach them to issues, and the command renders
 * whatever file it is given. It checks the schema version and that `attempts`
 * is an array; everything else went straight into the HTML renderer. So this
 * takes a real report with every section populated - a barrier, a failing
 * assertion with a message, a failed delivery, a harness error and a failed
 * teardown - and tries every single-field change to it: each value replaced
 * with an edge value, and each value deleted. The embedded plan is only
 * replaced whole, because nothing renders its insides.
 *
 * The contract, for every input: `run` never throws and exits 0 or 2. Exit 0
 * means a timeline with nothing in it that is not the report - no `undefined`,
 * `NaN`, `Infinity` or `[object Object]` where a value should be. Exit 2 means
 * a refusal that says what is wrong, not a JavaScript engine message such as
 * "Cannot read properties of undefined", which names nothing the reader can
 * find in their file.
 */

let workspace: string;
let server: Server;
let base: Record<string, unknown>;

const out: string[] = [];
const err: string[] = [];
const streams = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };

beforeAll(async () => {
  workspace = scratchDirectory("report-sweep-");
  server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.statusCode = request.url === "/fail" ? 500 : 200;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const events = [
    { id: "evt_a", body: { n: 1 } },
    { id: "evt_b", body: { n: 2 } },
  ];
  const plan = createPlan({
    scenario: "report sweep",
    events,
    seed: 3,
    phases: [
      { deliver: ["evt_a"], transforms: [duplicate({ copies: 2 })] },
      { barrier: "between" },
      { deliver: ["evt_b"] },
    ],
  });
  const report = await runPlan(plan, {
    events,
    target: {
      baseUrl,
      request: ({ event }) => ({ method: "POST", path: event.id === "evt_b" ? "/fail" : "/" }),
    },
    expect: { deliveries: "declared" },
    assertions: [
      {
        name: "a check that fails",
        check: () => {
          throw new Error("with a message");
        },
      },
    ],
  });

  // Every optional section present, so every path the renderer reads exists
  // in the base and gets swept.
  base = {
    ...(JSON.parse(JSON.stringify(report)) as Record<string, unknown>),
    harnessError: { code: "SetupFailed", message: "a harness message", at: "hooks" },
    cleanup: { status: "failed", message: "a teardown message" },
  };
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(workspace, { recursive: true, force: true });
});

const INFINITY = "__SWEEP_INFINITY__";
const NEGATIVE_ZERO = "__SWEEP_NEGATIVE_ZERO__";

const EDGES: readonly unknown[] = [
  null, true, false, 0, -1, 1.5, 1e21, 2147483648, "", "x", [], {}, INFINITY, NEGATIVE_ZERO,
];

/** Every path in the report except the plan's insides. */
function paths(value: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  const here = prefix.length === 0 ? [] : [prefix];
  if (prefix.length === 1 && prefix[0] === "plan") return here;
  if (Array.isArray(value)) {
    return [...here, ...value.flatMap((item, index) => paths(item, [...prefix, index]))];
  }
  if (value !== null && typeof value === "object") {
    return [...here, ...Object.entries(value).flatMap(([key, item]) => paths(item, [...prefix, key]))];
  }
  return here;
}

function edited(tree: unknown, path: (string | number)[], replacement: { value: unknown } | "delete"): string {
  const copy = JSON.parse(JSON.stringify(tree)) as Record<string | number, unknown>;
  let parent: unknown = copy;
  for (const key of path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[key];
  const last = path[path.length - 1] as string | number;
  const container = parent as Record<string | number, unknown>;
  if (replacement === "delete") {
    if (Array.isArray(container) && typeof last === "number") container.splice(last, 1);
    else delete container[last];
  } else {
    container[last] = replacement.value;
  }
  return JSON.stringify(copy)
    .replaceAll(`"${INFINITY}"`, "1e999")
    .replaceAll(`"${NEGATIVE_ZERO}"`, "-0");
}

/** Signs of a value rendered that should never have reached the page. */
const GARBAGE = /undefined|NaN|Infinity|\[object Object\]/;
/** Signs of a crash surfaced as a message: engine wording that names no field. */
const ENGINE_MESSAGE = /Cannot read propert|is not a function|is not iterable|of undefined|of null|toFixed/;

async function render(text: string): Promise<{ code: number | "threw"; html?: string; stderr: string }> {
  const json = join(workspace, "report.json");
  const html = join(workspace, "timeline.html");
  writeFileSync(json, text, "utf8");
  rmSync(html, { force: true });
  out.length = 0;
  err.length = 0;
  let code: number | "threw";
  try {
    code = await run(["report", json, "--html", html], streams);
  } catch {
    code = "threw";
  }
  return {
    code,
    ...(existsSync(html) ? { html: readFileSync(html, "utf8") } : {}),
    stderr: err.join("\n"),
  };
}

describe("eventlab report under every single-field change", () => {
  it("renders the untouched base cleanly, so the sweep starts from a valid report", async () => {
    const result = await render(JSON.stringify(base));
    expect(result.code).toBe(EXIT_OK);
    expect(result.html).toBeDefined();
    expect(result.html).not.toMatch(GARBAGE);
  });

  it("never crashes, never exits oddly, and never renders garbage", async () => {
    const findings = new Map<string, string>();
    const allPaths = paths(base);
    let cases = 0;

    for (const path of allPaths) {
      const replacements: ({ value: unknown } | "delete")[] = ["delete", ...EDGES.map((value) => ({ value }))];
      for (const replacement of replacements) {
        cases += 1;
        const text = edited(base, path, replacement);
        const result = await render(text);
        const where = `${path.join(".")} = ${replacement === "delete" ? "(deleted)" : JSON.stringify(replacement.value)}`;

        let problem: string | undefined;
        if (result.code === "threw") problem = "run() threw";
        else if (result.code !== EXIT_OK && result.code !== EXIT_HARNESS) problem = `exit ${result.code}`;
        else if (result.code === EXIT_OK && result.html !== undefined && GARBAGE.test(result.html)) {
          problem = `rendered ${result.html.match(GARBAGE)?.[0]}`;
        } else if (result.code === EXIT_HARNESS && ENGINE_MESSAGE.test(result.stderr)) {
          problem = `crashed: ${result.stderr.split("\n")[0]?.slice(0, 110)}`;
        }

        if (problem !== undefined) {
          // One example per kind of problem at each path is enough to act on.
          const key = `${path.join(".")} :: ${problem.replace(/\d+/g, "#")}`;
          if (!findings.has(key)) findings.set(key, `${where} -> ${problem}`);
        }
      }
    }

    expect(cases).toBe(allPaths.length * (EDGES.length + 1));
    expect(
      [...findings.values()],
      `${findings.size} distinct finding(s) in ${cases} cases:\n${[...findings.values()].slice(0, 60).join("\n")}`,
    ).toEqual([]);
  }, 120_000);
});
