import type { AttemptReport, RunReport } from "../types.js";

/**
 * Every attempt that delivered the given logical event, in observed order.
 *
 * Assertions frequently need this: "the handler saw evt_a three times" is a
 * statement about attempts, whereas "the order was fulfilled once" is a
 * statement about the application. Keeping the first one easy discourages
 * people from reaching into the raw report shape.
 */
export function deliveriesFor(report: RunReport, eventId: string): AttemptReport[] {
  return report.attempts.filter((attempt) => attempt.eventId === eventId);
}

/** How many attempts were executed for the given logical event. */
export function countDeliveries(report: RunReport, eventId: string): number {
  return deliveriesFor(report, eventId).length;
}

/**
 * Counts outcomes by response status, with transport failures kept as their
 * own buckets rather than folded into a status code they never had.
 */
export function summariseStatuses(report: RunReport): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const attempt of report.attempts) {
    const key =
      attempt.outcome.kind === "response" ? String(attempt.outcome.status) : attempt.outcome.kind;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
