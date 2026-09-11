# Recipes: pointing EventLab at your framework

EventLab delivers HTTP to a URL, so it does not care what serves that URL.
What differs between frameworks is everything around the delivery: getting
the app onto an ephemeral loopback port, reading the body a webhook signature
was computed over, and shutting down cleanly. These recipes do those three
things for Express, Fastify, NestJS and Next.js.

Each one is a **runnable test**, not a snippet. The same EventLab scenario runs
unchanged against all four — nine deliveries, three of each event, shuffled
and released at once — and each recipe has to:

- fulfil every order exactly once,
- accept a signature computed over a **pretty-printed** body, which only works
  if the route checks the raw bytes,
- refuse the same deliveries signed with the wrong key,
- listen on `127.0.0.1`, finish `teardown` inside its budget, and actually
  release the port.

Every one of those was confirmed to fail when the recipe gets it wrong.

| Framework | Recipe | Raw body from |
|---|---|---|
| Express 5 | [`src/express.ts`](../examples/frameworks/src/express.ts) | `express.raw()` on the webhook route, registered before any app-wide `express.json()` |
| Fastify 5 | [`src/fastify.ts`](../examples/frameworks/src/fastify.ts) | an `application/json` parser with `parseAs: "buffer"`, inside a plugin so it stays scoped |
| NestJS 12 | [`src/nest.ts`](../examples/frameworks/src/nest.ts) | `NestFactory.create(module, { rawBody: true })`, then `request.rawBody` |
| Next.js 16 | [`nextjs/app/webhooks/route.ts`](../examples/frameworks/nextjs/app/webhooks/route.ts) | `await request.arrayBuffer()` — before anything calls `request.json()` |

The business logic they all call — verify, parse, deduplicate — is
[`src/webhook.ts`](../examples/frameworks/src/webhook.ts), with no framework
in it. The scenario is [`test/scenario.ts`](../examples/frameworks/test/scenario.ts).

## The shape every recipe shares

```ts
const app = await startYourApp(ledger);          // listening on 127.0.0.1:0

const report = await runPlan(plan, {
  events,
  target: { baseUrl: app.baseUrl, request },
  hooks: { teardown: () => app.close() },
  assertions,
});
```

Two choices in there are deliberate.

**The app starts before `runPlan`, not in `hooks.setup`.** EventLab resolves
`baseUrl` before it runs `setup`, so that a bad target fails before anything is
started. An ephemeral port does not exist until the app is listening, so an app
started in `setup` has no address to give. Start it first.

**It stops in `teardown`, not in `afterEach`.** That puts the shutdown in the
report. A framework that hangs on close then shows up as
`cleanup.status: "timed-out"` — and fails the run — instead of as a test runner
that never finishes. Each recipe asserts `cleanup.status` is `ok` and that the
port refuses connections afterwards.

## Listening on loopback

Pass the host explicitly. Express and Node's `http.Server` default to every
interface; a test has no reason to be reachable from the network. Fastify
defaults to `localhost`, which works but makes the right address a question
about the machine's resolver.

| Framework | Listen | Address |
|---|---|---|
| Express | `app.listen(0, "127.0.0.1")`, then wait for `listening` | `server.address().port` |
| Fastify | `await app.listen({ port: 0, host: "127.0.0.1" })` | the value `listen` returns |
| NestJS | `await app.listen(0, "127.0.0.1")` | `await app.getUrl()` |
| Next.js | a `node:http` server around `next().getRequestHandler()` | `server.address().port` |

Next's own `next start` takes a fixed port and owns its server, which is the
wrong shape for a test. The recipe uses Next's custom-server API instead, in
production mode, so it exercises what `next build` produced.

## The mistakes, made on purpose

[`test/pitfalls.test.ts`](../examples/frameworks/test/pitfalls.test.ts) builds
the two broken versions the Express recipe warns about and shows how EventLab
reports them: every delivery refused with 401, and the run failing on its
delivery expectation before any business assertion can be confusing about why
nothing was fulfilled.

- **Checking the signature against a re-serialised body.** `JSON.stringify` of
  the parsed body is not the bytes the provider signed, as soon as the provider
  pretty-prints, orders keys differently or escapes differently. It works for
  some providers and fails for others, which is worse than failing for all.
- **An app-wide `express.json()` registered first.** It consumes the body, and
  the route's `express.raw()` then has nothing left to read.

[`test/scoping.test.ts`](../examples/frameworks/test/scoping.test.ts) checks the
other half: that the raw-body handling stays on the webhook route, and the rest
of an Express or Fastify app still receives parsed JSON.

## NestJS: inject by token

Nest's type-based injection reads `emitDecoratorMetadata` output, which esbuild
— and so Vitest, `tsx` and most modern tooling — does not produce. Under those,
a controller that asks for a dependency by type gets `undefined`. The recipe
injects with an explicit token, `@Inject(LEDGER)`, which works under every
compiler. Keep `experimentalDecorators` on; Nest's decorators are the legacy
kind.

## Next.js: state the route can reach

Next constructs route modules itself, and a route file may only export route
handlers, so there is no constructor to hand the ledger to. A real application
keeps that state in a database both the route and the test can reach. The
recipe keeps it in memory, so a process-wide slot
([`nextjs/app/ledger.ts`](../examples/frameworks/nextjs/app/ledger.ts)) stands
in for the database. That works because Next runs route handlers in the same
process as the custom server.

The Next recipe is kept apart from the rest: Next is a ~300 MB install plus a
build step, so it has its own package and lockfile, and its own CI job. Run it
with:

```bash
npm ci --prefix examples/frameworks/nextjs && npm run test:nextjs
```

The other three run as part of `npm test`.

## Limits

- **In-memory state.** The ledger checks and records in one synchronous step,
  which is race-free within one Node process and nowhere else. The recipes are
  about wiring; [`examples/duplicate-handler`](../examples/duplicate-handler)
  and [`examples/inbox-outbox`](../examples/inbox-outbox) are about what
  happens when that state lives in a database.
- **One version of each framework**, the current major at the time of writing.
  The shapes above have been stable across recent majors, but only these
  versions are tested.
- **Next.js runs on one platform in CI** (Ubuntu). The other three run on
  Linux, Windows and macOS with the rest of the suite.
