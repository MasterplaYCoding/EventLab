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

// Every file a package promises to ship has to exist. `files` is an allowlist,
// and npm does not warn about an entry that matches nothing - it simply packs
// one file fewer. Both packages listed a LICENSE neither of them had, so an
// MIT-licensed library was about to be published with no licence text in the
// tarball, and the CLI listed a README that did not exist, which renders its
// registry page blank.
const rootLicence = await readFile(resolve(repoRoot, "LICENSE"), "utf8");

for (const workspace of ["packages/core", "packages/cli"]) {
  const packaged = JSON.parse(
    await readFile(resolve(repoRoot, workspace, "package.json"), "utf8"),
  );

  for (const entry of packaged.files ?? []) {
    if (entry === "dist") continue; // a directory, produced by the build
    const contents = await readFile(resolve(repoRoot, workspace, entry), "utf8").catch(
      () => undefined,
    );
    if (contents === undefined) {
      fail(`${workspace}/package.json lists "${entry}" in files, but there is no such file`);
    }
    // A per-package copy can drift from the licence the repository actually
    // grants, which is worse than not shipping one at all.
    if (entry === "LICENSE" && contents !== rootLicence) {
      fail(`${workspace}/LICENSE differs from the repository's LICENSE`);
    }
  }
}

console.log(
  `✓ ${tag} matches both packages at ${manifest.version}, with a changelog entry` +
    " and every file they promise to ship",
);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}
