# Quickstart

Five minutes, one HTTP test, no changes to your application's architecture.

## 1. Install

```bash
npm install --save-dev @masterplaycoding/eventlab
```

EventLab never imports a test runner. Use it from whichever one you already
have; the examples below use Vitest, but nothing in the library depends on it.

## 2. Define fixtures

Fixtures describe what your provider sends when everything goes *right*: one
real-world occurrence, one event. Duplication belongs in the delivery plan, not
in the fixtures, because that is where it lives in the real system too.

```ts
import type { EventFixture } from "@masterplaycoding/eventlab";

export const paymentEvents: EventFixture[] = [
  { id: "evt_payment_1", body: { eventId: "evt_payment_1", orderId: "ord_1001", amount: 4999 } },
  { id: "evt_payment_2", body: { eventId: "evt_payment_2", orderId: "ord_1002", amount: 12500 } },
];
```

The `id` is the *logical* event id. Every duplicate delivery keeps it and gets
its own attempt id, so a report can say "the handler saw `evt_payment_1` three
times" rather than showing three unrelated requests.

## 3. Plan a scenario

```ts
import { burst, createPlan, duplicate, shuffle } from "@masterplaycoding/eventlab";

const plan = createPlan({
  scenario: "payments delivered three times",
  events: paymentEvents,
  seed: 20260908,
  concurrency: 4,
  transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
});
```

Transforms run in declaration order. Available today:

| Transform | Effect |
|---|---|
| `duplicate({ copies })` | Deliver each event `copies` times in total |
| `shuffle()` | Randomly reorder attempts, using the seed |
| `delay({ minMs, maxMs })` | Give each attempt a start offset drawn from the range |
| `burst()` | Reset every offset to zero, so only concurrency limits the flight |

Every random choice happens here, during planning. Nothing is drawn at
execution time.

## 4. Point at a target and assert an invariant

```ts
import { runPlan } from "@masterplaycoding/eventlab";

const report = await runPlan(plan, {
  events: paymentEvents,
  target: {
    baseUrl,                       // loopback unless allowRemoteTargets is set
    request: ({ event, attempt }) => ({
      method: "POST",
      path: "/webhooks",
      headers: {
        "content-type": "application/json",
        // Built per attempt, so signatures and tokens are always fresh.
        "x-signature": sign(JSON.stringify(event.body)),
      },
      body: JSON.stringify(event.body),
    }),
  },
  hooks: {
    setup: () => startApp(),
    reset: () => truncateTestData(),
    teardown: () => stopApp(),
  },
  assertions: [
    {
      name: "each order is fulfilled exactly once",
      check: async () => {
        const count = await countFulfillments("ord_1001");
        if (count !== 1) throw new Error(`expected 1 fulfilment, found ${count}`);
      },
    },
  ],
});
```

Assertions are ordinary callbacks that throw. EventLab does not inspect your
database — you do, however you normally would, and it records what you found.

For state a background worker produces, use `eventually` instead of `check`:

```ts
{
  name: "the outbox drains",
  timeoutMs: 5000,
  eventually: async () => {
    const pending = await countPendingOutbox();
    if (pending !== 0) throw new Error(`${pending} notifications still pending`);
  },
}
```

A polled assertion that never came true is reported as `timed-out` with the
last failure message, which is a different situation from `failed` and is kept
distinct in the report.

## 5. Run it

```ts
expect(report.passed).toBe(true);
```

`report.passed` is true only when the delivery expectation held, every
assertion passed, and teardown completed.

With no `expect` option, the default requires every delivery to return 2xx. If
your scenario means to provoke a rejection, declare it:

```ts
expect: { deliveries: "declared" }
```

That is deliberate: without it, a run where the server refused everything would
otherwise pass quietly.

## 6. Save the plan next to the bug report

```ts
import { parsePlan, serializePlan } from "@masterplaycoding/eventlab";

await writeFile("repro.plan.json", serializePlan(plan));

// later, possibly on someone else's machine
const saved = parsePlan(await readFile("repro.plan.json", "utf8"));
const report = await runPlan(saved, { events: paymentEvents, target });
```

The saved plan holds instructions only. Payloads stay in your fixture module
and are identified by digest, so `repro.plan.json` is safe to attach to an
issue. If the fixtures were edited since, replay refuses to run rather than
quietly testing something else.

## What to read next

- [Concepts](concepts.md) — the five types and how a run is sequenced.
- [What deterministic replay does and does not mean](decisions/001-determinism-boundary.md)
  — read this before trusting a reproduction.
