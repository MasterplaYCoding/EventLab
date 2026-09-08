# Contributing

## Getting set up

```bash
npm ci
npm run typecheck
npm test
npm run verify:packaged
```

Node 22 or 24. No database, no Docker and no cloud account is needed for
anything in the repository today.

## What a change needs

- **A test that fails without it.** For a bug, the test should reproduce the
  bug; for a feature, it should exercise the public API rather than internals.
- **A guarantee stated with its limit.** If a change adds something the library
  promises, the documentation says where that promise stops. This is a
  house rule, not a style preference: an overstated guarantee in a testing tool
  is worse than a missing feature.
- **A commit message that explains the reasoning**, not just the diff.

## Things that will be pushed back on

- Sleep-based coordination in tests. If a test needs to wait for a boundary,
  the application under test should signal it. See
  [docs/decisions/001-determinism-boundary.md](docs/decisions/001-determinism-boundary.md).
- Anything that implies a timeout proves a write did not happen. See
  [002](docs/decisions/002-timeouts-prove-nothing.md).
- Automatic retries anywhere in the runner. Every request a target sees must
  correspond to an attempt in the plan.
- Runtime dependencies in the core package, unless there is no reasonable
  alternative.
- Importing a test runner from library source.

## Small, real contribution opportunities

These are genuinely useful and genuinely self-contained:

1. **More transforms.** `dropRandom({ probability })` to model a lossy
   transport, or `outOfOrderPairs()` for a targeted swap rather than a full
   shuffle. Needs a `TransformRecord`, a property test, and a paragraph in the
   quickstart table.
2. **A `content-length` sanity check** in the HTTP client: warn in the report
   when a response declares a length that disagrees with the bytes received.
3. **Better transport-error messages on Windows.** `ECONNREFUSED` surfaces
   differently across platforms; normalising the message would make reports
   more comparable.
4. **A recipe page** for an unfamiliar framework (Fastify, Hono, Django,
   Rails). The value is in finding the integration friction, so please write
   down whatever was awkward.
5. **Report summary helpers.** `groupByEvent(report)` and similar, in
   `packages/core/src/report/summary.ts`, so users write fewer `filter` calls.

Larger items — barriers, checkpoints, the PostgreSQL example, the CLI, the HTML
report — are on the roadmap in the README. Please open an issue before starting
one of those, so the API shape can be agreed first.

## Reporting a bug you found *with* EventLab

Attach the serialised plan. It contains instructions only, no payloads, so it
is safe to put in a public issue:

```ts
await writeFile("repro.plan.json", serializePlan(plan));
```

Include the seed, the planner version and the fixture digest. All three are in
the report.
