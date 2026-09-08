import { afterEach, describe, expect, it } from "vitest";
import { burst, createPlan, duplicate, runPlan, shuffle } from "@masterplaycoding/eventlab";
import type { EventFixture, HttpTarget, RunReport } from "@masterplaycoding/eventlab";

import {
  demoPoll,
  startUngatedVotingServer,
  startVotingServer,
  type Mode,
  type VotingServer,
} from "../src/server.js";

let app: VotingServer | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const VOTERS = 2;

/**
 * Two people vote once each. Everything that happens beyond that is the
 * transport's doing, which is where duplication belongs in a model of the
 * system.
 */
const voteEvents: EventFixture[] = [
  { id: "vote_u1", body: { pollId: "poll_1", optionId: "opt_a", userId: "user_1" } },
  { id: "vote_u2", body: { pollId: "poll_1", optionId: "opt_b", userId: "user_2" } },
];

function jsonTarget(baseUrl: string): HttpTarget {
  return {
    baseUrl,
    request: ({ event }) => ({
      method: "POST",
      path: "/votes",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event.body),
    }),
  };
}

/**
 * Each vote delivered twice, shuffled, all four released together against a
 * concurrency of four.
 *
 * Both deliveries for a voter are therefore in flight at once, and the
 * server's interleaving gate holds them both inside the critical section
 * before either leaves it. The overlap is a property of the scenario, not of
 * the machine running it.
 */
async function runVotingScenario(mode: Mode): Promise<{ report: RunReport; app: VotingServer }> {
  app = await startVotingServer(mode);
  const server = app;

  const plan = createPlan({
    scenario: "duplicated and reordered votes",
    events: voteEvents,
    seed: 1337,
    concurrency: 4,
    transforms: [duplicate({ copies: 2 }), shuffle(), burst()],
  });

  const report = await runPlan(plan, {
    events: voteEvents,
    target: jsonTarget(server.baseUrl),
    hooks: { reset: () => server.reset() },
    assertions: [
      {
        name: "one authoritative vote row per user and poll",
        check: () => {
          const seen = new Set<string>();
          for (const vote of server.store.voteRows()) {
            const key = `${vote.userId}/${vote.pollId}`;
            if (seen.has(key)) {
              throw new Error(`user ${vote.userId} has more than one vote row for ${vote.pollId}`);
            }
            seen.add(key);
          }
        },
      },
      {
        name: "the tally accounts for every voter exactly once",
        check: () => {
          const derived = server.store.derivedTallies(demoPoll.id);
          const total = Object.values(derived).reduce((sum, count) => sum + count, 0);
          if (total !== VOTERS) {
            throw new Error(`expected ${VOTERS} counted votes, found ${total}`);
          }
        },
      },
    ],
  });

  return { report, app: server };
}

describe("the GOATalking-shaped voting endpoint", () => {
  it("returns 200 for every delivery while recording two vote rows per voter", async () => {
    const { report, app: server } = await runVotingScenario("broken");

    expect(report.attempts).toHaveLength(voteEvents.length * 2);
    expect(report.attempts.every((attempt) => attempt.outcome.kind === "response")).toBe(true);

    // Read the vote, then write it, with no transaction spanning the two: both
    // deliveries find no existing row and both insert one.
    expect(server.store.voteRows()).toHaveLength(4);
    expect(report.passed).toBe(false);
    expect(report.assertions.map((assertion) => assertion.status)).toEqual(["failed", "failed"]);

    // Worth noticing: the denormalised counters agree with those rows. They
    // drifted together, in the same direction, so a consistency check between
    // the counter and its source would have reported everything as fine. The
    // invariant worth asserting is the one about users.
    expect(server.store.storedTallies(demoPoll.id)).toEqual(
      server.store.derivedTallies(demoPoll.id),
    );
  });
});

describe("the corrected voting endpoint", () => {
  it("keeps one vote row per user under the identical overlap", async () => {
    const { report, app: server } = await runVotingScenario("fixed");

    expect(report.attempts).toHaveLength(voteEvents.length * 2);
    expect(report.passed).toBe(true);
    expect(server.store.voteRows()).toHaveLength(VOTERS);

    const derived = server.store.derivedTallies(demoPoll.id);
    expect(derived.opt_a! + derived.opt_b!).toBe(VOTERS);
  });

  it("rejects an option that belongs to another poll", async () => {
    app = await startUngatedVotingServer();
    const server = app;

    const strayEvents: EventFixture[] = [
      {
        id: "vote_stray",
        body: { pollId: "poll_1", optionId: "opt_from_elsewhere", userId: "user_9" },
      },
    ];
    const plan = createPlan({ scenario: "stray option", events: strayEvents, seed: 5 });

    const report = await runPlan(plan, {
      events: strayEvents,
      target: jsonTarget(server.baseUrl),
      // A 422 is the point of this test, so the rejection is declared rather
      // than treated as a delivery failure.
      expect: { deliveries: "declared" },
    });

    expect(report.attempts[0]?.outcome).toMatchObject({ kind: "response", status: 422 });
    expect(server.store.voteRows()).toHaveLength(0);
  });
});
