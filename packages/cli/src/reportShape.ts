/**
 * Checks that a parsed JSON value is a report the timeline can render.
 *
 * A report on disk is untrusted: a CI job saved it, someone attached it to an
 * issue, or someone edited it by hand. The renderer reads it as a typed
 * RunReport and trusts every field, so before this check a non-string scenario
 * crashed with "Cannot read properties of undefined (reading 'replace')", and a
 * missing duration rendered "NaN%" into the page with exit code 0. Found by
 * test/reportSweep.test.ts, which tries every single-field change to a real
 * report.
 *
 * Only the fields the timeline reads are checked, and each problem names the
 * field as it appears in the file, so a refusal points at something the reader
 * can find. Internal to the CLI: library callers hand renderHtml a typed report.
 */

const OUTCOME_KINDS = ["response", "timeout", "transport-error", "cancelled"] as const;

type Problems = string[];

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNonNegativeNumber = (value: unknown): boolean =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function requireString(problems: Problems, record: Record<string, unknown>, key: string, at: string): void {
  if (typeof record[key] !== "string") problems.push(`${at}${key} must be a string`);
}

function optionalString(problems: Problems, record: Record<string, unknown>, key: string, at: string): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    problems.push(`${at}${key} must be a string when present`);
  }
}

function checkAttempt(problems: Problems, attempt: unknown, at: string): void {
  if (!isObject(attempt)) {
    problems.push(`${at} must be an object`);
    return;
  }
  requireString(problems, attempt, "attemptId", `${at}.`);
  requireString(problems, attempt, "eventId", `${at}.`);
  for (const key of ["intendedStartMs", "observedStartMs", "durationMs"]) {
    if (!isNonNegativeNumber(attempt[key])) problems.push(`${at}.${key} must be a non-negative number`);
  }

  const outcome = attempt.outcome;
  if (!isObject(outcome)) {
    problems.push(`${at}.outcome must be an object`);
    return;
  }
  const kind = outcome.kind;
  if (typeof kind !== "string" || !(OUTCOME_KINDS as readonly string[]).includes(kind)) {
    problems.push(`${at}.outcome.kind must be one of ${OUTCOME_KINDS.join(", ")}`);
    return;
  }
  if (kind === "response") {
    if (!Number.isInteger(outcome.status)) problems.push(`${at}.outcome.status must be an integer`);
    if (outcome.bodyTruncated !== undefined && typeof outcome.bodyTruncated !== "boolean") {
      problems.push(`${at}.outcome.bodyTruncated must be a boolean when present`);
    }
  } else if (kind === "timeout") {
    if (!isNonNegativeNumber(outcome.afterMs)) problems.push(`${at}.outcome.afterMs must be a non-negative number`);
  } else if (kind === "transport-error") {
    requireString(problems, outcome, "message", `${at}.outcome.`);
  }
}

/** Every problem that would stop the timeline rendering this value faithfully. */
export function reportProblems(value: unknown): Problems {
  const problems: Problems = [];
  if (!isObject(value)) return ["the report must be a JSON object"];

  requireString(problems, value, "scenario", "");
  requireString(problems, value, "plannerVersion", "");
  requireString(problems, value, "fixtureDigest", "");
  if (!Number.isInteger(value.seed)) problems.push("seed must be an integer");
  if (typeof value.passed !== "boolean") problems.push("passed must be a boolean");

  if (!Array.isArray(value.attempts)) {
    problems.push("attempts must be an array");
  } else {
    value.attempts.forEach((attempt, index) => checkAttempt(problems, attempt, `attempts[${index}]`));
  }

  if (!Array.isArray(value.assertions)) {
    problems.push("assertions must be an array");
  } else {
    value.assertions.forEach((assertion, index) => {
      const at = `assertions[${index}]`;
      if (!isObject(assertion)) return void problems.push(`${at} must be an object`);
      requireString(problems, assertion, "name", `${at}.`);
      requireString(problems, assertion, "status", `${at}.`);
      optionalString(problems, assertion, "message", `${at}.`);
    });
  }

  if (!Array.isArray(value.barriers)) {
    problems.push("barriers must be an array");
  } else {
    value.barriers.forEach((barrier, index) => {
      const at = `barriers[${index}]`;
      if (!isObject(barrier)) return void problems.push(`${at} must be an object`);
      requireString(problems, barrier, "name", `${at}.`);
      requireString(problems, barrier, "status", `${at}.`);
      if (!Number.isInteger(barrier.attemptsBefore) || (barrier.attemptsBefore as number) < 0) {
        problems.push(`${at}.attemptsBefore must be a non-negative integer`);
      }
    });
  }

  if (value.harnessError !== undefined) {
    if (!isObject(value.harnessError)) {
      problems.push("harnessError must be an object when present");
    } else {
      requireString(problems, value.harnessError, "code", "harnessError.");
      requireString(problems, value.harnessError, "message", "harnessError.");
      optionalString(problems, value.harnessError, "at", "harnessError.");
    }
  }

  if (!isObject(value.cleanup)) {
    problems.push("cleanup must be an object");
  } else {
    requireString(problems, value.cleanup, "status", "cleanup.");
    optionalString(problems, value.cleanup, "message", "cleanup.");
  }

  return problems;
}
