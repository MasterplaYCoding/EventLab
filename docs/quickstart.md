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
  // A *second* event for the same payment as evt_payment_1, with its own event
  // id. Not a duplicate delivery — a correct provider sending two
  // notifications about one occurrence, exactly as Stripe does with
  // payment_intent.succeeded and charge.succeeded.
  { id: "evt_charge_1", body: { eventId: "evt_charge_1", orderId: "ord_1001", amount: 4999 } },
];
```

The `id` is the *logical* event id. Every duplicate delivery keeps it and gets
its own attempt id, so a report can say "the handler saw `evt_payment_1` three
times" rather than showing three unrelated requests.

Note `evt_charge_1` carries a different `id` but the same `orderId`. That is
what makes the README's headline bug reproducible: a handler that deduplicates
on event id lets both through. Drop that fixture and the scenario plans six
deliveries instead of nine and finds nothing.

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

Two things in this snippet are yours, not EventLab's: `baseUrl` is wherever
your application is listening, and `sign` is your provider's signature scheme.
Everything named in `hooks` and `assertions` is your code too — EventLab calls
it and records what it says.

```ts
import { runPlan } from "@masterplaycoding/eventlab";

// e.g. `http://127.0.0.1:${server.address().port}` after starting your app on
// an ephemeral port. See "Getting your app onto loopback" below.
declare const baseUrl: string;
declare function sign(body: string): string;

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
import { assertRunPassed } from "@masterplaycoding/eventlab";

assertRunPassed(report);
```

`assertRunPassed` throws with the whole formatted report as its message, so a
failure tells you which assertion broke and what the deliveries did.

You can assert on `report.passed` directly instead — but if you do, check
`report.harnessError` when a result confuses you. `runPlan` never throws: an
invalid scenario, a blocked non-loopback target or a failing `setup` all come
back as a report with an empty `attempts` array, and a bare
`expect(report.passed).toBe(true)` will only tell you `false`.

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
import { readFile, writeFile } from "node:fs/promises";
import { parsePlan, runPlan, serializePlan } from "@masterplaycoding/eventlab";

await writeFile("repro.plan.json", serializePlan(plan));

// later, possibly on someone else's machine
const saved = parsePlan(await readFile("repro.plan.json", "utf8"));
const replayed = await runPlan(saved, { events: paymentEvents, target });
```

The saved plan holds instructions only. Payloads stay in your fixture module
and are identified by digest, so `repro.plan.json` is safe to attach to an
issue. If the fixtures were edited since, replay refuses to run rather than
quietly testing something else.

## Getting your app onto loopback

EventLab delivers over HTTP to a URL, so the only requirement is that your
application is listening on one. It does not need to know what framework you
use, and you do not need to change your application to test it.

The shape is the same everywhere: start on an **ephemeral port** (port `0`, and
ask the server what it got), hand that URL to the target, and shut down in
`teardown`.

```ts
import { afterEach, beforeEach, expect, it } from "vitest";
import type { AddressInfo } from "node:net";

let server: import("node:http").Server;
let baseUrl: string;

beforeEach(async () => {
  // Express: app.listen(0). Fastify: await app.listen({ port: 0 }).
  // Nest: await app.listen(0). Anything with a listen() works.
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});
```

Port `0` matters more than it looks: a fixed port makes tests fail when they
run in parallel, or when something else on the machine happens to hold it.

If your application is already running elsewhere — a `docker compose` service,
a dev server — just point `baseUrl` at it and use `hooks.reset` to clear state
between scenarios. Remember that non-loopback hosts require
`allowRemoteTargets: true`.

## What to read next

- [Concepts](concepts.md) — the five types and how a run is sequenced.
- [API reference](api.md) — every export, including the error codes and limits.
- [Troubleshooting](troubleshooting.md) — start here when a run confuses you.
- [What deterministic replay does and does not mean](decisions/001-determinism-boundary.md)
  — read this before trusting a reproduction.
