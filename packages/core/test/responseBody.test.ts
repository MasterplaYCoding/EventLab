import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createPlan } from "../src/plan/createPlan.js";
import { runPlan } from "../src/run/runPlan.js";

/**
 * What a hostile or merely careless response costs.
 *
 * The target is the thing under test, which makes it also the thing least
 * entitled to trust. Its response body is the one part of it EventLab keeps,
 * and the report documents a bound on that. This is where the bound is checked
 * - both halves of it, because bounded memory and bounded work are different
 * promises and only one of them used to hold.
 */

/**
 * A target whose response body does not end.
 *
 * Each one owns its own state. Sharing it across tests is a trap: the `close`
 * handler fires asynchronously during socket teardown, so a previous test's
 * connection can flip a module-level flag while the next test is already
 * running - and a server that has been told to stop writing but never ends its
 * response makes the *client* look like it hung.
 */
class EndlessTarget {
  private readonly server: Server;
  private stopped = false;
  /** Bytes this target managed to write before anyone stopped it. */
  written = 0;

  private constructor(server: Server) {
    this.server = server;
  }

  static async start(): Promise<EndlessTarget> {
    let target: EndlessTarget;
    const chunk = "x".repeat(64 * 1024);

    const server = createServer((incoming, response) => {
      incoming.on("data", () => {});
      incoming.on("end", () => {
        response.statusCode = 200;
        response.setHeader("content-type", "text/plain");

        const pump = (): void => {
          if (target.stopped || response.writableEnded || response.destroyed) return;
          // Bounded so a failing test cannot run forever. Far larger than any
          // limit under test, which is the point.
          if (target.written >= 32 * 1024 * 1024) {
            response.end();
            return;
          }
          target.written += chunk.length;
          if (response.write(chunk)) setImmediate(pump);
          else response.once("drain", pump);
        };

        response.on("close", () => {
          target.stopped = true;
        });
        pump();
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    target = new EndlessTarget(server);
    return target;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const events = [{ id: "evt_a", body: { order: "ord_1" } }];
const plan = createPlan({ scenario: "response bodies", events, seed: 1 });
const request = () => ({ method: "POST" as const, path: "/webhooks" });

let target: EndlessTarget | undefined;

afterEach(async () => {
  await target?.close();
  target = undefined;
});

async function deliverAgainstEndlessTarget(maxResponseBodyBytes: number) {
  target = await EndlessTarget.start();
  return runPlan(plan, {
    events,
    target: { baseUrl: target.baseUrl, request },
    limits: { maxResponseBodyBytes, requestTimeoutMs: 10_000 },
  });
}

describe("a target that will not stop talking", () => {
  it("records the response it actually received, not a timeout", async () => {
    const started = Date.now();
    const report = await deliverAgainstEndlessTarget(1024);
    const elapsed = Date.now() - started;

    // The server answered 200 immediately. Reporting a timeout would be a
    // statement about the application that is simply untrue: it responded, and
    // it responded at once.
    expect(report.attempts[0]?.outcome).toMatchObject({ kind: "response", status: 200 });
    expect(elapsed).toBeLessThan(9_000);
  });

  it("keeps no more of the body than the limit allows", async () => {
    const report = await deliverAgainstEndlessTarget(1024);

    const outcome = report.attempts[0]?.outcome;
    if (outcome?.kind !== "response") throw new Error(`expected a response, got ${outcome?.kind}`);

    expect(outcome.bodyTruncated).toBe(true);
    expect(Buffer.byteLength(outcome.bodyPreview, "utf8")).toBeLessThanOrEqual(1024);
  });

  it("stops reading once it has what it will keep", async () => {
    // Bounded memory is not bounded work. A reader that keeps 1 KiB but drains
    // 32 MiB off the socket spends the run's time and the network's bandwidth
    // on bytes it has already decided to discard - and against a body that
    // genuinely never ends it spends the entire request timeout.
    await deliverAgainstEndlessTarget(1024);

    // Some overshoot is unavoidable: bytes are in flight when the limit is
    // reached, and the transport tears down asynchronously. Megabytes are not
    // overshoot.
    expect(target?.written).toBeLessThan(4 * 1024 * 1024);
  });
});

describe("a body that fits", () => {
  it("is not marked truncated when it ends exactly at the limit", async () => {
    // The boundary. Marking a body truncated because it happened to be exactly
    // the limit would make the flag mean "possibly complete", which is no use
    // to anyone reading a report.
    const body = "y".repeat(512);
    const server = createServer((incoming, response) => {
      incoming.on("data", () => {});
      incoming.on("end", () => {
        response.statusCode = 200;
        response.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const report = await runPlan(plan, {
        events,
        target: { baseUrl: url, request },
        limits: { maxResponseBodyBytes: 512 },
      });

      const outcome = report.attempts[0]?.outcome;
      if (outcome?.kind !== "response") throw new Error(`expected a response, got ${outcome?.kind}`);

      expect(outcome.bodyPreview).toBe(body);
      expect(outcome.bodyTruncated).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps a short body whole", async () => {
    const server = createServer((incoming, response) => {
      incoming.on("data", () => {});
      incoming.on("end", () => {
        response.statusCode = 200;
        response.end(`{"ok":true}`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const report = await runPlan(plan, {
        events,
        target: { baseUrl: url, request },
        limits: { maxResponseBodyBytes: 65_536 },
      });

      const outcome = report.attempts[0]?.outcome;
      if (outcome?.kind !== "response") throw new Error("expected a response");

      expect(outcome.bodyPreview).toBe(`{"ok":true}`);
      expect(outcome.bodyTruncated).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
