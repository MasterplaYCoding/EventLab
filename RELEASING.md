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

1. Create a **granular access token** at npmjs.com, scoped to
   `@masterplaycoding/eventlab` only, with write permission and a short expiry.
2. Add it as the `NPM_TOKEN` secret in a **`npm-publish` environment**
   (Settings → Environments → New environment), not as a plain repository
   secret. An environment can require your approval before the job runs and
   keeps the token out of every other workflow.
3. Publish `0.1.0`.
4. Then configure the trusted publisher: npmjs.com → the package → Settings →
   Trusted Publisher → GitHub Actions, repository `MasterplaYCoding/EventLab`,
   workflow `release.yml`, environment `npm-publish`.
5. Delete the token and remove `NODE_AUTH_TOKEN` from `release.yml`.

Provenance works either way — it comes from `id-token: write` and the
workflow's OIDC claims, not from how the publish authenticated.

## Releasing

1. Set the version in `packages/core/package.json`.

2. Add a `## [0.1.0] - YYYY-MM-DD` section to `CHANGELOG.md`. The release
   workflow refuses to publish without one.

3. Verify locally, exactly as CI will:

   ```bash
   npm run typecheck && npm test && npm run verify:packaged
   ```

4. Check what will actually ship — `files` is an allowlist, and it is easy to
   publish either too little or a `node_modules`:

   ```bash
   npm pack --dry-run --workspace @masterplaycoding/eventlab
   ```

5. Commit, tag and push:

   ```bash
   git tag v0.1.0 && git push origin main v0.1.0
   ```

6. The `Release` workflow checks the tag against the package version and the
   changelog, runs typecheck, tests and the packaged-install verification, then
   publishes with provenance.

7. Confirm it landed, and that the provenance badge shows on the package page:

   ```bash
   npm view @masterplaycoding/eventlab
   ```

8. Bump `packages/core/package.json` to the next version and commit.

## After the first release

Remove the "not published yet" note and the install-from-source block from
`README.md`, and change the roadmap row from *in progress* to *released*.

## What is deliberately not automated

**No publish from a branch.** Only a `v*` tag triggers the workflow.

**No version bumping in CI.** The version is a decision, and a workflow that
edits it can publish something nobody chose to publish.

**Nothing skips `verify:packaged`.** It is the only check that exercises the
artifact a user actually installs rather than the source tree.
