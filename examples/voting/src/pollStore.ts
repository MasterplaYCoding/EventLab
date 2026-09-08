/**
 * A minimal poll / option / vote model.
 *
 * Only the fields the failure needs are here: no authentication, no
 * pagination, no ownership, no interaction counters beyond the one that
 * actually drifts. The relationships and the vote-counting behaviour are
 * adapted from GOATalking's poll schema; everything else is left behind.
 */

export interface PollOption {
  readonly id: string;
  readonly text: string;
  /** Denormalised tally. Present because the original had one - and it drifts. */
  votes: number;
}

export interface Poll {
  readonly id: string;
  readonly title: string;
  readonly options: PollOption[];
}

export interface PollVote {
  readonly userId: string;
  readonly pollId: string;
  optionId: string;
}

export class PollStore {
  private polls = new Map<string, Poll>();
  private votes: PollVote[] = [];

  seed(polls: readonly Poll[]): void {
    this.polls = new Map(
      polls.map((poll) => [
        poll.id,
        { ...poll, options: poll.options.map((option) => ({ ...option, votes: 0 })) },
      ]),
    );
    this.votes = [];
  }

  poll(pollId: string): Poll | undefined {
    return this.polls.get(pollId);
  }

  /** The authoritative vote rows: one row per (user, poll) if the code is right. */
  voteRows(): readonly PollVote[] {
    return this.votes;
  }

  findVote(userId: string, pollId: string): PollVote | undefined {
    return this.votes.find((vote) => vote.userId === userId && vote.pollId === pollId);
  }

  insertVote(vote: PollVote): void {
    this.votes.push(vote);
  }

  /**
   * Inserts a vote row only if the (userId, pollId) pair is free, in one
   * indivisible step. The in-memory equivalent of a unique constraint.
   */
  insertVoteIfAbsent(vote: PollVote): boolean {
    if (this.findVote(vote.userId, vote.pollId) !== undefined) {
      return false;
    }
    this.votes.push(vote);
    return true;
  }

  /** Tallies derived from the vote rows themselves. This is the truth. */
  derivedTallies(pollId: string): Record<string, number> {
    const tallies: Record<string, number> = {};
    for (const option of this.polls.get(pollId)?.options ?? []) {
      tallies[option.id] = 0;
    }
    for (const vote of this.votes) {
      if (vote.pollId === pollId && tallies[vote.optionId] !== undefined) {
        tallies[vote.optionId] += 1;
      }
    }
    return tallies;
  }

  /** Tallies as stored in the denormalised counters. */
  storedTallies(pollId: string): Record<string, number> {
    return Object.fromEntries(
      (this.polls.get(pollId)?.options ?? []).map((option) => [option.id, option.votes]),
    );
  }
}

/**
 * A cooperative lock, standing in for a database transaction.
 *
 * Real correctness here comes from the database: one transaction, plus a
 * unique constraint on (user_id, poll_id). This lock reproduces the property
 * that matters for the example - no interleaving between read and write - and
 * nothing more. It is not a distributed lock and is not offered as a pattern.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

/** Yields to the event loop, so a read and a write are not one atomic step. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
