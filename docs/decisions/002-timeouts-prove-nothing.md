# Why a timeout does not prove a write failed

When a delivery times out, EventLab reports:

```json
{ "kind": "timeout", "afterMs": 5000 }
```

It does not report a failure, and it will never report that the server did not
process the request. This is a deliberate constraint on the whole toolkit, and
it shapes the report schema.

## What a timeout actually tells you

A client timeout means exactly one thing: **the client stopped waiting.**

It does not tell you which of these happened:

1. The request never reached the server.
2. The request reached the server, which is still working on it.
3. The server processed it completely and committed, and the response is in
   flight.
4. The server processed it completely and committed, and the response was lost.
5. The server processed it, and then crashed before responding.

Cases 3, 4 and 5 all involve a **committed write**. From the client's side they
are indistinguishable from case 1. No amount of client-side observation
separates them, because the information needed to do so is on the other side of
the connection that just failed.

There is a test in the suite that pins this down: it points a 60 ms timeout at
a server that responds after 500 ms, then asserts that the outcome is a timeout
*and* that the server's request log contains the request. The client gave up;
the server did the work.

## Why this matters more than it sounds

The dangerous version of this mistake is not in a report. It is in a retry
policy:

> The call timed out, so it did not happen, so retry it.

That reasoning turns every timeout into a duplicate write. It is one of the
most common ways a system that "has retries" acquires a double-charging bug —
and it is exactly the failure mode EventLab's duplicate scenarios exist to
find. A toolkit that made the same inference in its own report would be
teaching the bug while claiming to test for it.

The correct framing is that a timeout leaves the operation in an **unknown**
state, and unknown is resolved by asking the system, not by assuming:

- make the operation idempotent, so replaying it is safe regardless, or
- give it a client-supplied key and query whether that key was applied.

## How this shows up in the API

- `DeliveryOutcome` has separate `timeout`, `transport-error` and `cancelled`
  variants. None of them are collapsed into "failed", because they carry
  different amounts of information.
- The runner performs **no automatic retries**. If a scenario wants a second
  attempt after a timeout, it must appear in the plan as an attempt, so the
  report can explain why the handler ran twice.
- With the default expectation, a timeout fails the run — as an *unmet
  expectation*, visible as a timeout, not as a claim about the server's state.
- Assertions are the only thing allowed to make claims about application state,
  and they make them by asking your application, which is the one place the
  answer actually exists.

## The short version

A timeout is a statement about the client. Only your application can make a
statement about your application, which is why the assertion callback is yours.
