import type { DeliveryOutcome, HttpRequestSpec } from "../types.js";
import { describeCause } from "../internal/describeCause.js";

export interface DeliverOptions {
  readonly url: URL;
  readonly spec: HttpRequestSpec;
  readonly timeoutMs: number;
  readonly maxResponseBodyBytes: number;
  readonly signal: AbortSignal;
}

/**
 * Performs one delivery and classifies what happened.
 *
 * Deliberate behaviour:
 *
 * - No automatic retry, ever. Every duplicate a target sees must be visible in
 *   the plan, otherwise the report cannot explain why a handler ran twice.
 * - Redirects are not followed. A 3xx is an outcome the application chose and
 *   is reported as such.
 * - The response body is fully consumed (or explicitly discarded) before the
 *   attempt is considered finished, so a slow body cannot leak a socket into
 *   the next attempt's concurrency budget.
 * - A timeout is reported as a timeout. It is never upgraded into a claim that
 *   the server did not process the request: the request may well have been
 *   committed on the other side.
 */
export async function deliver(options: DeliverOptions): Promise<DeliveryOutcome> {
  const { url, spec, timeoutMs, maxResponseBodyBytes, signal } = options;
  const controller = new AbortController();
  const startedAt = performance.now();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onCancel = () => controller.abort();
  signal.addEventListener("abort", onCancel, { once: true });

  try {
    const response = await fetch(url, {
      method: spec.method,
      redirect: "manual",
      signal: controller.signal,
      ...(spec.headers === undefined ? {} : { headers: { ...spec.headers } }),
      // The body is passed through byte for byte: a signing hook computed a
      // signature over exactly these bytes, so re-encoding here would produce
      // a request the target rightly rejects.
      ...(spec.body === undefined ? {} : { body: spec.body }),
    });

    const { text, truncated } = await readBounded(response, maxResponseBodyBytes);
    return {
      kind: "response",
      status: response.status,
      bodyPreview: text,
      bodyTruncated: truncated,
    };
  } catch (cause) {
    if (timedOut) {
      return { kind: "timeout", afterMs: Math.round(performance.now() - startedAt) };
    }
    if (signal.aborted) {
      return { kind: "cancelled" };
    }
    return { kind: "transport-error", message: describeCause(cause) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCancel);
  }
}

/**
 * Reads at most `limit` bytes of a response body and drains the rest.
 *
 * Truncation is reported rather than hidden, because "the body was longer than
 * we captured" and "the body was exactly this" lead to different debugging.
 */
async function readBounded(
  response: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) {
    return { text: "", truncated: false };
  }

  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      // Anything arriving after the limit is already reached proves the body
      // was longer than the limit, and is the last thing worth learning from
      // it. Stop, rather than reading to the end of something whose remaining
      // bytes are going to be discarded.
      if (size >= limit) {
        truncated = true;
        break;
      }

      const remaining = limit - size;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        size = limit;
        truncated = true;
        break;
      }

      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    // cancel, not releaseLock: releasing leaves the body unread and the socket
    // waiting for someone to finish it. Cancelling tells the transport nobody
    // is coming, which is what keeps a response nobody wants from costing the
    // rest of the run. A body already fully read cancels harmlessly.
    //
    // Not awaited. Cancellation settles when the transport has finished tearing
    // the connection down, and against a target still writing at full speed
    // that can take as long as the thing being cancelled - which would make
    // the delivery wait for exactly the work it just decided to stop doing.
    void reader.cancel().catch(() => {});
  }

  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

