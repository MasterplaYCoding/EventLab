import { describe, expect, it } from "vitest";

import { renderHtml } from "../src/html.js";
import { createPlan } from "@masterplaycoding/eventlab";
import type {
  AssertionReport,
  AttemptReport,
  DeliveryOutcome,
  RunReport,
} from "@masterplaycoding/eventlab";

/**
 * The timeline is a file people forward.
 *
 * Everything in it — scenario names, attempt ids, URLs, assertion messages,
 * response previews — arrives from outside the process: from a target that may
 * be misbehaving, or from a scenario someone else wrote. It is then written
 * into HTML and opened in a browser. That is an injection surface, and the
 * only reason it is not a vulnerability is one small function nothing tested.
 */

const events = [{ id: "evt_a", body: { order: "ord_1" } }];
const plan = createPlan({ scenario: "html", events, seed: 1 });

const responded = (status: number, bodyPreview = ""): DeliveryOutcome => ({
  kind: "response",
  status,
  bodyPreview,
  bodyTruncated: false,
});

function attempt(overrides: Partial<AttemptReport> = {}): AttemptReport {
  return {
    attemptId: "evt_a#1",
    eventId: "evt_a",
    copyIndex: 1,
    order: 0,
    intendedStartMs: 0,
    observedStartMs: 0,
    durationMs: 5,
    request: {
      method: "POST",
      url: "http://127.0.0.1:3000/webhooks",
      headerNames: [],
      bodyBytes: 4,
    },
    outcome: responded(200),
    ...overrides,
  };
}

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    reportSchemaVersion: "2",
    plannerVersion: "2",
    scenario: "html",
    seed: 1,
    fixtureDigest: `sha256:${"0".repeat(64)}`,
    plan,
    limits: { requestTimeoutMs: 5000, scenarioTimeoutMs: 30000, maxResponseBodyBytes: 65536 },
    startedAt: "2026-09-10T00:00:00.000Z",
    wallClockMs: 10,
    attempts: [attempt()],
    assertions: [],
    barriers: [],
    expectation: { deliveries: "all-2xx" },
    passed: true,
    cleanup: { status: "ok" },
    redaction: { requestBodies: "omitted", requestHeaders: "names-only" },
    reproduce: { note: "" },
    ...overrides,
  };
}

const failing = (name: string, message: string): AssertionReport => ({
  name,
  kind: "check",
  status: "failed",
  durationMs: 1,
  message,
});

const INJECTION = `<script>alert("xss")</script>`;

describe("escaping", () => {
  it("escapes an assertion message", () => {
    const html = renderHtml(report({ assertions: [failing("check", INJECTION)], passed: false }));

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes the scenario name", () => {
    const html = renderHtml(report({ scenario: INJECTION }));

    expect(html).not.toContain("<script>alert");
  });

  it("escapes an assertion name", () => {
    const html = renderHtml(report({ assertions: [failing(INJECTION, "no")], passed: false }));

    expect(html).not.toContain("<script>alert");
  });

  it("escapes an attempt id and a URL", () => {
    // Both end up inside a title attribute as well as in table cells, so a
    // stray quote would break out of the attribute even without a tag.
    const html = renderHtml(
      report({
        attempts: [
          attempt({
            attemptId: `a" onmouseover="alert(1)`,
            request: {
              method: "POST",
              url: `http://127.0.0.1/"><script>alert(1)</script>`,
              headerNames: [],
              bodyBytes: 0,
            },
          }),
        ],
      }),
    );

    expect(html).not.toContain(`onmouseover="alert(1)"`);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&quot;");
  });

  it("escapes an event id", () => {
    const html = renderHtml(
      report({ attempts: [attempt({ eventId: INJECTION, attemptId: "x#1" })] }),
    );

    expect(html).not.toContain("<script>alert");
  });

  it("escapes ampersands before the entities it introduces", () => {
    // The order matters: escaping < before & would turn "<" into "&lt;" and
    // then into "&amp;lt;", rendering the entity as literal text.
    const html = renderHtml(report({ scenario: "a & b < c" }));

    expect(html).toContain("a &amp; b &lt; c");
    expect(html).not.toContain("&amp;lt;");
  });
});

describe("what the timeline deliberately omits", () => {
  it("omits response body previews even though the report holds them", () => {
    // A target that echoes a bearer token should not put it in a file someone
    // attaches to an issue.
    const secret = "Bearer sk_live_51H8xQ2";
    const html = renderHtml(
      report({ attempts: [attempt({ outcome: responded(200, `{"token":"${secret}"}`) })] }),
    );

    expect(html).not.toContain(secret);
  });

  it("references nothing outside the file", () => {
    // One standalone document: no network request when opened, no analytics,
    // nothing that tells anyone the file was read.
    const html = renderHtml(report());

    expect(html).not.toMatch(/src=["']https?:/);
    expect(html).not.toMatch(/href=["']https?:/);
    expect(html).not.toContain("//fonts.");
    expect(html).not.toContain("fetch(");
  });
});

describe("legibility", () => {
  it("says the status in words, not only in colour", () => {
    const html = renderHtml(
      report({ assertions: [failing("the invariant holds", "it did not")], passed: false }),
    );

    // Someone reading this without seeing colour still learns the outcome.
    expect(html).toContain("failed");
    expect(html).toContain("the invariant holds");
  });

  it("renders a run in which nothing was delivered", () => {
    const html = renderHtml(report({ attempts: [] }));

    expect(html).toContain("<title>EventLab");
    expect(html).toContain("</html>");
  });

  it("does not emit NaN when every attempt took no measurable time", () => {
    // Bar geometry is a percentage of the longest attempt's end time. On a
    // coarse clock a fast local run reports zeros for all of them, and the
    // divisor becomes zero unless something stops it - "left:NaN%" is what a
    // browser is handed otherwise. Math.max(1, ...) in renderHtml is that
    // something, and this is what holds it there.
    const html = renderHtml(
      report({
        wallClockMs: 0,
        attempts: [
          attempt({ attemptId: "a#1", observedStartMs: 0, durationMs: 0 }),
          attempt({ attemptId: "a#2", observedStartMs: 0, durationMs: 0 }),
        ],
      }),
    );

    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).toContain("a#1");
  });

  it("does not emit NaN for a run with no attempts at all", () => {
    // The spread is empty here, so the divisor comes from Math.max(1) alone.
    const html = renderHtml(report({ attempts: [] }));

    expect(html).not.toContain("NaN");
  });

  it("renders every outcome kind without losing one", () => {
    const html = renderHtml(
      report({
        attempts: [
          attempt({ attemptId: "a#1", outcome: responded(200) }),
          attempt({ attemptId: "a#2", outcome: responded(500) }),
          attempt({ attemptId: "a#3", outcome: { kind: "timeout", elapsedMs: 5000 } }),
          attempt({
            attemptId: "a#4",
            outcome: { kind: "transport-error", message: "ECONNRESET" },
          }),
        ],
      }),
    );

    for (const id of ["a#1", "a#2", "a#3", "a#4"]) {
      expect(html).toContain(id);
    }
  });
});
