# EventLab

**A testing toolkit for finding bugs caused by duplicate, delayed, reordered and concurrent event deliveries.**

If a webhook arrives twice, out of order, or at the same time as its twin, does
your application still end up in the right state? EventLab turns that question
into a test you can run in the runner you already have.

> **Status: pre-release, working toward `0.1`.** Everything documented below is
> implemented and tested in CI. Anything not documented below is not built yet;
> see [Roadmap](#roadmap).

---

## The bug, in six lines

Here is a payment webhook handler. It is the version you write *after* reading
the provider's documentation about duplicate deliveries.

```ts
async function handlePayment(event: PaymentEvent) {
  if (!(await store.claimEvent(event.eventId))) return;   // already seen this event
  await store.recordFulfillment(event.orderId);
}
```

The deduplication is real, and `claimEvent` is genuinely atomic. Redeliver the
same event a hundred times and it fulfils once.

It is still wrong. Event-id deduplication answers *"have I seen this message
before?"*, and the invariant the business cares about is *"has this order been
fulfilled before?"*. Providers routinely send more than one event for a single
occurrence — Stripe describes both `payment_intent.succeeded` and
`charge.succeeded` for one payment — and two different event ids sail straight
past the check. The customer's order is fulfilled twice.

Every HTTP request returned `200`. Nothing in a log or a status dashboard looks
wrong.

### The failing test

```ts
import { burst, createPlan, duplicate, runPlan, shuffle } from "@masterplaycoding/eventlab";

const plan = createPlan({
  scenario: "payments delivered three times",
  events: paymentEvents,   // two orders; one of them described by two events
  seed: 20260908,
  concurrency: 4,
  transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
});

const report = await runPlan(plan, {
  events: paymentEvents,
  target: {
    baseUrl,
    request: ({ event }) => ({
      method: "POST",
      path: "/webhooks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event.body),
    }),
  },
  hooks: { reset: () => store.reset() },
  assertions: [
    {
      name: "each order is fulfilled exactly once",
      check: () => {
        const writes = store.writeCount();
        if (writes !== 2) throw new Error(`expected 2 fulfilments, found ${writes}`);
      },
    },
  ],
});

expect(report.passed).toBe(false);
```

```
✗ each order is fulfilled exactly once
  expected 2 fulfilment writes, found 3

  9 deliveries, all 200 OK
  seed 20260908 · planner 1 · fixtures sha256:8f2b…
```

### The fix, and the same test passing

```ts
async function handlePayment(event: PaymentEvent) {
  if (!(await store.claimEvent(event.eventId))) return;
  await store.recordFulfillmentOnce(event.orderId);
}
```

One line different, and the difference is *which thing is unique*. Claiming the
event id stays, because dropping redeliveries early is cheap — but it is an
optimisation, not the guarantee. `recordFulfillmentOnce` is a conditional
insert: a unique constraint on `order_id`, or `INSERT … ON CONFLICT DO NOTHING`.
It makes fulfilment idempotent per order, whatever combination of events
describes it.

The identical scenario now passes. Both handlers, both tests and the store live
in [`examples/duplicate-handler`](examples/duplicate-handler); run them with
`npm test`.

Note what this failure does **not** depend on: how those nine deliveries
interleaved. It reproduces identically on every platform and every run. A test
that only catches a bug when the scheduler cooperates is not a regression test —
see [the determinism boundary](docs/decisions/001-determinism-boundary.md), and
[`examples/voting`](examples/voting) for how a genuinely concurrent bug is
demonstrated without hoping.

---

## Install

```bash
npm install --save-dev @masterplaycoding/eventlab
```

Requires Node 22 or 24. ESM only. No runtime dependencies. No cloud account, no
Docker and no database is needed to run the default example.

## Five-minute quickstart

See [docs/quickstart.md](docs/quickstart.md) — define fixtures, point at a
target, choose a scenario, assert an invariant, run it in your existing runner.

## What EventLab is and is not

**It is** a way to generate a repeatable delivery plan, execute it against an
HTTP target, run *your* assertions about *your* application's state, and report
what happened.

**It is not** a webhook gateway, a load generator, a network fault injector, or
anything that inspects your database for you. Tools already exist for the
neighbouring problems: [Hookdeck](https://github.com/hookdeck/hookdeck-cli) for
webhook forwarding during development, [Toxiproxy](https://github.com/Shopify/toxiproxy)
for TCP-level conditions. EventLab's subject is the *state your application
ends up in*.

## Guarantees, each with its limit

| What EventLab guarantees | Where that stops |
|---|---|
| The same seed and inputs produce the same plan: the same attempts, payloads, offsets and ordering constraints. | It does not make execution deterministic. Network latency, database interleavings and your application's scheduling still vary between runs. See [docs/decisions/001-determinism-boundary.md](docs/decisions/001-determinism-boundary.md). |
| Every request your target receives corresponds to an attempt in the plan. There are no automatic retries and redirects are not followed. | It cannot account for retries your own HTTP client or proxy performs. |
| A delivery timeout is reported as a timeout, with the elapsed time. | A timeout is **not** evidence the server did not commit the write. See [docs/decisions/002-timeouts-prove-nothing.md](docs/decisions/002-timeouts-prove-nothing.md). |
| Reports never contain request bodies, and record request header *names* only. | Response body previews are captured (bounded, 64 KiB by default). If your target echoes secrets, redact them in your own handler. |
| Deliveries go to loopback only. | Set `allowRemoteTargets: true` to override — deliberately explicit, because duplicating and bursting traffic at a shared host is not something to do by accident. |
| A saved plan replays the same instructions, and refuses to run against edited fixtures or a different planner version. | It cannot reproduce a race that depended on machine timing. Use explicit checkpoints for that. |

## Roadmap

| Milestone | Contents | State |
|---|---|---|
| `0.1` | Planner, transforms, HTTP runner, assertions, JSON reports, saved plans, duplicate-handler and voting examples | **implemented** |
| `0.2` | Explicit barriers, controlled restart hooks, PostgreSQL inbox/outbox recovery example | planned |
| `0.3` | CLI (`run`, `replay`, `report`), static HTML timeline report | planned |
| `1.0` | Stable API and report schema, compatibility policy, complete recipes | planned |

## Documentation

- [Quickstart](docs/quickstart.md)
- [Concepts](docs/concepts.md)
- [What deterministic replay does and does not mean](docs/decisions/001-determinism-boundary.md)
- [Why a timeout does not prove a write failed](docs/decisions/002-timeouts-prove-nothing.md)
- [How inbox/outbox transactions behave across crashes](docs/decisions/003-inbox-outbox-across-crashes.md)
- [Source provenance](PROVENANCE.md)

## Contributing

Small, real contribution opportunities are listed in
[CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through
[SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE) and [PROVENANCE.md](PROVENANCE.md) for retained
notices on adapted code.
