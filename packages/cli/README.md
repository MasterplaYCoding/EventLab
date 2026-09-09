# EventLab CLI

**Run an EventLab scenario from the command line, and turn its report into a
standalone HTML timeline.**

```bash
npm install --save-dev @masterplaycoding/eventlab-cli
```

This is a companion to
[`@masterplaycoding/eventlab`](https://www.npmjs.com/package/@masterplaycoding/eventlab).
The library has no dependency on it, and nothing in a test needs it — it exists
for the cases where a scenario is not being run from inside a test runner: a CI
job, a reproduction someone sends you, a report you want to look at later.

## Commands

```bash
eventlab run scenario.mjs --json report.json --html report.html
```

Executes the plan a scenario module exports, prints the report, and writes
whichever artifacts you asked for.

```bash
eventlab replay repro.plan.json scenario.mjs
```

Runs a **saved plan** against the module's target. The saved plan wins. Fixtures
are checked against the plan's digest first, so a drifted fixture is reported as
such rather than silently running a different experiment.

```bash
eventlab report report.json --html timeline.html
```

Renders a report you already have.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | The scenario passed. |
| `1` | The scenario **failed** — your application did not hold its invariants. |
| `2` | The scenario **could not run** — bad arguments, a missing export, a blocked target, a failing `setup`. |

`1` and `2` are deliberately distinct. "Your application is wrong" and "your
scenario is not runnable" call for entirely different reactions, and a pipeline
that cannot tell them apart teaches people to ignore both.

## The scenario module

A module, not a configuration file, because building a request is code —
signatures, bearer tokens and per-attempt bodies cannot be expressed in JSON
without inventing a language. It follows that running a scenario runs its
author's code, exactly like running any script; this is not a sandboxed format.

It exports `events`, `plan` and `run`. The full shape, and the HTML timeline's
deliberate omissions, are documented in
[docs/cli.md](https://github.com/MasterplaYCoding/EventLab/blob/main/docs/cli.md).

## Licence

MIT. See [LICENSE](LICENSE).
