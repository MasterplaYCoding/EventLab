# How inbox/outbox transactions behave across crashes

This is the reasoning behind [`examples/inbox-outbox`](../../examples/inbox-outbox),
which is implemented and runs in CI on every supported platform.

> **On the database.** The example uses `node:sqlite`, built into Node 22+, so
> it needs no install and no Docker — and the library itself still has no
> database dependency of any kind.
>
> A database appears here for exactly one reason: this example demonstrates
> **crash recovery**, and "the worker died mid-transaction, what state is the
> system in?" requires storage that outlives the process. An in-memory store
> dies *with* the process, so it cannot demonstrate recovery at all. Every
> other example in this repository is in-memory precisely because they do not
> need that.
>
> What SQLite cannot demonstrate is `SELECT … FOR UPDATE SKIP LOCKED` — several
> workers competing for inbox rows. That is a scaling mechanism, not one of the
> six failures below, and with a single worker a transaction is sufficient.
> Where the text mentions it, treat it as describing what a Postgres deployment
> would do rather than what the example runs.

## The problem

A webhook handler that does real work in the request has two jobs it cannot
combine safely:

1. Acknowledge the delivery quickly, so the provider does not retry.
2. Apply a business change durably, and notify something downstream.

If it acknowledges first, a crash loses the work. If it does the work first,
a slow database turns into provider retries — which is to say, duplicates. And
"apply the change, then send the notification" is two writes to two systems,
which no transaction spans.

## The shape that works

Split the request path from the work path with a durable queue in the database
you are already writing to.

**On delivery:**

1. Validate the event.
2. `INSERT` it into an inbox table, keyed by the provider's event id, with
   `ON CONFLICT DO NOTHING`. A duplicate delivery is now a no-op, decided by a
   unique constraint rather than by application logic that can race.
3. Acknowledge.

**In a worker, separately:**

4. Lock one pending inbox row (`SELECT … FOR UPDATE SKIP LOCKED`).
5. In **one transaction**: apply the business change, insert the outbox row,
   and mark the inbox row processed.
6. Commit.
7. Dispatch outbox notifications afterwards, marking them sent.

Step 5 is the whole trick. The business change, the record that a notification
is owed, and the record that this event is handled either all become visible or
none of them do.

## What each failure does

| Failure | Result |
|---|---|
| Duplicate delivery before processing | Second insert hits the unique constraint, does nothing. One inbox row. |
| Duplicate delivery after processing | Same. The inbox row is the memory that the event was seen. |
| Worker dies before commit | Transaction rolls back. The row is unlocked and still pending; another worker picks it up. |
| Worker dies after commit, before reporting done | The work is committed, including "processed". Nothing is redone. |
| Worker dies after commit, before dispatching | The outbox row survives. Dispatch is retried later. |
| Dispatch succeeds but the acknowledgement is lost | The notification is sent again. This is why the receiver must be idempotent. |

That last row is the honest limit. The outbox gives **at-least-once** delivery
to the downstream system. It cannot give exactly-once, because the boundary
between "the remote system committed" and "we learned that it committed" is
exactly the unknowable gap described in
[002](002-timeouts-prove-nothing.md).

## Ordering

Events carry an explicit `resourceVersion` in this example, and applying an
older version over a newer one is a no-op.

This is stated as a property of the *example's synthetic events*, not as
something inherited from a real provider. Provider timestamps are not an
ordering contract: they are wall-clock readings from a distributed system, and
Stripe in particular documents that ordering is not guaranteed. An example that
implied otherwise would be teaching a bug.

## How the scenario is tested

Crash points are **named boundaries**, not sleeps. The worker takes a
`crashAt` of `before-commit`, `after-commit` or `before-dispatch`, reaches
exactly that point and throws. The test then drops its database handle and
opens the file again, which is the part that matters: the state has to survive
something, and a file is the smallest thing that survives.

The alternative — sleeping and hoping to interrupt the right instruction — is
rejected outright. It produces a test that passes for the wrong reason on a
fast machine and fails intermittently on a slow one, and it cannot even be said
to test the boundary it claims to. This project has already made that mistake
twice, in two different examples, and both times CI on another platform is what
caught it.

Ordering between phases uses [barriers](../api.md#barriers-and-phases), so
"deliver v1, wait until it is fully applied, then deliver v2" is a property of
the scenario rather than a race. The broken handler's failure is a version
regression, and a test that only caught it when the transport happened to
cooperate would be worthless.

Process management, if a scenario needs a real child process rather than a
named boundary, belongs to the example's own utilities. EventLab's core invokes
hooks and nothing else; it never manages processes on a user's behalf.

## What this does not claim

- Not exactly-once delivery to external services.
- Not power-loss durability. A killed process is not a lost machine, and the
  tests will say "process termination", not "crash simulation".
- Not an ordering guarantee beyond the version field the example's own events
  carry.
