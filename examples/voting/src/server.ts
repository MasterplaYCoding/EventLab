import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { InterleavingGate } from "./interleaving.js";
import { Mutex, PollStore, type Poll } from "./pollStore.js";
import { VoteRejected, voteBroken, voteFixed, type VoteCommand } from "./handlers.js";

export type Mode = "broken" | "fixed";

export const demoPoll: Poll = {
  id: "poll_1",
  title: "Which release should ship first?",
  options: [
    { id: "opt_a", text: "EventLab", votes: 0 },
    { id: "opt_b", text: "DocumentKit", votes: 0 },
  ],
};

export interface VotingServer {
  readonly baseUrl: string;
  readonly store: PollStore;
  reset: () => void;
  close: () => Promise<void>;
}

export async function startVotingServer(mode: Mode): Promise<VotingServer> {
  const store = new PollStore();
  store.seed([demoPoll]);
  const mutex = new Mutex();

  // Two deliveries per voter, released together, must both reach the critical
  // section before either leaves it. Both handlers get the same gate.
  const gate = new InterleavingGate(2);
  const fixed = voteFixed(store, mutex, gate);

  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/votes") {
      response.statusCode = 404;
      response.end();
      return;
    }

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        try {
          const command = JSON.parse(Buffer.concat(chunks).toString("utf8")) as VoteCommand;
          if (mode === "broken") {
            await voteBroken(store, command, gate);
          } else {
            await fixed(command);
          }
          response.statusCode = 200;
          response.end(JSON.stringify({ ok: true }));
        } catch (cause) {
          response.statusCode = cause instanceof VoteRejected ? cause.status : 500;
          response.end(JSON.stringify({ error: (cause as Error).message }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    reset: () => {
      store.seed([demoPoll]);
      gate.reset();
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A server whose handlers face no gate, for scenarios about rejection paths. */
export async function startUngatedVotingServer(): Promise<VotingServer> {
  const store = new PollStore();
  store.seed([demoPoll]);
  const fixed = voteFixed(store, new Mutex());

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      void (async () => {
        try {
          await fixed(JSON.parse(Buffer.concat(chunks).toString("utf8")) as VoteCommand);
          response.statusCode = 200;
          response.end(JSON.stringify({ ok: true }));
        } catch (cause) {
          response.statusCode = cause instanceof VoteRejected ? cause.status : 500;
          response.end(JSON.stringify({ error: (cause as Error).message }));
        }
      })();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    reset: () => store.seed([demoPoll]),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
