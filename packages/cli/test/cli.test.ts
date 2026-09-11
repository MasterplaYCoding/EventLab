import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { REPORT_SCHEMA_VERSION } from "@masterplaycoding/eventlab";

import { EXIT_FAILED, EXIT_HARNESS, EXIT_OK, run } from "../src/index.js";

let workspace: string;
let server: Server | undefined;
let baseUrl = "";
let received = 0;

const out: string[] = [];
const err: string[] = [];
const streams = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };

const stdout = () => out.join("\n");
const stderr = () => err.join("\n");

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), "eventlab-cli-"));
  out.length = 0;
  err.length = 0;
  received = 0;

  server = createServer((request, response) => {
    request.on("data", () => {});
    request.on("end", () => {
      received += 1;
      response.statusCode = 200;
      response.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
});

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing !== undefined) {
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
  rmSync(workspace, { recursive: true, force: true });
});

/**
 * Writes a scenario module.
 *
 * Real ESM importing the real library, so these tests exercise the loader the
 * way a user's file would rather than a mock of it.
 */
function writeScenario(options: { passes: boolean; name?: string }): string {
  const path = join(workspace, options.name ?? "scenario.mjs");
  writeFileSync(
    path,
    `
import { createPlan, duplicate, burst } from "@masterplaycoding/eventlab";

export const events = [{ id: "evt_a", body: { order: "ord_1" } }];

export const plan = createPlan({
  scenario: "cli scenario",
  events,
  seed: 7,
  transforms: [duplicate({ copies: 2 }), burst()],
});

export const run = {
  target: {
    baseUrl: ${JSON.stringify(baseUrl)},
    request: ({ event }) => ({
      method: "POST",
      path: "/webhooks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event.body),
    }),
  },
  assertions: [
    {
      name: "the invariant holds",
      check: () => { if (!${options.passes}) throw new Error("it did not hold"); },
    },
  ],
};
`,
    "utf8",
  );
  return path;
}

describe("eventlab run", () => {
  it("executes the scenario and exits 0 when it passes", async () => {
    const code = await run(["run", writeScenario({ passes: true })], streams);

    expect(code).toBe(EXIT_OK);
    expect(received).toBe(2);
    expect(stdout()).toContain("✓ the invariant holds");
    expect(stdout()).toContain("2 deliveries, all 200 OK");
  });

  it("exits 1 when the application fails the scenario", async () => {
    const code = await run(["run", writeScenario({ passes: false })], streams);

    // 1, not 2: the scenario ran fine and the application did not hold.
    expect(code).toBe(EXIT_FAILED);
    expect(stdout()).toContain("✗ the invariant holds");
    expect(stdout()).toContain("it did not hold");
  });

  it("exits 2 when the experiment could not run at all", async () => {
    const path = join(workspace, "remote.mjs");
    writeFileSync(
      path,
      `
import { createPlan } from "@masterplaycoding/eventlab";
export const events = [{ id: "evt_a", body: {} }];
export const plan = createPlan({ events, seed: 1 });
export const run = { target: { baseUrl: "https://example.com", request: () => ({ method: "POST", path: "/" }) } };
`,
      "utf8",
    );

    const code = await run(["run", path], streams);

    // A harness error is not a verdict on the application under test.
    expect(code).toBe(EXIT_HARNESS);
    expect(stdout()).toContain("RemoteTargetBlocked");
  });

  it("writes the artifacts it is asked for", async () => {
    const json = join(workspace, "report.json");
    const html = join(workspace, "report.html");

    const code = await run(
      ["run", writeScenario({ passes: true }), "--json", json, "--html", html],
      streams,
    );

    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(readFileSync(json, "utf8")) as { attempts: unknown[] };
    expect(parsed.attempts).toHaveLength(2);
    expect(readFileSync(html, "utf8")).toContain("<title>EventLab");
  });
});

describe("eventlab replay", () => {
  it("runs the saved plan rather than the module's own", async () => {
    const scenario = writeScenario({ passes: true });

    // A saved plan with one attempt; the module's plan has two.
    const first = await run(["run", scenario, "--json", join(workspace, "r.json")], streams);
    expect(first).toBe(EXIT_OK);

    const saved = JSON.parse(readFileSync(join(workspace, "r.json"), "utf8")) as {
      plan: { attempts: unknown[] };
    };
    const planPath = join(workspace, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({ ...saved.plan, attempts: saved.plan.attempts.slice(0, 1) }),
      "utf8",
    );

    received = 0;
    out.length = 0;
    const code = await run(["replay", planPath, scenario], streams);

    expect(code).toBe(EXIT_OK);
    expect(received).toBe(1);
  });

  it("refuses to replay against edited fixtures", async () => {
    const scenario = writeScenario({ passes: true });
    await run(["run", scenario, "--json", join(workspace, "r.json")], streams);

    const saved = JSON.parse(readFileSync(join(workspace, "r.json"), "utf8")) as {
      plan: Record<string, unknown>;
    };
    const planPath = join(workspace, "plan.json");
    writeFileSync(
      planPath,
      JSON.stringify({ ...saved.plan, fixtureDigest: "sha256:" + "0".repeat(64) }),
      "utf8",
    );

    out.length = 0;
    err.length = 0;
    const code = await run(["replay", planPath, scenario], streams);

    expect(code).toBe(EXIT_HARNESS);
    expect(stderr()).toContain("fixtures have changed");
  });
});

describe("eventlab report", () => {
  it("renders a saved JSON report as HTML", async () => {
    const json = join(workspace, "report.json");
    const html = join(workspace, "out.html");
    await run(["run", writeScenario({ passes: true }), "--json", json], streams);

    out.length = 0;
    const code = await run(["report", json, "--html", html], streams);

    expect(code).toBe(EXIT_OK);
    const rendered = readFileSync(html, "utf8");
    expect(rendered).toContain("cli scenario");
    expect(rendered).toContain("Timeline");
    // The report holds response previews; the timeline deliberately omits them.
    expect(rendered).not.toContain('"ok":true');
  });

  it("needs somewhere to put the output", async () => {
    const json = join(workspace, "report.json");
    await run(["run", writeScenario({ passes: true }), "--json", json], streams);

    err.length = 0;
    expect(await run(["report", json], streams)).toBe(EXIT_HARNESS);
    expect(stderr()).toContain("needs --html");
  });

  /** A real report from this build, rewritten by `edit` and saved again. */
  async function savedReport(edit: (report: Record<string, unknown>) => void): Promise<string> {
    const json = join(workspace, "report.json");
    await run(["run", writeScenario({ passes: true }), "--json", json], streams);
    const report = JSON.parse(readFileSync(json, "utf8")) as Record<string, unknown>;
    edit(report);
    writeFileSync(json, JSON.stringify(report), "utf8");
    out.length = 0;
    err.length = 0;
    return json;
  }

  it("refuses a report from a newer schema rather than rendering part of it", async () => {
    // A newer report can carry a status this build has never heard of, and
    // rendering what it does recognise would drop that without a word.
    const json = await savedReport((report) => {
      report.reportSchemaVersion = String(Number(REPORT_SCHEMA_VERSION) + 1);
    });
    const html = join(workspace, "out.html");

    expect(await run(["report", json, "--html", html], streams)).toBe(EXIT_HARNESS);
    expect(stderr()).toContain(`report schema ${Number(REPORT_SCHEMA_VERSION) + 1}`);
    expect(stderr()).toContain("newer than this build understands");
    expect(stderr()).toContain("Upgrade @masterplaycoding/eventlab-cli");
    expect(existsSync(html)).toBe(false);
  });

  it("still renders a schema-2 report, the shape 0.2.x wrote", async () => {
    // Schema 3 only added fields. A CI job that saved JSON with 0.2.1 must not
    // lose the ability to look at it because the CLI was upgraded.
    const json = await savedReport((report) => {
      report.reportSchemaVersion = "2";
      delete (report.limits as Record<string, unknown>).teardownTimeoutMs;
    });
    const html = join(workspace, "out.html");

    expect(await run(["report", json, "--html", html], streams)).toBe(EXIT_OK);
    expect(readFileSync(html, "utf8")).toContain("cli scenario");
  });

  it("refuses schema 1, which predates barriers, and says what to do", async () => {
    const json = await savedReport((report) => {
      report.reportSchemaVersion = "1";
    });

    expect(await run(["report", json, "--html", join(workspace, "o.html")], streams)).toBe(
      EXIT_HARNESS,
    );
    expect(stderr()).toContain("report schema 1");
    expect(stderr()).toContain("Run the scenario again");
  });

  it("refuses a report with no schema version", async () => {
    const json = await savedReport((report) => {
      delete report.reportSchemaVersion;
    });

    expect(await run(["report", json, "--html", join(workspace, "o.html")], streams)).toBe(
      EXIT_HARNESS,
    );
    expect(stderr()).toContain("has no reportSchemaVersion");
  });

  it("says a file is not a report instead of crashing on it", async () => {
    // `null` used to reach `.attempts` and surface as a TypeError.
    const json = join(workspace, "null.json");
    writeFileSync(json, "null", "utf8");

    expect(await run(["report", json, "--html", join(workspace, "o.html")], streams)).toBe(
      EXIT_HARNESS,
    );
    expect(stderr()).toContain("is not an EventLab report");
    expect(stderr()).not.toContain("Cannot read properties");
  });
});

describe("argument handling", () => {
  it("prints usage for --help and no arguments", async () => {
    expect(await run(["--help"], streams)).toBe(EXIT_OK);
    expect(stdout()).toContain("eventlab run");

    out.length = 0;
    expect(await run([], streams)).toBe(EXIT_OK);
  });

  it("rejects unknown commands and options with exit 2", async () => {
    expect(await run(["frobnicate", "x"], streams)).toBe(EXIT_HARNESS);
    expect(await run(["run", "a.mjs", "--nope"], streams)).toBe(EXIT_HARNESS);
    expect(await run(["run", "--json"], streams)).toBe(EXIT_HARNESS);
    expect(await run(["run"], streams)).toBe(EXIT_HARNESS);
  });

  it("says which export a scenario module is missing", async () => {
    const path = join(workspace, "incomplete.mjs");
    writeFileSync(path, `export const events = [{ id: "a", body: {} }];`, "utf8");

    expect(await run(["run", path], streams)).toBe(EXIT_HARNESS);
    // Better than "cannot read properties of undefined" from inside the runner.
    expect(stderr()).toContain('must export "plan"');
  });
});
