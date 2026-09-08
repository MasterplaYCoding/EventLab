# Troubleshooting

## Start here: your test says `expected false to be true`

That is the shape of the problem, not its cause. `runPlan` never throws — every
failure, including EventLab's own, comes back inside the report — so a bare
boolean assertion discards the reason.

Two fixes, in order of preference:

```ts
import { assertRunPassed } from "@masterplaycoding/eventlab";

assertRunPassed(report);   // throws with the whole formatted report
```

```ts
import { formatReport } from "@masterplaycoding/eventlab";

console.log(formatReport(report));
```

If `report.harnessError` is set, the scenario never really ran, and nothing
below about your application applies.

---

## `report.attempts` is empty

Something failed before delivery began. Check `report.harnessError.code`.

### `RemoteTargetBlocked`

Your `baseUrl` is not loopback. This is a deliberate default: EventLab
duplicates and bursts traffic, and pointing that at a shared staging host
because an environment variable was wrong is worth making impossible by
accident.

```ts
allowRemoteTargets: true
```

Loopback means `localhost`, `::1`, or anything in `127.0.0.0/8`.

### `FixtureDigestMismatch`

You edited a fixture body since the plan was saved. Replay refuses rather than
quietly running a different experiment. Either restore the fixtures or rebuild
the plan — but a rebuilt plan is a new reproduction, not the old one.

### `InvalidScenario`

`createPlan` rejected the inputs before touching the network. The `at` field
points at the offender. Most common: duplicate event ids, a `#` in an id
(attempt ids are `<eventId>#<copyIndex>`, so `#` would make them ambiguous), or
a non-integer seed.

### `SetupFailed`

Your `hooks.setup` or `hooks.reset` threw. The original message is included.
`teardown` is skipped, because setup never completed and there is nothing it
owns to tear down.

### `ScenarioTimeout`

The run exceeded `scenarioTimeoutMs` (30 s by default).

Usually this is a slow target combined with `burst()` and a low concurrency —
30 attempts at 2 seconds each with `concurrency: 1` needs a minute. Raise the
budget or the concurrency:

```ts
limits: { scenarioTimeoutMs: 120_000 }
```

If it fires unexpectedly, compare `intendedStartMs` with `observedStartMs` in
the attempts: a large gap means the run was concurrency-bound, not time-bound.

---

## The run failed but every assertion passed

The **delivery expectation** was not met. With no `expect` option, every
delivery must return 2xx. `formatReport` says `— expected all 2xx` when this is
the cause.

If non-2xx responses are the point of your scenario, declare it:

```ts
expect: { deliveries: "declared" }
```

Also check `report.cleanup`: a failing `teardown` sets `passed` to false while
leaving every assertion green.

---

## Attempts show `timeout` or `transport-error`

A **timeout** means the client stopped waiting. It does *not* mean the server
did not process the request — the write may well have committed. See
[why a timeout does not prove a write failed](decisions/002-timeouts-prove-nothing.md).
If your assertions look wrong after a timeout, consider that the handler may
have run.

A **transport-error** carries the underlying message (`ECONNREFUSED` and
friends). The usual causes are an app that has not finished starting, or a
server closed in a previous test's `afterEach`. Start on port `0` and wait for
the `listening` event.

A **3xx** is recorded as a response, not followed. EventLab never follows
redirects, because a redirect is an outcome your application chose.

---

## My duplicate scenario does not reproduce the bug

If the bug depends on two requests *interleaving*, do not raise the copy count
and hope. That produces a test that passes on one machine and fails on another
— which happened to this project's own examples, reliably on Windows and never
on Linux, from an identical plan.

Either find a failure that does not need an interleaving, or have the
application under test signal where its window is and hold it open. Both
approaches are worked through in
[the determinism boundary](decisions/001-determinism-boundary.md), and
[`examples/voting`](../examples/voting) implements the second.

---

## A response body looks cut off

It is. Previews are capped at 64 KiB and `bodyTruncated` says so. Raise
`limits.maxResponseBodyBytes` if you need more.

---

## Secrets appear in my report

Request header *values* and request bodies are never recorded — only header
names. But **response** body previews are captured. If your target echoes a
token back, redact it in your handler; EventLab cannot know which bytes are
sensitive.
