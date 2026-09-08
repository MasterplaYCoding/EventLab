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
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";

import {
  burst,
  createPlan,
  duplicate,
  formatReport,
  runPlan,
  shuffle,
} from "@masterplaycoding/eventlab";

// --- the application under test -------------------------------------------

const fulfillments = new Set();
const processedEvents = new Set();
const writes = [];

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** The handler from the top of the README: deduplicated by event id. */
async function handlePayment(event) {
  await tick();
  if (processedEvents.has(event.eventId)) return;
  processedEvents.add(event.eventId);

  await tick();
  writes.push(event.orderId);
  fulfillments.add(event.orderId);
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

// Two orders. ord_1001 is described by two events, exactly as a provider that
// emits both a payment and a charge notification would.
const paymentEvents = [
  { id: "evt_payment_1", body: { eventId: "evt_payment_1", orderId: "ord_1001", amount: 4999 } },
  { id: "evt_payment_2", body: { eventId: "evt_payment_2", orderId: "ord_1002", amount: 12500 } },
  { id: "evt_charge_1", body: { eventId: "evt_charge_1", orderId: "ord_1001", amount: 4999 } },
];

const plan = createPlan({
  scenario: "payments delivered three times",
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
      processedEvents.clear();
      writes.length = 0;
    },
  },
  assertions: [
    {
      name: "each order is fulfilled exactly once",
      check: () => {
        if (writes.length !== 2) {
          throw new Error(`expected 2 fulfilment writes, found ${writes.length}`);
        }
      },
    },
  ],
});

// --- the claims the README makes -------------------------------------------

const writesFor = (orderId) => writes.filter((written) => written === orderId).length;

assert.equal(report.attempts.length, 9, "the plan should deliver nine attempts");
assert.ok(
  report.attempts.every(
    (attempt) => attempt.outcome.kind === "response" && attempt.outcome.status === 200,
  ),
  "every delivery should return 200 - that is the trap the README describes",
);
assert.equal(report.passed, false, "the broken handler must fail the business assertion");
assert.equal(report.assertions[0].status, "failed");
assert.equal(
  report.assertions[0].message,
  "expected 2 fulfilment writes, found 3",
  "the README prints this exact failure",
);

// The specific, platform-independent shape of the bug: one order fulfilled
// twice because two event ids describe it.
assert.equal(writesFor("ord_1001"), 2);
assert.equal(writesFor("ord_1002"), 1);

assert.equal(report.seed, 20260908);
assert.ok(report.fixtureDigest.startsWith("sha256:"));

// The report must not leak payloads into an artifact.
assert.ok(!JSON.stringify(report).includes("12500"), "reports must not embed fixture bodies");

// --- the README's console block must be this library's actual output --------
//
// The block used to be typeset by hand, which meant the most prominent claim
// in the project was the one thing nothing verified. Now it is compared to
// formatReport's output, from the packaged library, on every CI job.

const readme = await readFile("README.md", "utf8");

// The first fenced block carrying no language tag after "### The failing test".
// Selecting by info string rather than by position matters: the section opens
// with a ```ts block, and that block's *closing* fence looks exactly like the
// opening of an untagged one.
const section = readme.split("### The failing test")[1] ?? "";
const fences = [...section.matchAll(/^```([^\n]*)\r?\n([\s\S]*?)^```/gm)];
const printed = fences
  .find((fence) => fence[1].trim() === "")?.[2]
  ?.replace(/\r/g, "")
  .replace(/\n$/, "");

assert.ok(printed !== undefined, "could not find the console block in README.md");

// The digest depends on the fixture bodies, so the README shows a real prefix
// rather than a placeholder; compare against the same rendering the tool emits.
assert.equal(
  formatReport(report),
  printed,
  "README.md's console block is not what formatReport produces",
);

await new Promise((resolve, reject) =>
  server.close((error) => (error ? reject(error) : resolve())),
);

console.log(
  `README example verified against the packaged library: ` +
    `${report.attempts.length} deliveries, all 200, ord_1001 fulfilled ` +
    `${writesFor("ord_1001")} times.`,
);
