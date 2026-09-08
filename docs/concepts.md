# Concepts

EventLab has five public concepts and one execution sequence. That is the whole
model.

| Concept | Meaning |
|---|---|
| `EventFixture` | A stable logical event id and a synthetic body |
| `DeliveryPlan` | Serialisable instructions: which attempts, in what order, at what offsets |
| `HttpTarget` | Base URL, per-attempt request construction, request timeout |
| `ScenarioHooks` | `setup`, `reset`, `teardown` |
| `RunReport` | Plan, attempt outcomes, assertion outcomes, cleanup outcome, provenance |

## Logical events and attempts

A fixture is one *thing that happened*: one payment, one vote, one order
update. An attempt is one *delivery of it*.

Duplicating an event produces several attempts that share the fixture's
`eventId` and each have their own `attemptId`, formatted `<eventId>#<copyIndex>`.
Identity has to survive duplication, because deduplication bugs are precisely
what this toolkit looks for — regenerating an id per attempt would make every
handler look correct.

## Planning happens once, up front

`createPlan()` is the only part of EventLab that consumes randomness. It
validates the whole scenario, expands the transform chain in declaration order,
assigns attempt ids and plan order, and returns a value you can serialise.

A plan records the planner version, the seed, the transform list and a
canonical-JSON SHA-256 digest of the fixtures it was built from. Replay
executes the stored attempts; it never re-runs the planner. A newer EventLab
release therefore cannot quietly change what a saved reproduction does.

Validation is complete before anything touches the network, so a mistake in a
scenario surfaces as a `HarnessError` pointing at the offending input, rather
than as a confusing pile of transport failures halfway through a run.

## The run sequence

```
setup → reset → scheduled deliveries → assertions → teardown
```

`teardown` runs on every path: success, assertion failure, harness error,
scenario timeout and cancellation. Its own failure is reported as a *cleanup*
failure and does not overwrite whatever went wrong first.

## Scheduling rules

1. Attempts are released in `(delayMs, order)` order. Plan order is the
   tie-break, so two attempts planned for the same instant always contend in
   the same sequence across runs.
2. An attempt waits for a free concurrency slot *before* it waits for its clock
   offset. A saturated run slips rather than bursting to catch up, and the slip
   is visible in the report as the gap between `intendedStartMs` and
   `observedStartMs`.
3. Elapsed time is monotonic. A system clock adjustment mid-run cannot make an
   attempt appear to start before the run did.
4. Cancellation stops releasing new attempts and aborts what is in flight.
   Teardown still runs.

## Four kinds of outcome, kept apart

A report never blends these, because they lead to different actions:

| Kind | Field | Means |
|---|---|---|
| Delivery outcome | `attempts[].outcome` | What the transport did: a response, a timeout, a connection error, a cancellation |
| Assertion outcome | `assertions[]` | What *your* check said about *your* application's state |
| Harness error | `harnessError` | The experiment itself was invalid: bad scenario, blocked target, failed setup |
| Cleanup outcome | `cleanup` | Whether teardown completed |

A failing assertion is a statement about your application. A `HarnessError` is
a statement about EventLab's inputs. Conflating them would make "my scenario
was misconfigured" and "my code is wrong" look identical in CI.

## What passes

`report.passed` is true only when:

- the declared delivery expectation held,
- every assertion passed, and
- teardown did not fail.

With no declared expectation, the default requires all deliveries to be 2xx.
Scenarios that intend to provoke rejections must declare
`expect: { deliveries: "declared" }`. Without that rule, a run in which the
server refused every single request would pass, having asserted nothing.

## Redaction

Reports store request header *names* only and never request bodies. Requests
are constructed at execution time precisely so that signatures and bearer
tokens are computed fresh per attempt — and so they never need to be stored.
A report is something you attach to an issue.

Response body previews *are* captured, bounded at 64 KiB by default and marked
`bodyTruncated` when cut. If your target echoes secrets back, redact them in
your handler.
