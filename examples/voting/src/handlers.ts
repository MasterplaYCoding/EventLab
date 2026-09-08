import { Mutex, tick, type PollStore } from "./pollStore.js";

export interface VoteCommand {
  readonly pollId: string;
  readonly optionId: string;
  readonly userId: string;
}

export class VoteRejected extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "VoteRejected";
    this.status = status;
  }
}

/**
 * The vulnerable handler.
 *
 * Adapted from GOATalking's `voteOnPoll` controller (see PROVENANCE.md). The
 * authentication scaffolding, response shaping and unrelated endpoints are
 * gone; the multi-write structure is kept exactly as it was, because that
 * structure is the bug:
 *
 * 1. read the existing vote,
 * 2. decrement the old option's counter,
 * 3. increment the new option's counter,
 * 4. update the vote row.
 *
 * Four separate writes with no transaction around them, and a denormalised
 * counter that is only correct if every one of them lands exactly once, in
 * order. Under at-least-once delivery none of that is guaranteed, so the
 * counters drift away from the vote rows they are supposed to summarise.
 *
 * This is teaching material, not a recommended implementation.
 */
export async function voteBroken(store: PollStore, command: VoteCommand): Promise<void> {
  const { pollId, optionId, userId } = command;

  const existing = store.findVote(userId, pollId);
  await tick();

  if (existing !== undefined) {
    if (existing.optionId === optionId) {
      return;
    }

    const previous = store.poll(pollId)?.options.find((o) => o.id === existing.optionId);
    if (previous !== undefined) {
      previous.votes -= 1;
    }
    await tick();

    const next = store.poll(pollId)?.options.find((o) => o.id === optionId);
    if (next !== undefined) {
      next.votes += 1;
    }
    await tick();

    existing.optionId = optionId;
    return;
  }

  const option = store.poll(pollId)?.options.find((o) => o.id === optionId);
  if (option !== undefined) {
    option.votes += 1;
  }
  await tick();

  store.insertVote({ userId, pollId, optionId });
}

/**
 * The corrected handler.
 *
 * Changes, each addressing something specific:
 *
 * - The option is validated against the poll it claims to belong to. The
 *   original would happily record a vote for an option from another poll.
 * - Every read and write happens inside one exclusive section, standing in for
 *   a single database transaction.
 * - There is exactly one authoritative vote row per (user, poll), enforced by
 *   a conditional insert rather than by a prior read.
 * - Tallies are derived from vote rows on read. The denormalised counter is
 *   not maintained at all, so it cannot drift.
 *
 * What this deliberately does *not* claim: that votes are applied in the order
 * the user cast them. Two changes of mind delivered concurrently can settle
 * either way. Choosing between them needs an ordering the events themselves
 * carry - a version or a sequence number - not a lock.
 */
export function voteFixed(store: PollStore, mutex: Mutex) {
  return async (command: VoteCommand): Promise<void> => {
    const { pollId, optionId, userId } = command;

    const poll = store.poll(pollId);
    if (poll === undefined) {
      throw new VoteRejected(404, `no such poll: ${pollId}`);
    }
    if (!poll.options.some((option) => option.id === optionId)) {
      throw new VoteRejected(422, `option ${optionId} does not belong to poll ${pollId}`);
    }

    await mutex.runExclusive(async () => {
      const inserted = store.insertVoteIfAbsent({ userId, pollId, optionId });
      if (inserted) {
        return;
      }
      // Already voted: this is a change of mind, which moves the single
      // authoritative row rather than adding another one.
      const existing = store.findVote(userId, pollId);
      if (existing !== undefined) {
        existing.optionId = optionId;
      }
      await tick();
    });
  };
}
