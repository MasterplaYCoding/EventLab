# EventLab

**Find bugs caused by duplicate, delayed, reordered and concurrent event deliveries.**

If a webhook arrives twice, out of order, or at the same time as its twin, does
your application still end up in the right state? EventLab turns that question
into a test you run in the runner you already have.

```bash
npm install --save-dev @masterplaycoding/eventlab
```

## The bug it finds

```ts
async function handlePayment(event: PaymentEvent) {
  if (!(await store.claimEvent(event.eventId))) return;   // already seen this event
  await store.recordFulfillment(event.orderId);
}
```

The deduplication is real and the claim is atomic — redeliver the same event a
hundred times and it fulfils once. It is still wrong, because event-id
deduplication answers *"have I seen this message?"* when the invariant is
*"has this order been fulfilled?"*. Providers routinely send more than one
event for one occurrence, and two different event ids sail past the check.

Every request returns `200`. Nothing in a log looks wrong.

## The test

```ts
import { assertRunPassed, burst, createPlan, duplicate, runPlan, shuffle } from "@masterplaycoding/eventlab";

const plan = createPlan({
  events: paymentEvents,
  seed: 20260908,
  concurrency: 4,
  transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
});

const report = await runPlan(plan, {
  events: paymentEvents,
  target: { baseUrl, request: ({ event }) => ({
    method: "POST",
    path: "/webhooks",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event.body),
  }) },
  hooks: { reset: () => store.reset() },
  assertions: [{
    name: "each order is fulfilled exactly once",
    check: () => {
      const writes = store.writeCount();
      if (writes !== 2) throw new Error(`expected 2 fulfilment writes, found ${writes}`);
    },
  }],
});

assertRunPassed(report);
```

```
✗ each order is fulfilled exactly once
  expected 2 fulfilment writes, found 3

  9 deliveries, all 200 OK
  seed 20260908 · planner 2 · fixtures sha256:603b…
```

## What it does and does not do

Generates a repeatable delivery plan, executes it over HTTP, runs *your*
assertions about *your* application's state, and reports what happened.

It is not a webhook gateway, a load generator or a network fault injector, and
it never inspects your database for you.

Deliveries go to loopback unless you opt in. There are no automatic retries and
redirects are not followed, so every request your target sees corresponds to an
attempt in the plan. Reports record request header *names* only and never
request bodies.

## Requirements

Node 22 or 24. ESM only — there is no CommonJS build. No runtime dependencies.

---

Full documentation, examples and the engineering write-ups:
**[github.com/MasterplaYCoding/EventLab](https://github.com/MasterplaYCoding/EventLab)**

MIT licensed.
