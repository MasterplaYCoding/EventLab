# Changelog

All notable changes are recorded here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic
versioning. Until `1.0`, the public API and the report schema may change
between minor versions; each change will be listed here with a migration note.

## [Unreleased]

Working toward `0.1`.

### Added

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
