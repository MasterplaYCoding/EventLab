# EventLab

**A testing toolkit for finding bugs caused by duplicate, delayed, reordered and concurrent event deliveries.**

If a webhook arrives twice, out of order, or at the same time as its twin, does
your application still end up in the right state? EventLab turns that question
into a test you can run in the runner you already have.

> Everything documented below is implemented and tested on Linux, Windows and
> macOS — including the console block further down, which is compared against
> the library's own output on every CI run. Install it from source today; see
> [Install](#install). Anything not documented below is not built; see
> [Roadmap](#roadmap).

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
import { assertRunPassed, burst, createPlan, duplicate, runPlan, shuffle } from "@masterplaycoding/eventlab";

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
        if (writes !== 2) throw new Error(`expected 2 fulfilment writes, found ${writes}`);
      },
    },
  ],
});

assertRunPassed(report);   // throws with the block below
```

```
✗ each order is fulfilled exactly once
  expected 2 fulfilment writes, found 3

  9 deliveries, all 200 OK
  seed 20260908 · planner 2 · fixtures sha256:603b…
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

Build it once, then depend on it from anywhere:

```bash
git clone https://github.com/MasterplaYCoding/EventLab.git
cd EventLab && npm ci && npm run build
```

```bash
cd /path/to/your-project
npm install --save-dev /path/to/EventLab/packages/core
```

The build step is not optional: the package's `exports` point at `dist/`, so an
unbuilt clone resolves to nothing and gives you `ERR_MODULE_NOT_FOUND` with no
hint as to why.

Requires **Node 22 or 24** — those are what CI covers; the `engines` floor is
`>=22`. **ESM only**: there is no CommonJS build, so `require()` will fail, and
TypeScript consumers need `"moduleResolution": "node16"`, `"nodenext"` or
`"bundler"`. No runtime dependencies. No cloud account, no Docker and no
database is needed to run the default example.

<details>
<summary>Why not <code>npm install @masterplaycoding/eventlab</code>?</summary>

Because it is not on npm yet, and saying otherwise would be the kind of claim
this project spends a lot of words avoiding.

The publishing pipeline is built and tested — see
[RELEASING.md](RELEASING.md) and
[`.github/workflows/release.yml`](.github/workflows/release.yml), which gates a
publish on the same packed-tarball verification CI runs. It is deliberately
held until the `0.2` API settles, since barriers will extend the public
surface and a registry version is permanent.

</details>

## Running the examples

All four examples live in this repository and run from its root:

```bash
git clone https://github.com/MasterplaYCoding/EventLab.git
cd EventLab && npm ci && npm test
```

- [`examples/duplicate-handler`](examples/duplicate-handler) — the README's
  bug, in broken and corrected form.
- [`examples/voting`](examples/voting) — a genuinely concurrent bug, adapted
  from a real project, demonstrated without hoping for a race.
- [`examples/barrier-settlement`](examples/barrier-settlement) — a refund that
  must not be applied before its payment settles, which needs a barrier to
  test at all.
- [`examples/inbox-outbox`](examples/inbox-outbox) — durable inbox/outbox
  processing that survives a worker killed mid-transaction. Uses `node:sqlite`,
  built into Node, so it still needs no Docker and no install.

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
| A saved plan replays the same instructions, and refuses to run against edited fixtures or a different planner version. | It cannot reproduce a race that depended on machine timing. Use a barrier and a checkpoint for that. |
| A barrier releases nothing from a later phase until every attempt in the earlier one has settled, and its checkpoint has run. | Within a phase, ordering is still the network and your application's to decide. A barrier bounds a run into stages; it does not make a stage deterministic. |

## Roadmap

| Milestone | Contents | State |
|---|---|---|
| `0.1` | Planner, transforms, HTTP runner, assertions, JSON reports, saved plans, report formatting, both examples | **implemented** |
| `0.2` | Explicit barriers, a barrier-only example, and durable inbox/outbox crash recovery | **implemented**, release pending |
| `0.3` | CLI (`run`, `replay`, `report`) and a static HTML timeline report | next |
| `1.0` | Stable API and report schema, compatibility policy, complete recipes | planned |

## Documentation

- [Quickstart](docs/quickstart.md) — including how to get your app onto loopback.
- [Concepts](docs/concepts.md)
- [API reference](docs/api.md) — every export, the error codes, the limits.
- [Troubleshooting](docs/troubleshooting.md) — start here when a run confuses you.
- [Writing a transform](docs/extending.md)
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
