# Releasing

Publishing is automated; the account is not. This is the one-time setup, then
the per-release steps.

## One-time setup

### 1. Reserve the scope

`@masterplaycoding` must exist on npm and be yours, and it must allow public
packages.

```bash
npm login
npm org ls masterplaycoding   # or create the scope at npmjs.com
```

### 2. Publishing credentials

There are none, and that is the point. npm authenticates this repository's
release workflow through **trusted publishing** (OIDC): npm is configured to
trust `MasterplaYCoding/EventLab`, the workflow file `release.yml`, and the
`npm-publish` environment, and issues a short-lived credential to that
combination. Nothing long-lived is stored anywhere.

This was bootstrapped with a granular access token for `0.2.0`, because a
trusted publisher attaches to a package that already exists and neither
package did. That token has been deleted.

If a package is ever added to this repository, it needs its own trusted
publisher before it can be released - the setting is per package, not per
repository. On npmjs.com: the package → Settings → Trusted Publisher → GitHub
Actions, organization `MasterplaYCoding`, repository `EventLab`, workflow
filename `release.yml`, environment name `npm-publish`, and **Allow
`npm publish`** ticked. Without that last box the publisher may only stage,
and the release fails at the publish step.

## Releasing

Substitute the version you are releasing for `X.Y.Z` throughout.

1. Set the version in **three** places. All three, or the release guard stops
   the workflow before it publishes anything:

   - `packages/core/package.json` → `version`
   - `packages/cli/package.json` → `version`
   - `packages/cli/package.json` → `dependencies["@masterplaycoding/eventlab"]`

   The CLI pins the library at an exact version, so a release where the two
   disagree would put a package on the registry that cannot install.

2. In `CHANGELOG.md`, rename the `## [Unreleased]` heading to
   `## [X.Y.Z] - <today>`. The workflow refuses to publish without a section
   matching the tag.

3. Verify locally, exactly as CI will:

   ```bash
   npm run typecheck && npm test && npm run verify:packaged
   ```

   ```bash
   node scripts/check-release-version.mjs vX.Y.Z
   ```

   The second is the one that catches a version set in two places out of
   three, and a file a package claims to ship but does not have.

4. Check what will actually ship — `files` is an allowlist, and it is easy to
   publish either too little or a `node_modules`:

   ```bash
   npm pack --dry-run --workspace @masterplaycoding/eventlab
   ```

   ```bash
   npm pack --dry-run --workspace @masterplaycoding/eventlab-cli
   ```

5. Commit, tag and push:

   ```bash
   git commit -am "chore(release): X.Y.Z" && git tag vX.Y.Z && git push origin main vX.Y.Z
   ```

   The tag is what triggers the workflow. Pushing `main` alone does nothing.

6. The `Release` workflow checks the tag against both package versions and the
   changelog, runs typecheck, tests and the packaged-install verification, then
   publishes the library with provenance and the CLI after it.

   **npm publishes immediately and irreversibly.** There is no hold-and-confirm
   step as there is on Maven Central, which is why every check runs first.

7. Confirm from outside, in a scratch directory rather than this repository —
   inside, npm resolves the workspace copy and proves nothing:

   ```bash
   cd $(mktemp -d) && npm init -y && npm install @masterplaycoding/eventlab @masterplaycoding/eventlab-cli
   ```

   ```bash
   npx eventlab --help
   ```

   Check the provenance badge on the package page while you are there.

8. Open the next version: bump all three fields from step 1 to the next
   version, add a fresh `## [Unreleased]` heading, and commit. Leave the README
   at the released version — it advertises what a user can depend on, not what
   the working tree is building.

## If a release goes wrong

A published version is permanent; npm's unpublish policy is narrow and
republishing the same version is forbidden. The fix is always `X.Y.Z+1`, never
a replacement.

If the workflow fails *before* the publish steps, nothing was published. Fix
the cause, delete the tag, and tag again:

```bash
git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z
```

If the library published and the CLI did not, the library version is spent.
Bump to the next patch version and release both together rather than trying to
publish the CLI alone against a version it no longer matches.

## What is deliberately not automated

**No publish from a branch.** Only a `v*` tag triggers the workflow.

**No version bumping in CI.** The version is a decision, and a workflow that
edits it can publish something nobody chose to publish.

**Nothing skips `verify:packaged`.** It is the only check that exercises the
artifact a user actually installs rather than the source tree.
