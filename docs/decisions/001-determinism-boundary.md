# What deterministic replay does and does not mean

EventLab says its plans are reproducible. That claim is narrow on purpose, and
it is worth being precise about where it ends, because a reproduction you trust
too far is worse than one you distrust.

## What is reproducible

Given the same fixtures, seed, transform chain and concurrency,
`createPlan()` always produces the identical plan: the same attempts, the same
`attemptId` values, the same plan order and the same intended offsets. This is
a pure function, and there is a fast-check property in the test suite asserting
exactly that.

Replaying a saved plan therefore issues the same **requested operations**:

- the same logical events, duplicated the same number of times,
- the same payload bytes,
- the same intended start offsets,
- the same concurrency ceiling,
- the same release order for attempts that tie.

## What is not reproducible

Everything downstream of "we called `fetch`":

- **Network timing.** Two runs will not see identical latencies, even on
  loopback.
- **Actual concurrency.** The plan bounds how many attempts are in flight. It
  does not control which of them the operating system, the runtime and the
  server actually interleave, or in what order they reach a database.
- **Database interleavings.** Whether two transactions serialise one way or the
  other is the database's decision, made under load conditions that vary.
- **Your application's scheduling.** Thread pools, connection pools, event-loop
  ordering and garbage collection are all outside the plan.

So a plan reproduces the *experiment*, not the *result*. A race that
materialised on Tuesday may not materialise on Wednesday from the same plan.
That is a property of the system under test, not a defect in the plan.

## Why the boundary is drawn there

The alternative would be to control the target's execution — patching its
clock, serialising its database, or instrumenting its scheduler. Every version
of that requires EventLab to reach inside the application under test, which
would mean it is no longer testing the application you actually ship.

Keeping the boundary at the socket costs reproducibility of outcomes and buys
the ability to point it at anything that speaks HTTP, in any language, without
modification.

## What to do when you need a specific interleaving

Do not raise the copy count and hope. A scenario that fails one run in fifty is
a bad regression test: it is slow, it is flaky, and when it goes green nobody
knows whether it was fixed.

Instead, make the boundary explicit. The application under test signals when it
has reached a named point, and the scenario waits for that signal rather than
for a duration. This is what the `0.2` barrier and checkpoint work is for.

Sleep-based coordination is specifically rejected. `await sleep(50)` between
deliveries encodes an assumption about your CI machine's speed and nothing
about your system's semantics.

## What the report tells you about this

Each attempt carries `intendedStartMs` and `observedStartMs` separately. The
gap between them is the honest measure of how far a run drifted from its plan
under load. If they diverge sharply, the scenario was concurrency-bound rather
than time-bound, and reasoning about the plan's offsets is misleading.

## The short version

- The plan is deterministic.
- The run is not.
- The report records both, and never pretends the second is the first.
