# Writing a transform

Transforms are the planner's extension point. A transform takes the current
list of attempt drafts plus the seeded RNG and returns a new list — it may add,
remove, reorder or retime attempts.

```ts
import type { AttemptDraft, Transform } from "@masterplaycoding/eventlab";

export function dropRandom(options: { probability: number }): Transform {
  const { probability } = options;
  if (!(probability >= 0 && probability <= 1)) {
    throw new Error(`probability must be between 0 and 1, received ${probability}`);
  }

  return {
    // Recorded in the plan, so a saved reproduction explains how it was built.
    record: { kind: "dropRandom", options: { probability } },
    apply: (attempts, rng) => attempts.filter(() => rng.next() >= probability),
  };
}
```

## The rules

**Draw randomness only from `rng`.** Never `Math.random`, never the clock, never
an environment variable. The planner's whole contract is that the same seed and
inputs expand to the same plan; a transform that reaches outside the RNG breaks
it for everyone, including saved reproductions from months ago.

**Consume randomness in a fixed order.** Drawing a different number of values
depending on, say, array length is fine — that is a function of the input — but
drawing conditionally on something outside the input is not.

**Do not mutate the input array.** Return a new one. Transforms compose, and a
mutating step makes the chain order-dependent in ways the declaration does not
show.

**Validate options when the transform is constructed**, not when it is applied.
A bad option should fail at `dropRandom({ probability: 2 })`, before
`createPlan` is even called, so the stack trace points at the mistake.

**Fill in the `record`.** It is what makes a plan self-describing. `options`
takes primitives only, because a plan has to survive `JSON.stringify`.

**Do not assign ids.** `attemptId`, `copyIndex` and `order` are assigned by the
planner after the whole chain has run, so a transform only produces drafts:

```ts
interface AttemptDraft {
  readonly eventId: string;
  readonly copyIndex: number;
  readonly delayMs: number;   // non-negative integer
}
```

An attempt whose `eventId` is not one of the scenario's fixtures, or whose
`delayMs` is negative or fractional, is rejected as an `InvalidPlan` harness
error naming your transform.

## Testing one

Property tests are worth more than examples here, because the properties are
what the planner promises. The built-in transforms are covered by four in
`packages/core/test/createPlan.test.ts`, and the same shapes apply:

- the same inputs and seed produce the same plan
- attempt ids stay unique however transforms are stacked
- your invariant holds — a shuffle preserves the multiset, a delay stays in
  bounds, a drop only ever removes

```ts
fc.assert(
  fc.property(arbEvents, fc.integer(), (events, seed) => {
    const plan = createPlan({ events, seed, transforms: [dropRandom({ probability: 0.5 })] });
    expect(plan.attempts.length).toBeLessThanOrEqual(events.length);
  }),
  propertyConfig,
);
```

## Contributing one back

`dropRandom` and `outOfOrderPairs` are both listed in
[CONTRIBUTING.md](../CONTRIBUTING.md) as genuinely wanted. A transform, a
property test and a row in the quickstart table is the whole change.
