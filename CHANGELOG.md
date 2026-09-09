# Changelog

All notable changes are recorded here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning. Until `1.0`, the public API and the report schema may change
between minor versions; each change will be listed here with a migration note.

## [0.2.0] - unreleased

Prepared in full; the date becomes real on the day it is tagged. Publishing
needs credentials no repository should hold - see [RELEASING.md](RELEASING.md).

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
