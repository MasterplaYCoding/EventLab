# API reference

Everything exported from `@masterplaycoding/eventlab`. Generated TypeDoc output
covers the same surface in more detail; this page is the map.

## Planning

### `createPlan(options): DeliveryPlan`

| Option | Required | Default | Meaning |
|---|---|---|---|
| `events` | yes | — | The fixtures. At least one, with unique ids not containing `#`. |
| `seed` | yes | — | Any integer. The same seed and inputs always expand identically. |
| `scenario` | no | `"scenario"` | Names the run in reports. |
| `transforms` | no | `[]` | Applied in declaration order. |
| `concurrency` | no | `4` | Maximum attempts in flight. |

Only `events` and `seed` are required, despite every example passing more.

### Transforms

| Transform | Effect |
|---|---|
| `duplicate({ copies })` | Deliver each event `copies` times in total |
| `shuffle()` | Reorder attempts, using the seed |
| `delay({ minMs, maxMs })` | Draw a start offset per attempt |
| `burst()` | Reset every offset to zero |

Writing your own is a supported extension point — see
[extending.md](extending.md).

### Saved plans

- `serializePlan(plan): string` — instructions only, never payloads.
- `parsePlan(source): DeliveryPlan` — validates, and refuses a plan built by a
  different planner version rather than regenerating it.
- `assertFixturesMatch(plan, events): void` — throws if the fixtures changed
  since the plan was saved. `runPlan` calls this for you; it is exported so you
  can check before doing expensive setup.

## Running

### `runPlan(plan, options): Promise<RunReport>`

**`runPlan` never throws.** Every failure — an invalid scenario, a blocked
target, a failing `setup` — comes back as a report with `harnessError` set. If
a result surprises you, look there first.

| Option | Required | Default | Meaning |
|---|---|---|---|
| `target` | yes | — | `baseUrl`, a `request` builder, optional `timeoutMs`. |
| `events` | yes | — | The same fixtures the plan was built from. |
| `hooks` | no | — | `setup`, `reset`, `teardown`. |
| `assertions` | no | `[]` | Your checks. |
| `expect` | no | `{ deliveries: "all-2xx" }` | See below. |
| `limits` | no | see below | Timeouts and body cap. |
| `allowRemoteTargets` | no | `false` | Required for non-loopback hosts. |
| `signal` | no | — | Cancels the run; teardown still runs. |

### Limits

| Limit | Default | Notes |
|---|---|---|
| `requestTimeoutMs` | 5,000 | Per attempt. `target.timeoutMs` overrides. |
| `scenarioTimeoutMs` | 30,000 | Whole run. **A slow target under `burst()` will hit this**, and it surfaces as a `ScenarioTimeout` harness error rather than an assertion failure. |
| `maxResponseBodyBytes` | 65,536 | Captured preview; truncation is reported. |

### Delivery expectations

With no `expect`, a run passes only if every delivery returned 2xx. Scenarios
that intend to provoke a rejection must say so:

```ts
expect: { deliveries: "declared" }
```

Otherwise a run in which the server refused everything would pass, having
asserted nothing.

### Assertions

```ts
{ name: string, check(context): void | Promise<void> }
{ name: string, eventually(context): void | Promise<void>, timeoutMs?: 2000, intervalMs?: 50 }
```

A `check` that throws is `failed`. An `eventually` that never succeeded is
`timed-out` and carries the last failure. The two are different situations and
stay distinct in the report.

## Reporting

- `formatReport(report, options?): string` — the human-readable rendering. Pure;
  returns a string. `{ timings: true }` adds wall-clock; `digestChars` controls
  the digest prefix length.
- `assertRunPassed(report): void` — throws with `formatReport`'s output when the
  run did not pass. Prefer this over `expect(report.passed).toBe(true)`.
- `deliveriesFor(report, eventId): AttemptReport[]`
- `countDeliveries(report, eventId): number`
- `summariseStatuses(report): Record<string, number>` — counts by status, with
  transport failures in their own buckets rather than folded into a code they
  never had.

### Report structure

Four outcome categories, deliberately never blended:

| Field | Means |
|---|---|
| `attempts[].outcome` | What the transport did |
| `assertions[]` | What your check said about your application |
| `harnessError` | The experiment itself was invalid |
| `cleanup` | Whether teardown completed |

`passed` is true only when the delivery expectation held, every assertion
passed, and teardown did not fail.

## Errors

`HarnessError` carries a `code` and an optional `at` pointing at the offending
input. `isHarnessError(value)` is a realm-safe type guard.

| Code | Cause |
|---|---|
| `InvalidScenario` | Bad `createPlan` input — duplicate ids, `#` in an id, non-integer seed, concurrency below 1 |
| `InvalidPlan` | A transform produced something invalid, or a saved plan is malformed or from another planner version |
| `InvalidTarget` | `baseUrl` is not an absolute http(s) URL, or a path could not be resolved |
| `RemoteTargetBlocked` | Non-loopback host without `allowRemoteTargets: true` |
| `MissingFixture` | The plan references an event the supplied fixtures do not define |
| `FixtureDigestMismatch` | The fixtures changed since the plan was saved |
| `SetupFailed` | `hooks.setup` or `hooks.reset` threw |
| `ScenarioTimeout` | The run exceeded `scenarioTimeoutMs` |
| `Cancelled` | The caller's `signal` aborted |

[Troubleshooting](troubleshooting.md) maps these to fixes.

## Versions

- `PLANNER_VERSION` — a saved plan records this; replay refuses a mismatch.
- `REPORT_SCHEMA_VERSION` — branch on this when parsing reports, not on the
  package version.
