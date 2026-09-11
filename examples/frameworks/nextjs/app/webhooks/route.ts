import { handleWebhook } from "../../../src/webhook";
import { currentLedger } from "../ledger";

/**
 * Next.js 16, App Router.
 *
 * Route handlers receive a web-standard `Request`, and nothing has read its
 * body yet: `arrayBuffer()` gives the bytes the provider signed. The trap is
 * `request.json()` - it is the idiomatic call, it consumes the body, and a
 * second read then throws, so a handler that parses first cannot go back for
 * the raw bytes at all.
 *
 * Node runtime, which is the default for route handlers: the signature check
 * uses `node:crypto`.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const result = handleWebhook(
    currentLedger(),
    raw,
    request.headers.get("x-signature") ?? undefined,
  );
  return Response.json(result.body, { status: result.status });
}
