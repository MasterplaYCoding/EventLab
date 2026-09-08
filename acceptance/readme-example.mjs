/**
 * The README example, as an executable acceptance fixture.
 *
 * This file runs against the *packaged* library - a tarball built by
 * `npm pack` and installed into a throwaway directory - rather than against
 * the workspace source. It therefore checks the things a workspace test cannot:
 * that the package exports resolve, that the type of module actually published
 * can be imported by a plain consumer, and that the code printed in the README
 * is the code that works.
 *
 * It is plain JavaScript on purpose. A consumer should not need a build step
 * to use this library.
 *
 * Exit code 0 means the README is accurate. Anything else means it is not.
 */
import { createServer } from "node:http";
import assert from "node:assert/strict";

import { burst, createPlan, duplicate, runPlan, shuffle } from "@masterplaycoding/eventlab";

// --- the application under test -------------------------------------------

const fulfillments = new Set();
let writes = 0;

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The handler from the top of the README: check, then act. */
async function handlePayment(event) {
  await tick();
  const alreadyFulfilled = fulfillments.has(event.orderId);
  await tick();
  if (!alreadyFulfilled) {
    writes += 1;
    fulfillments.add(event.orderId);
  }
}

const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    void handlePayment(JSON.parse(Buffer.concat(chunks).toString("utf8"))).then(() => {
      response.statusCode = 200;
      response.end('{"ok":true}');
    });
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

// --- the README example ----------------------------------------------------

const paymentEvents = [
  { id: "evt_payment_1", body: { eventId: "evt_payment_1", orderId: "ord_1001", amount: 4999 } },
  { id: "evt_payment_2", body: { eventId: "evt_payment_2", orderId: "ord_1002", amount: 12500 } },
];

const plan = createPlan({
  scenario: "payment delivered three times",
  events: paymentEvents,
  seed: 20260908,
  concurrency: 4,
  transforms: [duplicate({ copies: 3 }), shuffle(), burst()],
});

const report = await runPlan(plan, {
  events: paymentEvents,
  target: {
    baseUrl,
    request: ({ event }) => ({
      method: "POST",
      path: "/webhooks",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event.body),
    }),
  },
  hooks: {
    reset: () => {
      fulfillments.clear();
      writes = 0;
    },
  },
  assertions: [
    {
      name: "each order is fulfilled exactly once",
      check: () => {
        if (writes !== 2) {
          throw new Error(`expected 2 fulfilments, found ${writes}`);
        }
      },
    },
  ],
});

// --- the claims the README makes -------------------------------------------

assert.equal(report.attempts.length, 6, "the plan should deliver six attempts");
assert.ok(
  report.attempts.every((attempt) => attempt.outcome.kind === "response" && attempt.outcome.status === 200),
  "every delivery should return 200 - that is the trap the README describes",
);
assert.equal(report.passed, false, "the broken handler must fail the business assertion");
assert.equal(report.assertions[0].status, "failed");
assert.ok(writes > 2, `expected duplicate fulfilment writes, found ${writes}`);
assert.equal(report.seed, 20260908);
assert.ok(report.fixtureDigest.startsWith("sha256:"));

// The report must not leak payloads into an artifact.
assert.ok(!JSON.stringify(report).includes("12500"), "reports must not embed fixture bodies");

await new Promise((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);

console.log(
  `README example verified against the packaged library: ` +
    `${report.attempts.length} deliveries, all 200, ${writes} fulfilment writes for 2 orders.`,
);
