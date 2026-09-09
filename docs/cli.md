# The command line

`@masterplaycoding/eventlab-cli` runs scenarios, replays saved plans, and turns
a report into an HTML timeline. It is a separate package: the library has no
dependency on it, and nothing in a test needs it.

```bash
npm install --save-dev @masterplaycoding/eventlab-cli
```

> **Not on npm yet.** `@masterplaycoding/eventlab-cli` is prepared but not
> published, so the command above fails today. Build from source instead — see
> [Install](../README.md#install). It is written in the form it takes once the
> package is released, and this note is deleted on the same day.

From a source build, the CLI is at `packages/cli/dist/bin.js` once
`npm run build` has run.

## A scenario module

The CLI executes a JavaScript module that exports three things:

```js
// scenario.mjs
import { burst, createPlan, duplicate, shuffle } from "@masterplaycoding/eventlab";

export const events = [
  { id: "evt_payment_1", body: { eventId: "evt_payment_1", orderId: "ord_1001" } },
  { id: "evt_charge_1",  body: { eventId: "evt_charge_1",  orderId: "ord_1001" } },
];

export const plan = createPlan({
  scenario: "payments delivered three times",
  events,
  seed: 20260908,
  transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
});

export const run = {
  target: {
    baseUrl: "http://127.0.0.1:3000",
    request: ({ event }) => ({
      method: "POST",
      path: "/webhooks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event.body),
    }),
  },
  assertions: [
    {
      name: "each order is fulfilled exactly once",
      check: async () => { /* ask your application */ },
    },
  ],
};
```

A **module**, not a configuration file, because building a request is code:
signatures, bearer tokens and per-attempt bodies cannot be expressed in JSON
without inventing a language. The consequence is worth stating plainly —
running a scenario runs its author's code, exactly like running any script. It
is not a sandboxed data format, and
[SECURITY.md](../SECURITY.md) says so too.

Two practical notes:

- The module resolves its own imports, so it must sit in a project where
  `@masterplaycoding/eventlab` is installed. A scenario in `/tmp` will fail with
  `Cannot find package`.
- It can start your application itself, as the module above could, or point at
  something already running. `hooks.teardown` is the place to shut it down.

## Commands

```bash
eventlab run scenario.mjs
```

Executes the plan the module exports and prints the report.

```bash
eventlab run scenario.mjs --json report.json --html report.html
```

Writes the machine-readable report, the timeline, or both.

```bash
eventlab replay repro.plan.json scenario.mjs
```

Runs a **saved plan** against the module's target and fixtures. The saved plan
wins; the module's own `plan` export is ignored. Fixtures are checked against
the plan's digest first, so a drifted fixture is reported as such rather than
silently running a different experiment.

```bash
eventlab report report.json --html timeline.html
```

Renders a report you already have. Useful for a CI job that saved JSON and a
human who wants to look at it later.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The scenario passed. |
| `1` | The scenario **failed** — your application did not hold its invariants. |
| `2` | The scenario **could not run** — bad arguments, a missing export, a blocked target, a failing `setup`. |

`1` and `2` are deliberately distinct. "Your application is wrong" and "your
scenario is not runnable" call for entirely different reactions, and a pipeline
that cannot tell them apart teaches people to ignore both.

## The HTML timeline

One standalone file. No server, no network requests, no analytics — you can
email it or attach it to an issue.

It groups attempts by logical event, so three deliveries of one event read as
one row rather than three unrelated bars, and it shows intended and observed
start times separately because the plan is deterministic and the run is not.

**Response bodies are omitted**, even though the report holds them. A timeline
is skimmed rather than read, and a token echoed by a target should not be
sitting in a file people forward. Everything rendered is escaped: attempt ids,
URLs and assertion messages all come from outside the process.

Status is shown by text as well as colour, so the document works without seeing
the colours.
