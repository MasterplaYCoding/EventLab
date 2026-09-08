# Source provenance

EventLab's engine was written from scratch. Two of its examples are adapted
from an earlier project of mine, and this file records exactly what came from
where, so the lineage is inspectable rather than implied.

## GOATalking

- Repository: private coursework project (GOATalking / GOATalking-backend).
- Adapted file: `src/controllers/pollController.ts`, function `voteOnPoll`.
- Destination: `examples/voting/src/handlers.ts`, function `voteBroken`.
- Licence: MIT. The attribution is retained here and in the example's own
  documentation.

### What was taken

The **multi-write structure** of `voteOnPoll`, unchanged in shape:

1. read the caller's existing vote,
2. decrement the previously chosen option's denormalised counter,
3. increment the newly chosen option's counter,
4. update the vote row,

with no transaction around the sequence.

The **poll / option / vote relationships**, reduced to the fields the failure
needs: poll id and title, option id, text and vote counter, and a vote row of
(user, poll, option).

### What was deliberately not taken

- Authentication and the `AuthRequest` middleware scaffolding.
- Prisma, the database client and every schema concern beyond the three
  relationships above.
- The unrelated endpoints in the same controller (create, list, delete,
  statistics, update, list-by-user).
- Response shaping, pagination and error mapping.
- GOATalking's test command, which mutates a shared database. Every example
  here owns the state it touches and resets it through a scenario hook.
- Any frontend code. EventLab's library has no frontend dependency.

### Status of the adapted code

`voteBroken` is **teaching material**. It is kept structurally faithful to the
original because a sanitised version would no longer demonstrate the failure.
`voteFixed`, in the same file, is the version worth copying.

## Lantr

No Lantr code is used in this repository. The reuse of Lantr's archive layer
happens in DocumentKit, which records its own provenance.

## Third-party dependencies

The published library has no runtime dependencies. Development dependencies
(TypeScript, Vitest, fast-check, TypeDoc) are recorded in the committed
lockfile and are not redistributed.
