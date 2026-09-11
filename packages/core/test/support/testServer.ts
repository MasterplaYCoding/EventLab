import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly receivedAt: number;
}

export interface TestServer {
  readonly baseUrl: string;
  readonly requests: RecordedRequest[];
  /** Highest number of requests being handled at the same moment. */
  readonly peakConcurrency: () => number;
  close: () => Promise<void>;
}

/**
 * Returns `unknown` because the value is ignored - only a promise is awaited.
 * `(_request, response) => response.end("ok")` returns the response, and the
 * tests are clearer written that way than wrapped in braces to discard it.
 */
export type Handler = (
  request: IncomingMessage & { body: string },
  response: ServerResponse,
) => unknown;

/**
 * A loopback HTTP server for executor tests.
 *
 * It records what it received and tracks peak in-flight requests, which is how
 * the concurrency-limit tests observe the scheduler from the outside rather
 * than by inspecting its internals.
 */
export async function startTestServer(handler: Handler): Promise<TestServer> {
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let peak = 0;

  const server: Server = createServer((request, response) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);

    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [key, String(value)]),
        ),
        body,
        receivedAt: performance.now(),
      });

      void Promise.resolve(handler(Object.assign(request, { body }), response))
        .catch(() => {
          if (!response.writableEnded) {
            response.statusCode = 500;
            response.end();
          }
        })
        .finally(() => {
          inFlight -= 1;
        });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    peakConcurrency: () => peak,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
