import type { AddressInfo } from "node:net";

import express from "express";

import { handleWebhook, type Ledger } from "./webhook.js";
import type { RunningApp } from "./running.js";

/**
 * Express 5.
 *
 * The one thing to get right is the body. `express.json()` - usually mounted
 * app-wide - consumes the stream and leaves an object, and the signature is
 * over the bytes. Mount `express.raw()` on the webhook route instead, so
 * `request.body` is the `Buffer` the provider sent. Route-level middleware
 * runs in place of the app-wide one only if the app-wide one is not mounted
 * *before* this route, so register the webhook first.
 */
export function createExpressApp(ledger: Ledger): express.Express {
  const app = express();

  app.post("/webhooks", express.raw({ type: "application/json" }), (request, response) => {
    // `express.raw` leaves `{}` rather than a Buffer when the content type
    // does not match, so check before trusting it.
    const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const result = handleWebhook(ledger, raw, request.header("x-signature"));
    response.status(result.status).json(result.body);
  });

  // Anything else in the application can keep its JSON parser.
  app.use(express.json());

  return app;
}

/**
 * Listens on an ephemeral loopback port.
 *
 * `127.0.0.1` rather than the default, which is every interface: a test has
 * no business being reachable from the network. And `listen` reports failure
 * through the `error` event, not the callback, so both are wired.
 */
export async function listenExpress(app: express.Express): Promise<RunningApp> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    // Node 19+ closes idle keep-alive sockets on close(), so this returns as
    // soon as nothing is mid-request. On older Node it would wait for the
    // client's keep-alive to expire - the classic "tests pass, then hang".
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}

export const startExpress = (ledger: Ledger): Promise<RunningApp> =>
  listenExpress(createExpressApp(ledger));
