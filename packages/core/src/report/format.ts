import type { AssertionReport, BarrierReport, RunReport } from "../types.js";
import { summariseStatuses } from "./summary.js";

export interface FormatReportOptions {
  /**
   * Include observed timings. Off by default, so the output is stable enough
   * to assert on: a report that prints durations cannot be compared to a
   * fixture, and the README's block is checked against this function's output
   * on every CI run.
   */
  readonly timings?: boolean;
  /** Hex characters of the fixture digest to show. Defaults to 4. */
  readonly digestChars?: number;
}

const DEFAULT_DIGEST_CHARS = 4;

/**
 * Renders a {@link RunReport} as human-readable text.
 *
 * A pure function returning a string: no `process.stdout`, no colour, no TTY
 * detection, no dependency on a terminal existing at all. The core must not
 * import a test runner or assume it is being run by one, and a value that is
 * merely a string can be asserted on, embedded in an error message, or written
 * to a file by the caller.
 *
 * The output is what the README prints. That is not a coincidence: the
 * acceptance fixture compares this function's output to the block in
 * README.md, so the documentation cannot drift from the tool.
 */
export function formatReport(report: RunReport, options: FormatReportOptions = {}): string {
  const lines: string[] = [];

  if (report.harnessError !== undefined) {
    // Assertions never ran, so listing them would imply they passed.
    lines.push(`⚠ harness error: ${report.harnessError.code}`);
    lines.push(`  ${report.harnessError.message}`);
    if (report.harnessError.at !== undefined) {
      lines.push(`  at ${report.harnessError.at}`);
    }
    lines.push("");
    lines.push(`  ${describeDeliveries(report)}`);
    lines.push(...describeCleanup(report));
    lines.push(`  ${describeProvenance(report, options)}`);
    lines.push("");
    lines.push("  This is an EventLab problem, not a failure of the application under test.");
    return lines.join("\n");
  }

  // Defensive: formatReport is a display function, and a report deserialised
  // from an older schema should degrade rather than crash.
  for (const barrier of report.barriers ?? []) {
    lines.push(...formatBarrier(barrier));
  }

  if (report.assertions.length === 0) {
    lines.push("· no assertions declared");
  } else {
    for (const assertion of report.assertions) {
      lines.push(...formatAssertion(assertion));
    }
  }

  lines.push("");
  lines.push(`  ${describeDeliveries(report)}`);
  lines.push(...describeCleanup(report));
  lines.push(`  ${describeProvenance(report, options)}`);

  if (options.timings === true) {
    lines.push(`  ${report.wallClockMs}ms wall clock`);
  }

  return lines.join("\n");
}

function formatBarrier(barrier: BarrierReport): string[] {
  const waited =
    barrier.checkpoint === undefined ? "" : ` (waited for ${barrier.checkpoint})`;

  if (barrier.status === "passed") {
    return [`⏸ barrier "${barrier.name}" after ${barrier.attemptsBefore} deliveries${waited}`];
  }
  if (barrier.status === "skipped") {
    // A run that ended early never reached this one; saying so is better than
    // leaving a gap the reader has to notice for themselves.
    return [`⏸ barrier "${barrier.name}" not reached`];
  }
  return [
    `✗ barrier "${barrier.name}"${waited}`,
    `  ${barrier.message ?? "the checkpoint failed"}`,
  ];
}

function formatAssertion(assertion: AssertionReport): string[] {
  if (assertion.status === "passed") {
    return [`✓ ${assertion.name}`];
  }

  const lines = [`✗ ${assertion.name}`];

  if (assertion.status === "timed-out") {
    // Kept distinct from "failed": one says the check is wrong, the other says
    // it had not become true yet. They lead to different investigations.
    lines.push(`  ${assertion.message ?? `never became true after ${assertion.polls ?? 0} polls`}`);
  } else if (assertion.message !== undefined) {
    // Indent every line, so a multi-line assertion message stays inside its
    // own block rather than looking like more report output.
    for (const line of assertion.message.split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  return lines;
}

function describeDeliveries(report: RunReport): string {
  const count = report.attempts.length;
  if (count === 0) {
    return "no deliveries executed";
  }

  const counts = summariseStatuses(report);
  const keys = Object.keys(counts);
  const noun = count === 1 ? "delivery" : "deliveries";

  const firstKey = keys[0];
  if (keys.length === 1 && firstKey !== undefined && /^2\d\d$/.test(firstKey)) {
    return `${count} ${noun}, all ${firstKey} OK${unmetExpectation(report)}`;
  }

  // Numeric statuses ascending first, then transport outcomes by name, so the
  // ordering is stable across runs.
  const statuses = keys.filter((key) => /^\d+$/.test(key)).sort((a, b) => Number(a) - Number(b));
  const transports = keys.filter((key) => !/^\d+$/.test(key)).sort();

  const parts = [
    ...statuses.map((status) => `${counts[status]}×${status}`),
    ...transports.map((kind) => `${counts[kind]} ${kind}`),
  ];

  return `${count} ${noun}: ${parts.join(", ")}${unmetExpectation(report)}`;
}

/**
 * Names the delivery expectation when it is the reason a run failed.
 *
 * Without this, a run whose assertions all passed but whose deliveries did not
 * meet `all-2xx` prints as entirely healthy while reporting `passed: false`.
 */
function unmetExpectation(report: RunReport): string {
  if (report.passed || report.expectation.deliveries !== "all-2xx") {
    return "";
  }
  const allSucceeded = report.attempts.every(
    (attempt) =>
      attempt.outcome.kind === "response" &&
      attempt.outcome.status >= 200 &&
      attempt.outcome.status < 300,
  );
  return allSucceeded ? "" : " — expected all 2xx";
}

/**
 * A teardown problem, when there was one.
 *
 * Both forces `passed` to false and is otherwise invisible: every assertion can
 * be green. A teardown that overran matters even after a harness error, because
 * it is the reason the process may not exit, and a reader staring at a hung CI
 * job should find that here rather than guess.
 */
function describeCleanup(report: RunReport): string[] {
  // Defensive, like barriers: a display function given an older report.
  const cleanup = report.cleanup ?? { status: "skipped" };
  if (cleanup.status === "failed") {
    return [`  teardown failed: ${cleanup.message ?? "no reason given"}`];
  }
  if (cleanup.status === "timed-out") {
    return [`  teardown timed out: ${cleanup.message ?? "it did not finish in time"}`];
  }
  return [];
}

function describeProvenance(report: RunReport, options: FormatReportOptions): string {
  const chars = options.digestChars ?? DEFAULT_DIGEST_CHARS;
  // fixtureDigest is already "sha256:<hex>", so this is a slice, not a rehash.
  const [algorithm, hex = ""] = report.fixtureDigest.split(":");
  const digest = hex.length > chars ? `${algorithm}:${hex.slice(0, chars)}…` : report.fixtureDigest;

  return `seed ${report.seed} · planner ${report.plannerVersion} · fixtures ${digest}`;
}

/**
 * Throws when a run did not pass, with {@link formatReport}'s output as the
 * message.
 *
 * `runPlan` deliberately never throws — it funnels every failure into the
 * report so that a harness error can be rendered rather than replacing the
 * report with a stack trace. The cost is that `expect(report.passed).toBe(true)`
 * fails with "expected false to be true" and hides the reason. This restores
 * the ergonomics without changing that contract:
 *
 * ```ts
 * assertRunPassed(await runPlan(plan, options));
 * ```
 */
export function assertRunPassed(report: RunReport): void {
  if (report.passed) {
    return;
  }
  throw new Error(`EventLab scenario "${report.scenario}" did not pass:\n\n${formatReport(report)}`);
}
