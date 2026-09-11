import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import next from "next";

import type { RunningApp } from "../src/running.js";
import type { Ledger } from "../src/webhook.js";
import { useLedger } from "./app/ledger.js";

/**
 * Serves the built Next app on an ephemeral loopback port.
 *
 * `next start` owns its own server and takes a fixed port, which is the
 * wrong shape for a test. Next's custom-server API is the right one: `next()`
 * gives a request handler, and a plain `node:http` server listens wherever
 * you tell it. Production mode, so the test exercises what `next build`
 * produced - the thing that gets deployed - and needs that build to exist
 * first; `npm run test:nextjs` at the repository root runs it.
 */
export async function startNext(ledger: Ledger): Promise<RunningApp> {
  useLedger(ledger);

  const app = next({ dev: false, dir: fileURLToPath(new URL(".", import.meta.url)), quiet: true });
  await app.prepare();
  const handle = app.getRequestHandler();

  const server = createServer((request, response) => void handle(request, response));
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      await app.close();
    },
  };
}
