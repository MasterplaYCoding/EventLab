# Changelog

All notable changes are recorded here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning. Until `1.0`, the public API and the report schema may change
between minor versions; each change will be listed here with a migration note.

## [Unreleased]

Working toward `0.1.0`, the first published release. See
[RELEASING.md](RELEASING.md).

### Fixed

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

- `formatReport(report, options?)`: renders a report as text. Pure, returns a
  string, no TTY assumptions.
- `assertRunPassed(report)`: throws with the formatted report as its message,
  so a failing run explains itself instead of producing "expected false to be
  true". `runPlan`'s never-throws contract is unchanged.
- `docs/api.md`, `docs/troubleshooting.md`, `docs/extending.md`, and a
  quickstart section on getting an application onto loopback.
- npm publishing with provenance, a tagged release workflow, a release version
  guard, and [RELEASING.md](RELEASING.md).

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

Barriers and checkpoints, the PostgreSQL recovery example, the CLI and the HTML
report. See the roadmap in the README.
