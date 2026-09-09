/**
 * Guards the one part of a release a human types.
 *
 * The tag is the input most likely to disagree with the repository, and an npm
 * publish cannot be undone - unpublishing is restricted and republishing the
 * same version is forbidden - so a mismatch has to become a failed job rather
 * than a package released under the wrong version.
 *
 * Usage: node scripts/check-release-version.mjs v0.1.0
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

const tag = process.argv[2];
if (tag === undefined) {
  fail("usage: node scripts/check-release-version.mjs <tag>");
}

const expected = tag.startsWith("v") ? tag.slice(1) : tag;

const manifest = JSON.parse(
  await readFile(resolve(repoRoot, "packages/core/package.json"), "utf8"),
);

if (manifest.version !== expected) {
  fail(
    `tag ${tag} does not match packages/core/package.json version ${manifest.version}`,
  );
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  fail(`version "${manifest.version}" is not a valid semantic version`);
}

const changelog = await readFile(resolve(repoRoot, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`## [${expected}]`)) {
  fail(`CHANGELOG.md has no "## [${expected}]" section`);
}

// provenance requires the repository field to correspond to the building repo;
// npm rejects the attestation otherwise, and it is easier to catch here.
if (manifest.repository?.url?.includes("MasterplaYCoding/EventLab") !== true) {
  fail("packages/core/package.json is missing a repository url for provenance");
}

// The CLI pins the library at an exact version, so a release where the two
// disagree would publish a CLI that cannot resolve its own dependency.
const cli = JSON.parse(await readFile(resolve(repoRoot, "packages/cli/package.json"), "utf8"));

if (cli.version !== expected) {
  fail(`packages/cli is at ${cli.version}, but the tag says ${expected}`);
}

const pinned = cli.dependencies?.["@masterplaycoding/eventlab"];
if (pinned !== expected) {
  fail(
    `packages/cli depends on eventlab@${pinned}, which is not the version ` +
      `being released (${expected})`,
  );
}

console.log(`✓ ${tag} matches both packages at ${manifest.version}, with a changelog entry`);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
