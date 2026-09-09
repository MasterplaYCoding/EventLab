import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { burst, createPlan, duplicate, runPlan, shuffle } from "@masterplaycoding/eventlab";
import type { EventFixture, HttpTarget, PlanPhase } from "@masterplaycoding/eventlab";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { open } from "../src/schema.js";
import { startInboxServer, type InboxServer, type Mode } from "../src/server.js";
import { CrashedDeliberately, drain, dispatchPending, processOne } from "../src/worker.js";

let workspace: string;
let app: InboxServer | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "eventlab-inbox-"));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  rmSync(workspace, { recursive: true, force: true });
});

const databasePath = () => join(workspace, "orders.db");

/** One payment for one order, plus a later revision of the same order. */
const events: EventFixture[] = [
  { id: "evt_v1", body: { eventId: "evt_v1", orderId: "ord_1", resourceVersion: 1 } },
  { id: "evt_v2", body: { eventId: "evt_v2", orderId: "ord_1", resourceVersion: 2 } },
];

function targetFor(baseUrl: string): HttpTarget {
  return {
    baseUrl,
    request: ({ event }) => ({
      method: "POST",
      path: "/webhooks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event.body),
    }),
  };
}

/** Each event delivered three times, shuffled, released together. */
const duplicated: PlanPhase[] = [
  { deliver: ["evt_v1", "evt_v2"], transforms: [duplicate({ copies: 3 }), shuffle(), burst()] },
];

async function deliver(mode: Mode, phases: PlanPhase[] = duplicated) {
  app = await startInboxServer(mode, databasePath());
  const server = app;

  const plan = createPlan({
    scenario: "order events delivered three times",
    events,
    seed: 20260909,
    concurrency: 4,
    phases,
  });

  const report = await runPlan(plan, {
    events,
    target: targetFor(server.baseUrl),
    // The fixed endpoint answers 202, the broken one 200.
    expect: { deliveries: "declared" },
  });

  return { report, server };
}

const countOf = (database: ReturnType<typeof open>, sql: string): number =>
  (database.prepare(sql).get() as { n: number }).n;

describe("recording the event, then applying it", () => {
  it("deduplicates six deliveries into two inbox rows, by primary key", async () => {
    const { report, server } = await deliver("fixed");

    expect(report.attempts).toHaveLength(6);
    expect(
      report.attempts.every(
        (attempt) => attempt.outcome.kind === "response" && attempt.outcome.status === 202,
      ),
    ).toBe(true);

    // Two events, six deliveries, two rows. No handler logic decided that.
    expect(countOf(server.database, "SELECT COUNT(*) AS n FROM inbox")).toBe(2);
    // Nothing has been applied yet: the endpoint only records.
    expect(countOf(server.database, "SELECT COUNT(*) AS n FROM fulfillments")).toBe(0);
  });

  it("fulfils each order exactly once when the worker drains", async () => {
    const { server } = await deliver("fixed");

    const dispatched: string[] = [];
    drain({ database: server.database, dispatch: (orderId) => dispatched.push(orderId) });

    expect(countOf(server.database, "SELECT COUNT(*) AS n FROM fulfillments")).toBe(1);
    // Notifications are owed per *applied* event, and a stale one applies
    // nothing - so the count depends on which version arrived first, which is
    // the transport's business. What must hold is that the queue drains and at
    // least one notification went out.
    expect(dispatched.length).toBeGreaterThan(0);
    expect(dispatched.every((orderId) => orderId === "ord_1")).toBe(true);
    expect(
      countOf(server.database, "SELECT COUNT(*) AS n FROM outbox WHERE dispatched = 0"),
    ).toBe(0);
  });

  it("ignores an older resource version arriving after a newer one", async () => {
    app = await startInboxServer("fixed", databasePath());
    const server = app;

    // Deliver v2 first, then v1 - the reordering a transport can produce.
    const plan = createPlan({
      scenario: "reordered versions",
      events,
      seed: 1,
      phases: [
        { deliver: ["evt_v2"] },
        { barrier: "v2 applied", checkpoint: "drain" },
        { deliver: ["evt_v1"] },
      ],
    });

    await runPlan(plan, {
      events,
      target: targetFor(server.baseUrl),
      expect: { deliveries: "declared" },
      hooks: { checkpoints: { drain: () => void drain({ database: server.database }) } },
    });

    drain({ database: server.database });

    const order = server.database
      .prepare(`SELECT last_applied_version FROM orders WHERE order_id = 'ord_1'`)
      .get() as { last_applied_version: number };

    // The version is carried by the event. Arrival order decides nothing.
    expect(order.last_applied_version).toBe(2);
  });
});

describe("a worker killed mid-flight", () => {
  it("leaves the row pending when it dies before commit", async () => {
    const { server } = await deliver("fixed");

    expect(() =>
      processOne({ database: server.database, crashAt: "before-commit" }),
    ).toThrow(CrashedDeliberately);

    // Rolled back: nothing applied, and the work is still there to be redone.
    expect(countOf(server.database, "SELECT COUNT(*) AS n FROM fulfillments")).toBe(0);
    expect(
      countOf(server.database, "SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending'"),
    ).toBe(2);

    // A fresh handle on the same file - the state survived the "process".
    await server.close();
    app = undefined;
    const restarted = open(databasePath());
    expect(drain({ database: restarted })).toBe(2);
    expect(countOf(restarted, "SELECT COUNT(*) AS n FROM fulfillments")).toBe(1);
    restarted.close();
  });

  it("does not redo committed work when it dies after commit", async () => {
    const { server } = await deliver("fixed");

    expect(() =>
      processOne({ database: server.database, crashAt: "after-commit" }),
    ).toThrow(CrashedDeliberately);

    await server.close();
    app = undefined;

    const restarted = open(databasePath());
    // One row was committed before the crash; only the other remains.
    expect(
      countOf(restarted, "SELECT COUNT(*) AS n FROM inbox WHERE status = 'pending'"),
    ).toBe(1);

    const dispatched: string[] = [];
    drain({ database: restarted, dispatch: (orderId) => dispatched.push(orderId) });

    // Exactly one fulfilment, and the notification the crash interrupted is
    // still owed and now sent - because it was written in the same transaction
    // as the business change, so the crash could not separate them.
    expect(countOf(restarted, "SELECT COUNT(*) AS n FROM fulfillments")).toBe(1);
    expect(dispatched.length).toBeGreaterThan(0);
    expect(countOf(restarted, "SELECT COUNT(*) AS n FROM outbox WHERE dispatched = 0")).toBe(0);
    restarted.close();
  });

  it("still owes the notification when it dies before dispatching", async () => {
    const { server } = await deliver("fixed");

    expect(() =>
      processOne({ database: server.database, crashAt: "before-dispatch" }),
    ).toThrow(CrashedDeliberately);

    // Committed, but undispatched. That row is the entire reason an outbox
    // exists: a notification cannot be part of a transaction, so the *intent*
    // to send one is.
    expect(
      countOf(server.database, "SELECT COUNT(*) AS n FROM outbox WHERE dispatched = 0"),
    ).toBe(1);

    const dispatched: string[] = [];
    dispatchPending(server.database, { dispatch: (orderId) => dispatched.push(orderId) });
    expect(dispatched).toEqual(["ord_1"]);
  });

  it("sends a notification again when an acknowledgement was lost", async () => {
    const { server } = await deliver("fixed");
    drain({ database: server.database, dispatch: () => {} });

    // The dispatch succeeded but the acknowledgement did not arrive, so the
    // row is still marked undispatched.
    server.database.exec("UPDATE outbox SET dispatched = 0");

    const received: string[] = [];
    dispatchPending(server.database, { dispatch: (orderId) => received.push(orderId) });

    // At-least-once, not exactly-once. A dispatch that succeeded but whose
    // acknowledgement was lost is indistinguishable from one that failed, so it
    // is sent again. The receiver must be idempotent, and no arrangement of
    // this code changes that.
    expect(received.length).toBeGreaterThan(0);
  });
});

describe("doing the work in the request instead", () => {
  /**
   * Delivers v1, waits for it to be fully applied, then delivers v2.
   *
   * Explicit phases rather than a shuffle, because the failure below is about
   * *ordering*, and a scenario that only fails when the transport happens to
   * cooperate is not a regression test.
   */
  const inVersionOrder: PlanPhase[] = [
    { deliver: ["evt_v1"] },
    { barrier: "v1 applied", checkpoint: "settle" },
    { deliver: ["evt_v2"] },
  ];

  async function run(mode: Mode) {
    app = await startInboxServer(mode, databasePath());
    const server = app;

    const plan = createPlan({
      scenario: "a revision arrives after the original",
      events,
      seed: 5,
      phases: inVersionOrder,
    });

    await runPlan(plan, {
      events,
      target: targetFor(server.baseUrl),
      expect: { deliveries: "declared" },
      hooks: { checkpoints: { settle: () => void drain({ database: server.database }) } },
    });
    drain({ database: server.database });

    const order = server.database
      .prepare(`SELECT last_applied_version FROM orders WHERE order_id = 'ord_1'`)
      .get() as { last_applied_version: number } | undefined;

    return { server, version: order?.last_applied_version };
  }

  it("silently drops every event after the first for an order", async () => {
    const { server, version } = await run("broken");

    // The guard asks "has this order been fulfilled?" and treats that as "have
    // I processed this event?". Those are different questions, and conflating
    // them means the revision is discarded without a trace: no error, no
    // retry, just an order permanently stuck at the first version anyone sent.
    expect(version).toBe(1);

    // Nor is there anything to recover from. No inbox row means no record that
    // the event arrived; no outbox row means no record that a notification is
    // owed. If this process died now, both would be gone.
    expect(countOf(server.database, "SELECT COUNT(*) AS n FROM inbox")).toBe(0);
    expect(countOf(server.database, "SELECT COUNT(*) AS n FROM outbox")).toBe(0);
  });

  it("applies the revision when the event is recorded first", async () => {
    const { server, version } = await run("fixed");

    expect(version).toBe(2);
    // Both events survive as evidence, and both notifications are accounted
    // for, because recording came before applying.
    expect(countOf(server.database, "SELECT COUNT(*) AS n FROM inbox")).toBe(2);
    expect(countOf(server.database, "SELECT COUNT(*) AS n FROM outbox")).toBe(2);
  });
});
