import { describe, expect, it } from "vitest";

import { assertRunPassed } from "@masterplaycoding/eventlab";

import { startNext } from "../start.js";
import { deliverDuplicates, deliverForgeries, statusesOf } from "../../test/scenario.js";

/**
 * The Next.js recipe, against the same scenario as the others.
 *
 * Kept apart from them because Next is a 300 MB install and a build step, and
 * the rest of the suite should not pay for it on every run. It has its own
 * package and lockfile, its own CI job, and `npm run test:nextjs`; the
 * assertions are the ones every other recipe meets.
 */
describe("Next.js", () => {
  it("fulfils each order once under duplicate, concurrent deliveries", async () => {
    // Pretty-printed bodies, so a 200 means the route read the raw bytes.
    const { report } = await deliverDuplicates(startNext);

    assertRunPassed(report);
    expect(statusesOf(report)).toEqual(Array(9).fill(200));
  });

  it("refuses deliveries signed with the wrong key", async () => {
    const { report } = await deliverForgeries(startNext);

    assertRunPassed(report);
    expect(statusesOf(report)).toEqual(Array(9).fill(401));
  });

  it("listens on loopback and shuts down inside the teardown budget", async () => {
    const { report, baseUrl } = await deliverDuplicates(startNext);

    expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
    expect(report.cleanup.status).toBe("ok");
    await expect(fetch(`${baseUrl}/webhooks`, { method: "POST" })).rejects.toThrow();
  });
});
