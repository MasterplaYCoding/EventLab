import { describe, expect, it } from "vitest";

import { createExpressApp, listenExpress } from "../src/express.js";
import { createFastifyApp } from "../src/fastify.js";
import { Ledger } from "../src/webhook.js";

/**
 * The raw body is the webhook's business and nobody else's.
 *
 * Both recipes say the rest of the application keeps its JSON parser. That is
 * what makes them safe to paste into an existing app, and it is the part of
 * the recipe a reader is least likely to check, so it is checked here: a
 * second route, added the way an application would add one, still receives
 * a parsed object.
 */
const order = JSON.stringify({ orderId: "ord_1" });

describe("the raw body stays scoped to the webhook route", () => {
  it("Express", async () => {
    const app = createExpressApp(new Ledger());
    app.post("/orders", (request, response) => {
      response.json({ parsed: !Buffer.isBuffer(request.body) && request.body?.orderId });
    });
    const running = await listenExpress(app);

    try {
      const response = await fetch(`${running.baseUrl}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: order,
      });
      expect(await response.json()).toEqual({ parsed: "ord_1" });
    } finally {
      await running.close();
    }
  });

  it("Fastify", async () => {
    const app = createFastifyApp(new Ledger());
    // Registered at the root, outside the webhook plugin, as an application's
    // other routes would be.
    app.post("/orders", async (request) => ({
      parsed: !Buffer.isBuffer(request.body) && (request.body as { orderId?: string }).orderId,
    }));
    const baseUrl = await app.listen({ port: 0, host: "127.0.0.1" });

    try {
      const response = await fetch(`${baseUrl}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: order,
      });
      expect(await response.json()).toEqual({ parsed: "ord_1" });
    } finally {
      await app.close();
    }
  });
});
