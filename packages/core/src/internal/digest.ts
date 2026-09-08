import { createHash } from "node:crypto";

import type { EventFixture } from "../types.js";

/**
 * Serialises a value with object keys sorted, so that two structurally equal
 * fixtures produce the same digest regardless of literal key order.
 *
 * This is not a general-purpose canonical JSON implementation: it covers the
 * JSON data model only, which is all a fixture body is allowed to contain.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

/**
 * SHA-256 over the canonical form of a fixture set.
 *
 * Reports store this digest instead of the payloads themselves. Replay reads
 * the bodies from the user's own fixture module and refuses to run when the
 * digest no longer matches, which turns "the fixtures drifted" into an
 * explicit failure rather than a mysteriously different result.
 */
export function fixtureDigest(events: readonly EventFixture[]): string {
  const canonical = canonicalJson(
    events.map((event) => ({ id: event.id, body: event.body })),
  );
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}
