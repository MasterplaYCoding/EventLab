import { afterEach, describe, expect, it } from "vitest";
import { burst, createPlan, duplicate, runPlan, shuffle } from "@masterplaycoding/eventlab";
import type { EventFixture, HttpTarget, RunReport } from "@masterplaycoding/eventlab";

import { demoPoll, startVotingServer, type Mode, type VotingServer } from "../src/server.js";

let app: VotingServer | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/**
 * Four users vote, and two of them change their mind. Fixtures describe what
 * the users did once; the plan is what the transport does to it.
 */
const VOTERS = 4;

const voteEvents: EventFixture[] = [
  { id: "vote_u1", body: { pollId: "poll_1", optionId: "opt_a", userId: "user_1" } },
  { id: "vote_u2", body: { pollId: "poll_1", optionId: "opt_b", userId: "user_2" } },
  { id: "vote_u3", body: { pollId: "poll_1", optionId: "opt_a", userId: "user_3" } },
  { id: "vote_u4", body: { pollId: "poll_1", optionId: "opt_b", userId: "user_4" } },
  { id: "vote_u1_changed", body: { pollId: "poll_1", optionId: "opt_b", userId: "user_1" } },
  { id: "vote_u3_changed", body: { pollId: "poll_1", optionId: "opt_b", userId: "user_3" } },
];

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

  const target: HttpTarget = {
    baseUrl: server.baseUrl,
    request: ({ event }) => ({
      method: "POST",
      path: "/votes",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event.body),
    }),
  };

  const report = await runPlan(plan, {
    events: voteEvents,
    target,
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
  it("returns 200 for every delivery while its counters drift away from the vote rows", async () => {
    const { report, app: server } = await runVotingScenario("broken");

    expect(report.attempts).toHaveLength(voteEvents.length * 2);
    expect(report.attempts.every((attempt) => attempt.outcome.kind === "response")).toBe(true);

    expect(report.passed).toBe(false);
    const failed = report.assertions.filter((assertion) => assertion.status === "failed");
    expect(failed.length).toBeGreaterThan(0);

    // The concrete symptom: four people voted, and the poll holds more than
    // four vote rows. Note that the denormalised counters agree with those
    // rows - they drifted together, in the same direction. A consistency
    // check between the counter and the rows would have reported everything
    // as fine, which is why the invariant worth asserting is the one about
    // users, not the one about internal agreement.
    expect(server.store.voteRows().length).toBeGreaterThan(VOTERS);
  });
});

describe("the corrected voting endpoint", () => {
  it("keeps one vote row per user and never disagrees with itself", async () => {
    const { report, app: server } = await runVotingScenario("fixed");

    expect(report.passed).toBe(true);
    expect(server.store.voteRows()).toHaveLength(4);

    const derived = server.store.derivedTallies(demoPoll.id);
    expect(derived.opt_a! + derived.opt_b!).toBe(4);
  });

  it("rejects an option that belongs to another poll", async () => {
    app = await startVotingServer("fixed");
    const server = app;

    const strayEvents: EventFixture[] = [
      { id: "vote_stray", body: { pollId: "poll_1", optionId: "opt_from_elsewhere", userId: "user_9" } },
    ];
    const plan = createPlan({ scenario: "stray option", events: strayEvents, seed: 5 });

    const report = await runPlan(plan, {
      events: strayEvents,
      target: {
        baseUrl: server.baseUrl,
        request: ({ event }) => ({
          method: "POST",
          path: "/votes",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(event.body),
        }),
      },
      // A 422 is the point of this test, so the rejection is declared rather
      // than treated as a delivery failure.
      expect: { deliveries: "declared" },
    });

    expect(report.attempts[0]?.outcome).toMatchObject({ kind: "response", status: 422 });
    expect(server.store.voteRows()).toHaveLength(0);
  });
});
