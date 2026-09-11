# Changelog

All notable changes are recorded here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning. Until `1.0`, the public API and the report schema may change
between minor versions; each change will be listed here with a migration note.

## [0.4.0] - unreleased

The date becomes real on the day it is tagged; see [RELEASING.md](RELEASING.md).

The roadmap's 0.4 milestone - framework recipes for Express, Fastify, NestJS and
Next.js, each a runnable test - and the machinery 1.0 will rest on: a committed
API report, golden plans from every release, and a check that a report or plan
shape cannot change without its version moving. The packages themselves change
only in one declaration: the CLI's `USAGE` is typed `string` instead of its
literal text.

### Added

- **Framework recipes, each a runnable test.** `examples/frameworks` points
  EventLab at a webhook served by Express 5, Fastify 5 and NestJS 12, and
  `examples/frameworks/nextjs` at a Next.js 16 route handler through a real
  Next server. One scenario runs unchanged against all four, and every recipe
  must fulfil each order once under duplicate, concurrent deliveries; accept a
  signature over a pretty-printed body, which only works if the route reads
  the raw bytes; refuse the same deliveries signed with the wrong key; and
  listen on loopback, finish `teardown` inside its budget, and release its
  port. Each of those was confirmed to fail when the recipe gets it wrong —
  JSON parsing instead of raw, no signature check, no deduplication, a close
  that does not close, Nest without `rawBody`, Fastify without its buffer
  parser, and a Next route that calls `request.json()` first.

  `pitfalls.test.ts` makes the two raw-body mistakes on purpose and shows how
  EventLab reports them; `scoping.test.ts` checks that the raw-body handling
  stays on the webhook route and the rest of the app still gets parsed JSON.
  [docs/recipes.md](docs/recipes.md) walks through all four.

  Next.js is kept out of the workspace: it is a ~300 MB install plus a build,
  so it has its own package and lockfile, its own CI job on Ubuntu, and
  `npm run test:nextjs`. The other three run in `npm test` on every platform.

### Changed

- **A compatibility policy, [docs/compatibility.md](docs/compatibility.md),**
  covering the three things people keep - saved plans, JSON reports and
  code written against the API - plus the CLI, with the check behind every
  promise.

- **A shape change without a version bump now fails the build.** In 0.3 the
  report gained `limits.teardownTimeoutMs` and a `timed-out` cleanup status
  while `REPORT_SCHEMA_VERSION` stayed at 2, and only a careful reading of
  the diff caught it. `versionedShapes.test.ts` reads the report's types and
  the saved plan's types out of `etc/eventlab.api.md` - which `api:check`
  keeps identical to the built declarations - and compares them with the
  shape recorded for the current `REPORT_SCHEMA_VERSION` and
  `PLANNER_VERSION`. Changing a shape therefore means bumping the version and
  recording a new snapshot under `packages/core/test/versioned-shapes/`; the
  old snapshots stay, as a history of every version's shape. Replaying the
  0.3 mistake - a field added to `RunReport`, the API report regenerated, the
  schema version left alone - fails with "the report shape changed but
  REPORT_SCHEMA_VERSION is still 3. Bump it".

- **Golden plans from the released packages.** The README's first
  guarantee - the same seed and inputs produce the same plan - was tested
  only within a build: the planner's property tests prove determinism and
  valid shuffles, and would all pass if a refactor changed *which* valid
  shuffle a seed produces. PLANNER_VERSION would stay put, and every seed in
  every report ("rebuild with seed X and planner version Y") would quietly
  mean a different plan. `tools/golden-plans` installs a released
  `@masterplaycoding/eventlab` from npm and writes five plans - every
  transform, both orders of the order-sensitive ones, a seed near the top of
  the range, and phases with a barrier - into
  `packages/core/test/golden-plans/<version>/`; `goldenPlans.test.ts`
  requires this build to serialise the same inputs to the same text while
  the planner version matches, and requires `parsePlan` to refuse them once
  it does not. 0.2.0, 0.2.1 and 0.3.0 planned identically. Confirmed: running
  Fisher-Yates forwards instead of backwards - still a correct shuffle -
  fails the three golden tests and passes the other 125.

- **The public API is a committed file.** `packages/core/etc/eventlab.api.md`
  and `packages/cli/etc/eventlab-cli.api.md` are API Extractor reports of
  every exported signature, and `npm run api:check` - in CI and before every
  release - fails when the built declarations no longer match them. Changing
  the API now means running `npm run api` and committing the diff, so it is
  reviewed rather than a side effect; the check was confirmed to fail on a
  single stray `export const`. Two small corrections came with it: a
  `{@link phases}` in `CreatePlanOptions` that pointed nowhere, and the CLI's
  `USAGE`, which was exported as a string *literal* type - making every
  wording change to `--help` a change to the public API. It is typed
  `string`; the exit codes stay literal, because those are the contract.

- **Vitest 5** (from 3), which clears the one advisory `npm audit` reported
  (GHSA-82fw-gwwq-j7x9, in `@vitest/mocker`; development only - neither
  published package depends on Vitest). It also exposed that fourteen CLI
  tests had been passing on a resolution path no user has: they wrote
  scenario modules to the OS temp directory, where
  `import "@masterplaycoding/eventlab"` cannot resolve, and Vitest 3 resolved
  it for them. The CLI loads scenarios with Node's own `import()`, which
  resolves from the scenario's directory like any user's project would. The
  tests now write scenarios inside the repository (under the gitignored
  `.eventlab/`), so they exercise that path.

- **Benchmarks are off the roadmap**, replaced by the ceiling tests already
  in the suite — the response-body and teardown bounds — which fail the build
  instead of reporting a number. The README's `0.4` row says so.

### Fixed

- **The quickstart's loopback section could not work as written.** It showed
  an app started in `hooks.setup` alongside a `baseUrl` known in advance — but
  EventLab resolves `baseUrl` *before* `setup`, so an app on an ephemeral port
  has no address to give at that point. It also said to shut down in
  `teardown` while its snippet shut down in `afterEach`, and bound every
  interface rather than loopback. It now starts the app before `runPlan`,
  closes it in `teardown`, listens on `127.0.0.1`, and links the recipes,
  which are where that shape is tested.

## [0.3.0] - 2026-09-11

Restarting the application under test mid-scenario, bounded teardown, and
report schema `3` — the one change here that needs a consumer's attention; see
*Changed* for the migration line.

### Added

- `redaction.test.ts`: the report's redaction promise, tested by delivering
  secrets rather than by constructing a fixture that already has none. A real
  delivery carrying a provider signature, a bearer token and a card number, and
  none of them appear in the report's JSON or in `formatReport` output — which
  matters more, since that is what `assertRunPassed` throws into a CI log.
  Header *names* and body *size* survive, because a missing signature header
  and a truncated payload are both real bugs and neither needs the value.

  It also pins the limit: **the request URL is recorded in full**, query string
  included. That is a deliberate trade — a redacted URL would make a delivery
  unidentifiable — but a provider that authenticates by query parameter puts a
  credential in the report, and someone attaching one to a public issue should
  know that before they do. The README's guarantees row now says so.

- `packages/cli/test/html.test.ts`: the timeline is a file people forward, and
  everything in it — scenario names, attempt ids, URLs, assertion messages —
  comes from outside the process. Nothing tested the escaping that keeps that
  from being an injection surface. Covers each of those fields against a script
  payload and an attribute-breaking quote, that `&` is escaped before the
  entities escaping introduces, that response bodies stay omitted even though
  the report holds them, that the document references nothing outside itself,
  and that bar geometry cannot emit `NaN` when every attempt is instantaneous.
- `packages/cli/test/scenario.test.ts`: which export is missing, from which
  file, for each of the six ways a scenario module can be incomplete — plus a
  file that does not exist, one that does not parse, and one that throws a
  string.

- **Restarting the application under test mid-scenario.** `target.baseUrl` may
  now be a function, resolved once per phase instead of once per run. That one
  change is what makes a restart testable: a barrier already provides the quiet
  moment and a checkpoint already runs arbitrary code in it, but a process that
  came back on a fresh ephemeral port could not be reached afterwards, because
  the address had been captured before the first delivery.

  Once per phase rather than once per attempt, because deliveries within a
  phase run concurrently and must all reach the same process — a per-attempt
  resolution would let one phase straddle a restart and report deliveries
  against something that had already gone.

  Every resolution is validated, not just the first, so a restart cannot move
  the target to a host the run was never allowed to touch. An address that is
  unusable afterwards is a **harness error** rather than a failed barrier: the
  application never got the chance to fail anything, and reporting it as a
  checkpoint failure would blame it for something it did not do.

- `examples/restart`: a handler that deduplicates in a `Set`. It keys on the
  order rather than the event, so it is *not* the README's bug — within one
  process it is correct, and every single-process test passes. What it gets
  wrong is the lifetime. Restart it and the set is empty while the database
  still holds every fulfilment it made, so the next redelivery notifies the
  customer a second time. Every request returns 200 throughout.

- A guarantee-and-limit row for target resolution, and a concepts section on
  restarts.

### Fixed

- **A `teardown` that never returned made `runPlan` never return.** Teardown
  runs after `scenarioTimeoutMs` has been cleared — it has to, because a run
  that timed out still needs cleaning up — so nothing was left to bound it. A
  hook awaiting something that never settles produced no report at all, which
  is a worse outcome than any failure a report could have described, and the
  runner reported it as "test timed out" with no hint of the cause.

  `teardownTimeoutMs` (default 5,000) now bounds it, and `cleanup.status`
  gains `timed-out`. The message says plainly that EventLab stopped waiting
  rather than stopped the hook — a promise that never settles cannot be
  cancelled from outside, so whatever it held it still holds, which is why the
  process may not exit afterwards.

  `docs/api.md` described `scenarioTimeoutMs` as bounding the "whole run".
  It never bounded teardown; it now says so.

  A timed-out teardown **fails the run**, as a teardown that throws always
  has, and `formatReport` prints it as `teardown timed out:`. As first
  written, `passed` only excluded `failed`, so an overrun left the run green
  and the formatted report said nothing — CI would print ✓ and then hang on
  exit, which is the exact "no hint of the cause" this fix set out to remove.
  `passed` now lists the acceptable statuses (`ok`, `skipped`) instead of the
  unacceptable one, so a status added later fails until someone decides
  otherwise. The teardown line is printed after a harness error too, because
  it is what explains the hang that follows one.

- **A large response body cost the whole request timeout.** Once the response
  reader reached `maxResponseBodyBytes` it marked the preview truncated and
  then carried on reading to the end of the body, discarding everything it
  read. Memory stayed bounded, which is what the report promised; the work did
  not. Measured against a target streaming 64 KiB chunks, keeping a 1 KiB
  preview drained **32 MiB** — and against a body that never ends, the delivery
  ran until the request timeout and was reported as a *timeout*, which is a
  statement about the application that was simply untrue. It had responded, and
  responded at once.

  The reader now stops at the limit and cancels the body. Cancellation is not
  awaited: it settles when the transport has finished tearing the connection
  down, and against a target still writing at full speed that takes about as
  long as the thing being cancelled — which would make the delivery wait for
  exactly the work it had just decided to stop doing.

  The same scenario now completes in about 50 ms rather than 10 seconds, and
  the target writes under 4 MiB rather than 32. The connection is no longer
  reusable afterwards, which is the intended trade and is stated in the README.

- **The HTML timeline showed "failed" without a reason** whenever the reason
  was not an assertion. It never rendered `harnessError` or `cleanup`, so a
  blocked target, a failed setup or a teardown that threw produced a red
  verdict above an empty or entirely green assertion list — a timeline that
  sent its reader to the JSON, which is the one thing it exists to spare them.
  Both now get a section, escaped like everything else, since a harness
  message quotes the offending input and a teardown message is whatever the
  hook threw.

- **The library's own tests were never typechecked.** `packages/core` and
  `packages/cli` compile `src/` only, and Vitest strips types without
  checking them, so twenty type errors sat in the tests unseen. Most were
  stale fixtures, but three made tests weaker than they read: two fixtures
  built a timeout with `elapsedMs` (the field is `afterMs`), so the
  timeline's "every outcome kind" test rendered `timeout after undefined ms`
  and passed because it checked only ids; and `summariseStatuses` was tested
  against a `network-error` outcome that does not exist, never against the
  real `transport-error`. `npm run typecheck` now also checks
  `tsconfig.test.json`, and that timeline test asserts what each row says.

- **A scenario module that throws a non-Error reported `undefined`.** The
  loader read `.message` off whatever the import rejected with, so
  `throw "the database was unreachable"` in a scenario produced
  `could not import scenario.mjs: undefined` — the one message guaranteed to
  help nobody. It now falls back to the value itself.

### Changed

- **`REPORT_SCHEMA_VERSION` is `3`.** Reports gained `limits.teardownTimeoutMs`,
  and `cleanup.status` can now be `"timed-out"`. That is the same kind of
  change that moved it to `2` in `0.2.0`, and the constant's own
  documentation tells consumers to branch on it — a promise that means
  nothing if the shape can change underneath an unchanged number.

  **Migration:** a consumer that checks `reportSchemaVersion` should accept
  `"3"`. One that switches exhaustively on `cleanup.status` needs a
  `"timed-out"` arm, and should treat it as a failure, as `passed` does.
  Nothing was removed or renamed, so a schema-2 reader that ignores unknown
  fields and values keeps working.

  `PLANNER_VERSION` stays `2`: the plan did not change shape. `baseUrl`
  becoming a function lives in `RunOptions`, not in the plan, so every saved
  `0.2.x` plan replays unchanged.

- **`eventlab report` checks the schema before rendering.** It never looked
  at `reportSchemaVersion`; it checked only that `attempts` was an array.
  It now renders schemas 2 and 3 and refuses anything else with exit 2 and
  a message naming both versions. Newer schemas are refused rather than
  rendered in part, because what a renderer skips is what it does not
  recognise — the timeline itself spent `0.2.x` dropping `harnessError` and
  `cleanup` that way (see *Fixed*). A report file containing `null` now says
  it is not a report instead of surfacing a `TypeError`.

- `resolveBaseUrl` is now async and returns a `Promise<URL>`. Internal; the
  exported surface is unchanged apart from `baseUrl` accepting a function,
  which is additive — every existing scenario passing a string is unaffected.

## [0.2.1] - 2026-09-10

### Fixed

- **`isHarnessError` was not safe across realm boundaries**, which is the one
  thing its documentation promised. It tested `value instanceof Error`, and
  that compares against *this* realm's `Error`, so a genuine `HarnessError`
  crossing out of a `node:vm` context or a worker was reported as not being
  one. It now identifies an error by `Object.prototype.toString`, which is
  defined on the value's own realm, and requires a `code` so the name alone
  cannot let something else through.
- **Failure messages from another realm printed the class name.** The three
  places that turned a thrown value into text all used the same
  `instanceof Error` test and all fell through to `String(cause)`, rendering
  an assertion's `expected 2, found 3` as `Error: expected 2, found 3`. The
  values arriving there are assertion failures and request-builder failures -
  user code, which is the code most likely to be running somewhere other than
  this realm.

### Changed

- The three copies of "get the message off this thrown thing" are now one
  `describeCause`, with the best behaviour of the three: the HTTP client
  unwrapped a nested `cause` and the other two did not, so a network failure
  read as `fetch failed` where it now reads
  `fetch failed: ECONNREFUSED 127.0.0.1:3000`.

### Added

- `packages/core/test/exports.test.ts`, covering five exports that no test
  referenced: `isHarnessError`, `countDeliveries`, `deliveriesFor`,
  `summariseStatuses` and the two version constants. Public, documented, and
  in the state where behaviour is whatever it happens to be rather than what
  it says it is. One of the five was wrong.
- `describeCause` tests, including the realm case that motivated it.

## [0.2.0] - 2026-09-10

### Fixed

- **An already-aborted `AbortSignal` was ignored.** A signal fires its event
  once, so subscribing alone meant a caller who had already cancelled got the
  entire scenario executed anyway. Found while testing barriers.
- **The README printed a failure block no code could produce.** Every fact in
  it was verified; the rendering was typeset by hand. `formatReport` now
  produces it, and the acceptance fixture asserts its output equals the block
  in `README.md`, checked against the packed tarball on every CI job.
- **`npm test` in an example directory did nothing** — neither example package
  had a `scripts` block, and the README told readers to run it there.
- **The quickstart could not reproduce the README's bug.** It defined two
  fixtures; the bug requires the third.
- **`docs/concepts.md` named the wrong field**: `EventFixture` carries `id`,
  not `eventId`.
- **`npm run docs` always failed** — the script was declared with no TypeDoc
  configuration. Wiring it up found `Rng` reachable through `Transform`'s
  public signature but not exported.
- **The examples were never type-checked**, so a `possibly undefined` index
  read in the voting store went unnoticed.

### Added

- **`@masterplaycoding/eventlab-cli`**, a second published package:
  `eventlab run` executes a scenario module, `eventlab replay` runs a saved
  plan against one, and `eventlab report` renders a JSON report as a
  standalone HTML timeline. Exit codes distinguish "your application failed"
  (1) from "the scenario could not run" (2).
- A static HTML timeline: one file, no server, no network, no analytics.
  Response bodies are deliberately omitted even though the report holds them.

- **Barriers.** `createPlan({ phases })` splits a plan at synchronisation
  points: everything before a barrier completes before anything after it is
  released, and a named checkpoint in `hooks.checkpoints` runs in between.
  This is the constructive answer to docs/decisions/001 - a scenario waits for
  a signal the application emits rather than for a duration somebody guessed.
- `examples/inbox-outbox`: durable inbox/outbox processing that survives a
  worker killed mid-transaction, on `node:sqlite` (built into Node 22+, so no
  Docker and no install). Turns docs/decisions/003 from a design note into a
  running example. The library still has no database dependency.
- `examples/barrier-settlement`: a refund that must not be applied before its
  payment has settled. Needs a barrier to test at all, because "what is true
  after the worker finishes" cannot be asked by waiting longer.
- `formatReport(report, options?)`: renders a report as text. Pure, returns a
  string, no TTY assumptions.
- `assertRunPassed(report)`: throws with the formatted report as its message,
  so a failing run explains itself instead of producing "expected false to be
  true". `runPlan`'s never-throws contract is unchanged.
- `docs/api.md`, `docs/troubleshooting.md`, `docs/extending.md`, and a
  quickstart section on getting an application onto loopback.
- npm publishing with provenance, a tagged release workflow, a release version
  guard, and [RELEASING.md](RELEASING.md).

### Changed

- `PLANNER_VERSION` and `REPORT_SCHEMA_VERSION` are both `2`.
  `DeliveryAttempt` gained `phase`, and plans and reports gained `barriers`.
  Saved version-1 plans are refused with the message that mechanism exists for.

### Previously added, toward the 0.1 engineering gate

- `createPlan()`: seeded, validated expansion of a scenario into a
  serialisable `DeliveryPlan`. All randomness is consumed here.
- Transforms: `duplicate`, `shuffle`, `delay`, `burst`, applied in declaration
  order and recorded in the plan.
- `runPlan()`: HTTP execution with bounded concurrency, per-request and
  per-scenario timeouts, monotonic timing, cancellation and guaranteed
  teardown.
- Assertions: `check` (run once) and `eventually` (polled to a deadline),
  reported separately from delivery outcomes.
- `RunReport`: schema-versioned JSON with intended and observed timing,
  four separate outcome categories, and reproduction metadata.
- `serializePlan()` / `parsePlan()` / `assertFixturesMatch()`: saved plans that
  refuse to run against a different planner version or edited fixtures.
- Examples: a duplicate payment handler in broken and corrected form, and a
  voting endpoint adapted from GOATalking in vulnerable and corrected form.
- CI on Linux, Windows and macOS with Node 22 and 24, including a packed-tarball
  install check that runs the README example as a real consumer would.

### Notable behaviour

- Deliveries are loopback-only unless `allowRemoteTargets` is set.
- No automatic retries, and redirects are not followed.
- Reports never contain request bodies and record request header names only.
- With no declared expectation, a run passes only if every delivery returned
  2xx.

### Not yet implemented

Controlled restart hooks, benchmarks, and recipes for unfamiliar frameworks.
See the roadmap in the README.
