import { describe, expect, it } from "vitest";

import { assertRunPassed } from "@masterplaycoding/eventlab";

import { startExpress } from "../src/express.js";
import { startFastify } from "../src/fastify.js";
import { startNest } from "../src/nest.js";
import { deliverDuplicates, deliverForgeries, statusesOf, type Start } from "./scenario.js";

/**
 * Every recipe, against the same scenario.
 *
 * Each claim the recipes make is one of these assertions: that the app is
 * reachable on an ephemeral loopback port, that the signature is checked
 * against the bytes that were sent, that duplicates are absorbed, and that the
 * app shuts down inside EventLab's teardown budget and actually releases its
 * port.
 */
const recipes: [name: string, start: Start][] = [
  ["Express", startExpress],
  ["Fastify", startFastify],
  ["NestJS", startNest],
];

describe.each(recipes)("%s", (_name, start) => {
  it("fulfils each order once under duplicate, concurrent deliveries", async () => {
    // The provider pretty-prints its bodies, so a 200 here also means the
    // recipe checked the signature against the raw bytes: a re-serialised
    // body would not match even a valid signature.
    const { report } = await deliverDuplicates(start);

    assertRunPassed(report);
    expect(statusesOf(report)).toEqual(Array(9).fill(200));
  });

  it("refuses deliveries signed with the wrong key", async () => {
    // Without this, a recipe that never checked signatures at all would pass
    // the test above.
    const { report } = await deliverForgeries(start);

    assertRunPassed(report);
    expect(statusesOf(report)).toEqual(Array(9).fill(401));
  });

  it("listens on loopback and shuts down inside the teardown budget", async () => {
    const { report, baseUrl } = await deliverDuplicates(start);

    expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
    expect(report.cleanup.status).toBe("ok");

    // A close() that resolved without closing would pass everything above.
    // The port being refused afterwards is what "shut down" means.
    await expect(fetch(`${baseUrl}/webhooks`, { method: "POST" })).rejects.toThrow();
  });
});
