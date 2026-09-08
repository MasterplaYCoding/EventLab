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

This project learned that the hard way, on its own examples. The first version
of the duplicate-handler example used a check-then-act handler and asserted
that duplicate deliveries would interleave into the gap between its read and
its write. On Windows that happened reliably. On Linux and macOS it never
happened at all: the same plan, the same seed, the same nine deliveries, and
the handler produced exactly the right answer because the event loop read each
request's body, ran its handler to completion, and only then looked at the next
socket. CI went red on three of six configurations, and the "failing" ones were
the ones where nothing was wrong.

Two fixes came out of that, and they are the two options available in general.

**Prefer a failure that does not need an interleaving at all.** The
duplicate-handler example now fails because two different event ids describe
one order, so event-id deduplication lets both through. That is a real,
common, and entirely sequential bug. It reproduces on every platform, every
run, and it makes a better demonstration precisely because nothing about it is
subtle.

**When the bug genuinely is a race, make the overlap explicit.** The voting
example's bug is a non-transactional read-then-write, and there is no
sequential ordering that exposes it. So the application under test declares
where its window is, and the test holds that window open until both deliveries
have entered it. The gate is in the *example*, not the library — EventLab has
no way to reach inside an application and hold a lock open, and should not
acquire one. Both the broken and the corrected handler face the identical gate,
so the difference in outcome is attributable to the handler and nothing else.

Sleep-based coordination is rejected in both cases. `await sleep(50)` between
deliveries encodes an assumption about your CI machine's speed and nothing
about your system's semantics.

## Barriers: the general form of the second option

The voting example's gate is bespoke to that example. **Barriers** are the same
idea in the library, and they answer a question the gate cannot: *what is true
once the system has gone quiet?*

```ts
phases: [
  { deliver: ["evt_payment"], transforms: [duplicate({ copies: 2 })] },
  { barrier: "settlement drained", checkpoint: "settlementDrained" },
  { deliver: ["evt_refund"] },
]
```

Everything in the first phase completes, then the checkpoint runs, then the
second phase is released. The checkpoint is *the application's* — a queue-depth
poll, a `waitForIdle`, a test-only hook. The scenario waits for a signal the
system emits, never for a duration a human guessed.

That distinction is the whole point. `await sleep(200)` and "wait until the
worker's queue is empty" look similar in a test file and are not remotely the
same claim: the first is true on your laptop and false on a loaded CI runner,
while the second is true wherever it runs.

What barriers make possible that nothing else does is **testing the two sides
of a boundary separately**. `examples/barrier-settlement` has a refund that
must not be applied before its payment settles, and it needs both:

- *without* a barrier, both events land together and the correct handler must
  refuse the refund with a `409`;
- *with* one, the refund arrives after settlement and must succeed.

No arrangement of delays expresses the second. You cannot ask "what happens
after the worker finishes?" by waiting longer, because waiting longer is a
guess and a guess is not a test.

Barriers do not make execution deterministic. Within a phase, everything in
this document still applies.

## What the report tells you about this

Each attempt carries `intendedStartMs` and `observedStartMs` separately. The
gap between them is the honest measure of how far a run drifted from its plan
under load. If they diverge sharply, the scenario was concurrency-bound rather
than time-bound, and reasoning about the plan's offsets is misleading.

## The short version

- The plan is deterministic.
- The run is not.
- The report records both, and never pretends the second is the first.
