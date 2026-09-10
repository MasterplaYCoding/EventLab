import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createPlan } from "../src/plan/createPlan.js";
import { runPlan } from "../src/run/runPlan.js";
import { formatReport } from "../src/report/format.js";

/**
 * A report is meant to be attachable to an issue.
 *
 * That is the only reason request bodies are dropped and headers reduced to
 * their names — a webhook request carries a provider signature, and often a
 * bearer token, and a report that quotes them turns a bug report into a
 * credential disclosure.
 *
 * The report *shape* was covered by fixtures that set those fields by hand,
 * which proves nothing about what a real delivery puts in them. These run a
 * delivery carrying real secrets and look for them everywhere a report is
 * exposed.
 */

let server: Server | undefined;
let baseUrl = "";

afterEach(async () => {
  const closing = server;
  server = undefined;
  if (closing !== undefined) {
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }
});

async function startTarget(): Promise<void> {
  server = createServer((incoming, response) => {
    incoming.on("data", () => {});
    incoming.on("end", () => {
      response.statusCode = 200;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
}

const SIGNATURE = "t=1700000000,v1=DEADBEEFCAFEBABE-signature-secret";
const TOKEN = "Bearer sk_live_51H8xQ2NotARealKey";
const CARD = "4242424242424242";

const events = [{ id: "evt_a", body: { orderId: "ord_1", card: CARD } }];
const plan = createPlan({ scenario: "redaction", events, seed: 1 });

async function deliverWithSecrets(path = "/webhooks") {
  await startTarget();
  return runPlan(plan, {
    events,
    target: {
      baseUrl,
      request: ({ event }) => ({
        method: "POST",
        path,
        headers: {
          "content-type": "application/json",
          "x-provider-signature": SIGNATURE,
          authorization: TOKEN,
        },
        body: JSON.stringify(event.body),
      }),
    },
  });
}

describe("what a report keeps of a request", () => {
  it("keeps no part of the request body", async () => {
    const report = await deliverWithSecrets();
    const serialised = JSON.stringify(report);

    // The card number is in the fixture, which the scenario author has, and in
    // the request body, which the report must not.
    expect(serialised).not.toContain(CARD);
  });

  it("keeps no header values", async () => {
    const report = await deliverWithSecrets();
    const serialised = JSON.stringify(report);

    expect(serialised).not.toContain(SIGNATURE);
    expect(serialised).not.toContain(TOKEN);
    expect(serialised).not.toContain("sk_live");
  });

  it("keeps header names, because which headers were sent is the useful part", async () => {
    const report = await deliverWithSecrets();

    // A signature header being absent is a real cause of a 401, and finding
    // that out should not require sending the value to anyone.
    expect(report.attempts[0]?.request.headerNames).toContain("x-provider-signature");
    expect(report.attempts[0]?.request.headerNames).toContain("authorization");
  });

  it("keeps the body's size, because a truncated payload is a real bug", async () => {
    const report = await deliverWithSecrets();
    const expected = Buffer.byteLength(JSON.stringify(events[0]?.body), "utf8");

    expect(report.attempts[0]?.request.bodyBytes).toBe(expected);
  });

  it("does not leak secrets through the formatted report either", async () => {
    // formatReport is what assertRunPassed throws, so it lands in CI logs -
    // which is a wider audience than the JSON ever gets.
    const report = await deliverWithSecrets();
    const text = formatReport(report, { timings: true });

    expect(text).not.toContain(CARD);
    expect(text).not.toContain(SIGNATURE);
    expect(text).not.toContain("sk_live");
  });

  it("says in the report itself what it redacted", async () => {
    // A reader should not have to infer the policy from the absence of data.
    const report = await deliverWithSecrets();

    expect(report.redaction).toEqual({
      requestBodies: "omitted",
      requestHeaders: "names-only",
    });
  });
});

describe("the limit of that", () => {
  it("records the request URL in full, query string included", async () => {
    // Pinned because it is the one way a secret still reaches a report, and
    // because it is a deliberate trade rather than an oversight: the URL is
    // how anyone reading the report knows which endpoint was hit, and a
    // redacted one would make the whole delivery unidentifiable.
    //
    // A provider that authenticates by query parameter - and some do - needs
    // to know this before attaching a report to a public issue.
    const report = await deliverWithSecrets("/webhooks?access_token=not-a-secret-here");

    expect(report.attempts[0]?.request.url).toContain("access_token=not-a-secret-here");
  });
});
