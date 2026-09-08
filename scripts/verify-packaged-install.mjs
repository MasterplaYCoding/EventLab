/**
 * Packs the library, installs the tarball into a clean directory outside the
 * workspace, and runs the README acceptance fixture against it.
 *
 * Testing from the workspace proves the source compiles. It does not prove the
 * thing users install works: `files`, `exports`, `type`, the generated
 * declaration files and the absence of accidental workspace-only imports are
 * all invisible until something consumes the tarball. This script closes that
 * gap, and CI runs it on every supported platform and Node version.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const corePackage = join(repoRoot, "packages", "core");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// npm is a shell script on Windows and needs a shell to launch; node is not,
// and running it through a shell mangles the space in "Program Files".
const run = (command, args, cwd) =>
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && command === npm,
  });

const consumer = mkdtempSync(join(tmpdir(), "eventlab-consumer-"));

try {
  console.log("→ building the library");
  run(npm, ["run", "build", "--workspace", "@masterplaycoding/eventlab"], repoRoot);

  console.log("→ packing the library");
  run(npm, ["pack", "--pack-destination", consumer], corePackage);
  const tarball = readdirSync(consumer).find((entry) => entry.endsWith(".tgz"));
  if (tarball === undefined) {
    throw new Error("npm pack produced no tarball");
  }

  console.log(`→ installing ${tarball} into a clean consumer at ${consumer}`);
  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "eventlab-consumer", private: true, type: "module", version: "0.0.0" }, null, 2)}\n`,
  );
  // --no-package-lock keeps this a genuinely fresh resolution rather than one
  // seeded by the workspace's own lockfile.
  run(npm, ["install", "--no-package-lock", `./${tarball}`], consumer);

  console.log("→ running the README example against the installed package");
  cpSync(join(repoRoot, "acceptance", "readme-example.mjs"), join(consumer, "readme-example.mjs"));
  // The fixture compares formatReport's output to the console block printed in
  // the README, so the README itself is an input to the check.
  cpSync(join(repoRoot, "README.md"), join(consumer, "README.md"));
  run(process.execPath, ["readme-example.mjs"], consumer);

  console.log("✓ packaged install verified");
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
