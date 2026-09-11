# Compatibility

What EventLab promises from one version to the next, and what enforces each
promise. A promise nothing enforces is marked as such — a compatibility policy
is only as good as the build that would fail if it were broken.

EventLab produces three things people keep: **saved plans** attached to bug
reports, **JSON reports** from CI runs, and **test code** written against its
API. Each is versioned separately, because each changes for different reasons.

## Saved plans

| Promise | Enforced by |
|---|---|
| The same seed and inputs produce the same plan in every release with the same `PLANNER_VERSION` — across releases, not only within one. | `goldenPlans.test.ts`, against plans written by the **released** 0.2.0, 0.2.1 and 0.3.0 packages from npm (`tools/golden-plans`). Each release adds its own. |
| A plan saved by any release with the same planner version loads and replays. | The same test parses every golden plan. |
| A change to what a plan contains bumps `PLANNER_VERSION`. | `versionedShapes.test.ts`: the plan types are compared with the shape recorded for the current planner version. |
| A plan from a different planner version is **refused**, never regenerated — a regenerated plan is a different experiment. | `parsePlan`'s version check, and the golden test's expectation that other versions are refused. |

## JSON reports

| Promise | Enforced by |
|---|---|
| `reportSchemaVersion` changes whenever the shape of a report does — including fields added. Branch on it, not on the package version. | `versionedShapes.test.ts`: the report's types, read from the API report, are compared with the shape recorded for the current schema version. |
| `eventlab report` renders the current schema and every older one it can read faithfully — today 2 and 3 — and refuses a newer one, rather than silently dropping what it does not recognise. | `cli.test.ts`. |

Consumers should expect new *values* in open-ended fields — a new
`cleanup.status`, a new transport outcome — only with a schema bump, and should
treat a value they do not recognise as a failure rather than a pass.

## The TypeScript API

The public API is what `packages/core/etc/eventlab.api.md` and
`packages/cli/etc/eventlab-cli.api.md` say it is. `npm run api:check` runs in
CI and before every release and fails when the built declarations differ; an
API change is `npm run api` plus a committed diff that a reviewer reads.

- **Before 1.0 (now):** the API may change in a minor release — `0.3` to
  `0.4` — and only with a changelog entry saying what changed and how to
  migrate. Patch releases do not change it.
- **From 1.0:** semantic versioning. Removing or changing a public signature
  happens only in a major release; additions in minor ones.

`HarnessErrorCode` is a string union and part of that report, so a renamed code
fails the check. New codes may be added in a minor release: a new way for a
scenario to be invalid is not a breaking change.

## The command line

| Promise | Enforced by |
|---|---|
| Exit codes: `0` passed, `1` the application failed the scenario, `2` the scenario could not run. | `cli.test.ts`, and the literal types of `EXIT_OK`, `EXIT_FAILED` and `EXIT_HARNESS` in the API report. |
| The commands and options in `eventlab --help`. | `cli.test.ts` exercises each. |

**Not covered:** the wording of the CLI's output and of `formatReport`. The
README's console block is checked against `formatReport` on every build, so
a change there is deliberate — but it is not a contract, and scripts should
not parse it. Parse the JSON report.

## Behaviour

Every row of the README's *Guarantees, each with its limit* table is part of
the contract. Narrowing a guarantee — promising less — is a breaking change,
versioned like an API removal; widening one is not. Each row names the test
behind it.

## Platforms

Node 22 and 24, ESM only, no runtime dependencies. Tested on Linux, Windows and
macOS. Raising the Node minimum is a minor-version change before 1.0 and a
major one after, always announced in the changelog.

## Not covered

- Anything not exported from the two packages' entry points.
- The examples, recipes and `tools/` — they show how to use EventLab; they are
  not part of it.
- The HTML timeline's markup. What it shows is tested; its structure is not an
  interface.
