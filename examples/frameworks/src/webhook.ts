import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The webhook itself, with no framework in it.
 *
 * Every recipe in this directory is a thin adapter around {@link handleWebhook}:
 * get the request's **raw bytes** and its signature header to this function,
 * send back what it returns. That split is the point of the recipes. The
 * business logic is the same everywhere; what differs between Express,
 * Fastify and Nest is only how you reach the unparsed body, how you listen on
 * an ephemeral port, and how you shut down.
 */

/** A recipe-only secret. Real ones come from the provider's dashboard. */
export const WEBHOOK_SECRET = "whsec_recipe_only_not_a_real_secret";

/**
 * The provider's scheme: an HMAC-SHA256 of the exact bytes it sent.
 *
 * "Exact bytes" is the part frameworks get in the way of. A JSON body parser
 * hands the route an object, and re-serialising that object does not give the
 * bytes back - the provider may pretty-print, order keys differently, or
 * escape characters that `JSON.stringify` would not. A signature checked
 * against a re-serialised body fails for some providers and passes for others,
 * which is worse than failing for all of them.
 */
export function sign(rawBody: string | Uint8Array): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("hex")}`;
}

function signatureMatches(rawBody: Uint8Array, header: string | undefined): boolean {
  if (header === undefined) return false;
  const expected = Buffer.from(sign(rawBody));
  const actual = Buffer.from(header);
  // timingSafeEqual throws on a length mismatch rather than returning false.
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface PaymentEvent {
  readonly eventId: string;
  readonly orderId: string;
}

/**
 * Remembers which events were handled and what they did.
 *
 * In memory, which is fine for a recipe: `accept` checks and records in one
 * synchronous step, so concurrent deliveries within one process cannot both
 * get past it. A real application keeps this in its database, and
 * `examples/duplicate-handler` shows what goes wrong when the check and the
 * write are separate statements.
 */
export class Ledger {
  private readonly seen = new Set<string>();
  private readonly fulfilments = new Map<string, number>();

  accept(event: PaymentEvent): "fulfilled" | "duplicate" {
    if (this.seen.has(event.eventId)) return "duplicate";
    this.seen.add(event.eventId);
    this.fulfilments.set(event.orderId, (this.fulfilments.get(event.orderId) ?? 0) + 1);
    return "fulfilled";
  }

  fulfilmentsOf(orderId: string): number {
    return this.fulfilments.get(orderId) ?? 0;
  }

  get handled(): number {
    return this.seen.size;
  }
}

export interface WebhookResponse {
  readonly status: number;
  readonly body: { readonly result: string };
}

/**
 * Verify, then parse, then deduplicate - in that order.
 *
 * Parsing before verifying would mean running a JSON parser over bytes from
 * anyone who can reach the endpoint.
 */
export function handleWebhook(
  ledger: Ledger,
  rawBody: Uint8Array,
  signature: string | undefined,
): WebhookResponse {
  if (!signatureMatches(rawBody, signature)) {
    return { status: 401, body: { result: "bad signature" } };
  }

  let event: PaymentEvent;
  try {
    event = JSON.parse(Buffer.from(rawBody).toString("utf8")) as PaymentEvent;
  } catch {
    return { status: 400, body: { result: "not json" } };
  }
  if (typeof event?.eventId !== "string" || typeof event.orderId !== "string") {
    return { status: 400, body: { result: "not a payment event" } };
  }

  // A duplicate is acknowledged with a 2xx. Rejecting it would make the
  // provider retry something that already succeeded - forever, for some.
  return { status: 200, body: { result: ledger.accept(event) } };
}
