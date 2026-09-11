/**
 * Writes the golden plans with *released* EventLab packages from npm.
 *
 *   cd tools/golden-plans && node generate.mjs 0.2.0 0.2.1 0.3.0
 *
 * Each version is installed into its own directory under ./releases, outside
 * the workspace, so nothing built from this tree can leak in: the goldens have
 * to record what users' copies of each release actually planned. Output goes
 * to packages/core/test/golden-plans/<version>/<scenario>.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { scenarios } from "../../packages/core/test/golden-plans/scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../../packages/core/test/golden-plans");
const versions = process.argv.slice(2);
if (versions.length === 0) {
  console.error("usage: node generate.mjs <version> [<version>...]");
  process.exit(2);
}

for (const version of versions) {
  const prefix = join(here, "releases", version);
  mkdirSync(prefix, { recursive: true });
  writeFileSync(join(prefix, "package.json"), JSON.stringify({ private: true, type: "module" }));
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefix", prefix, `@masterplaycoding/eventlab@${version}`], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const entry = join(prefix, "node_modules", "@masterplaycoding", "eventlab", "dist", "index.js");
  const released = await import(pathToFileURL(entry).href);
  const installed = JSON.parse(
    (await import("node:fs")).readFileSync(join(prefix, "node_modules", "@masterplaycoding", "eventlab", "package.json"), "utf8"),
  ).version;
  if (installed !== version) throw new Error(`asked for ${version}, npm installed ${installed}`);

  const target = join(output, version);
  mkdirSync(target, { recursive: true });
  for (const { name, plan } of scenarios(released)) {
    writeFileSync(join(target, `${name}.json`), released.serializePlan(plan));
  }
  console.log(`wrote ${scenarios(released).length} plans for ${version} (planner ${released.PLANNER_VERSION})`);
}
