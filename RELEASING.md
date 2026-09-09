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

### 2. A token for the first publish

npm's **trusted publishing** (OIDC) is the goal — no long-lived token at all —
but it attaches to a package that already exists, so the first release has to
be bootstrapped:

1. Create a **granular access token** at npmjs.com with write permission, a
   short expiry, and scope over the `@masterplaycoding` packages. It has to
   cover both `eventlab` and `eventlab-cli`; neither exists yet, so scope it
   to the whole scope rather than to packages by name.
2. Add it as the `NPM_TOKEN` secret in a **`npm-publish` environment**
   (Settings → Environments → New environment), not as a plain repository
   secret. An environment can require your approval before the job runs and
   keeps the token out of every other workflow.
3. Publish `0.2.0`.
4. Then configure the trusted publisher, **once per package** - it is a
   per-package setting, and forgetting the CLI leaves half the release still
   depending on a token you are about to delete. For each of `eventlab` and
   `eventlab-cli`: npmjs.com → the package → Settings → Trusted Publisher →
   GitHub Actions, repository `MasterplaYCoding/EventLab`, workflow
   `release.yml`, environment `npm-publish`.
5. Delete the token and remove `NODE_AUTH_TOKEN` from `release.yml`.

Provenance works either way — it comes from `id-token: write` and the
workflow's OIDC claims, not from how the publish authenticated.

## Releasing

`0.2.0` is already prepared. Both packages are at that version, the CLI pins the
library at it, the changelog has its section, and everything below except the
tag has been run. What is left is the part that cannot be done without an
account.

1. Verify locally, exactly as CI will:

   ```bash
   npm run typecheck && npm test && npm run verify:packaged
   ```

2. Check what will actually ship — `files` is an allowlist, and it is easy to
   publish either too little or a `node_modules`:

   ```bash
   npm pack --dry-run --workspace @masterplaycoding/eventlab
   ```

   ```bash
   npm pack --dry-run --workspace @masterplaycoding/eventlab-cli
   ```

3. Make the claims that are only true on the day true:

   - replace `unreleased` on the `## [0.2.0]` heading in `CHANGELOG.md` with
     the date;
   - in `README.md`, delete the *Why not `npm install …`?* section and put the
     registry install above the build-from-source one, which stays — it is how
     anyone works on the library rather than with it;
   - delete the **Not on npm yet** notes in `docs/quickstart.md` and
     `docs/cli.md`. The install commands beside them are already written in
     their released form, so nothing else in either file changes.

   Commit both.

4. Tag and push:

   ```bash
   git tag v0.2.0 && git push origin main v0.2.0
   ```

5. The `Release` workflow checks the tag against both package versions and the
   changelog, runs typecheck, tests and the packaged-install verification, then
   publishes the library with provenance and the CLI after it. That order
   matters: the CLI depends on the exact library version, so publishing it
   first would put a package on the registry that cannot install.

6. Confirm from outside, in a scratch directory rather than this repository:

   ```bash
   npm install @masterplaycoding/eventlab && npx eventlab --help
   ```

   `verify:packaged` proves the tarball is correct; only this proves it is
   reachable. Check the provenance badge on the package page while you are
   there.

7. Bump both packages and the CLI's pinned dependency to the next version and
   commit.

## Subsequent releases

Steps 1-7 with the new version substituted, plus setting the version in
`packages/core/package.json`, `packages/cli/package.json` and the CLI's
dependency on the library — all three, or the release guard stops the workflow
before it publishes anything.

## What is deliberately not automated

**No publish from a branch.** Only a `v*` tag triggers the workflow.

**No version bumping in CI.** The version is a decision, and a workflow that
edits it can publish something nobody chose to publish.

**Nothing skips `verify:packaged`.** It is the only check that exercises the
artifact a user actually installs rather than the source tree.
