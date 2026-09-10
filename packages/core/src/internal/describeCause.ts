/**
 * The human-readable message from something that was thrown.
 *
 * There were three copies of this: one in the assertion runner, one in
 * `runPlan`, and a richer one in the HTTP client that also unwrapped a nested
 * `cause`. Three copies of one idea is how they drift, and two of them were
 * already worse than the third.
 *
 * Realm-safe on purpose. `cause instanceof Error` compares against *this*
 * realm's `Error`, so anything thrown from a `node:vm` context or a worker
 * fell through to `String(cause)` and printed as `"Error: expected 2, found
 * 3"` — the class name glued to the front of the message a user wrote. The
 * values reaching here are assertion failures and request-builder failures,
 * which is to say user code, which is exactly the code most likely to be
 * running somewhere other than this realm.
 */
export function describeCause(cause: unknown): string {
  if (Object.prototype.toString.call(cause) !== "[object Error]") {
    return String(cause);
  }

  const error = cause as { message?: unknown; cause?: unknown };
  const message = typeof error.message === "string" ? error.message : String(cause);

  // A wrapped cause usually carries the specific detail — `fetch failed` is
  // useless without the `ECONNREFUSED` underneath it.
  const nested = error.cause;
  if (Object.prototype.toString.call(nested) === "[object Error]") {
    const nestedMessage = (nested as { message?: unknown }).message;
    if (typeof nestedMessage === "string" && nestedMessage !== message) {
      return `${message}: ${nestedMessage}`;
    }
  }

  return message;
}
