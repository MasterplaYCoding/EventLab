import { HarnessError } from "../errors.js";
import type { HttpTarget } from "../types.js";
import { describeCause } from "../internal/describeCause.js";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Resolves a target's base URL, checks it is usable, and by default requires
 * loopback.
 *
 * Called once per phase rather than once per run. A `baseUrl` function is what
 * makes an application that restarts mid-scenario testable - it comes back on a
 * new ephemeral port, and an address captured before the first delivery would
 * point at a socket nobody is listening on.
 *
 * The default matters: EventLab exists to hammer a target with duplicate and
 * concurrent traffic. Pointing that at a shared staging host by a typo in an
 * environment variable is the kind of accident worth making impossible without
 * an explicit opt-in.
 */
export async function resolveBaseUrl(
  target: HttpTarget,
  allowRemoteTargets: boolean,
): Promise<URL> {
  let raw: string;
  try {
    raw = typeof target.baseUrl === "function" ? await target.baseUrl() : target.baseUrl;
  } catch (cause) {
    // A restart hook that fails is a broken experiment, not a failing
    // application, so it is a harness error like any other bad target.
    throw new HarnessError(
      "InvalidTarget",
      `target.baseUrl threw while resolving: ${describeCause(cause)}`,
      "target.baseUrl",
    );
  }

  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new HarnessError(
      "InvalidTarget",
      `target.baseUrl must be an absolute URL, received "${raw}"`,
      "target.baseUrl",
    );
  }

  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new HarnessError(
      "InvalidTarget",
      `target.baseUrl must use http or https, received "${base.protocol}"`,
      "target.baseUrl",
    );
  }

  if (!allowRemoteTargets && !isLoopback(base.hostname)) {
    throw new HarnessError(
      "RemoteTargetBlocked",
      `refusing to deliver to non-loopback host "${base.hostname}". Set ` +
        `allowRemoteTargets: true if you really mean to run a duplication and ` +
        `concurrency scenario against a remote system.`,
      "target.baseUrl",
    );
  }

  return base;
}

function isLoopback(hostname: string): boolean {
  const normalised = hostname.toLowerCase();
  if (LOOPBACK_HOSTNAMES.has(normalised)) {
    return true;
  }
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalised);
}

/** Resolves a request path against the target base, preserving any base path. */
export function resolveRequestUrl(base: URL, path: string): URL {
  try {
    // A base of http://host/api and a path of "/hooks" should give
    // http://host/api/hooks, so the base path is not silently discarded.
    const prefix = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    const suffix = path.startsWith("/") ? path.slice(1) : path;
    return new URL(`${prefix}${suffix}${base.search}`, base);
  } catch {
    throw new HarnessError("InvalidTarget", `could not resolve request path "${path}"`, "request.path");
  }
}
