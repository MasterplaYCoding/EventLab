import Fastify, { type FastifyInstance } from "fastify";

import { handleWebhook, type Ledger } from "./webhook.js";
import type { RunningApp } from "./running.js";

/**
 * Fastify 5.
 *
 * Fastify parses JSON itself, so the raw body has to be asked for. Replacing
 * the `application/json` parser with one that returns the `Buffer` untouched
 * does that - and doing it inside a plugin keeps the replacement scoped to the
 * webhook routes. Fastify's encapsulation means the rest of the application
 * keeps its normal JSON parsing; registered at the root instead, every route
 * would receive Buffers.
 */
export function createFastifyApp(ledger: Ledger): FastifyInstance {
  const app = Fastify({ logger: false });

  void app.register(async (webhooks) => {
    webhooks.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );

    webhooks.post("/webhooks", async (request, reply) => {
      const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      const signature = request.headers["x-signature"];
      const result = handleWebhook(
        ledger,
        raw,
        typeof signature === "string" ? signature : undefined,
      );
      return reply.code(result.status).send(result.body);
    });
  });

  return app;
}

/**
 * Listens on an ephemeral loopback port.
 *
 * Pass the host explicitly. Fastify's default is `localhost`, which it binds
 * on every address the name resolves to; that works, but it makes the address
 * the test should use a question about the machine's resolver. `listen`
 * resolves to the address it bound, so there is no `address()` to parse.
 */
export async function startFastify(ledger: Ledger): Promise<RunningApp> {
  const app = createFastifyApp(ledger);
  const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  return {
    baseUrl,
    close: () => app.close(),
  };
}
