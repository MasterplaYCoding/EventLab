/**
 * A synthetic event with a stable logical identity.
 *
 * The `id` is the *logical* event id: every duplicate delivery of this event
 * keeps the same `id` and receives its own attempt id. Applications under test
 * are expected to deduplicate on something derived from the body, exactly as
 * they would for a real provider that documents at-least-once delivery.
 */
export interface EventFixture {
  /** Unique within a scenario. Non-empty, at most 200 characters. */
  readonly id: string;
  /** JSON-serialisable synthetic payload. EventLab never invents contents. */
  readonly body: unknown;
}

/** One planned HTTP delivery of one logical event. */
export interface DeliveryAttempt {
  /** Stable, unique within a plan. Format: `<eventId>#<copyIndex>`. */
  readonly attemptId: string;
  /** The logical event this attempt delivers. Shared by duplicates. */
  readonly eventId: string;
  /** 0 for the first planned copy, 1 for the second, and so on. */
  readonly copyIndex: number;
  /** Position in the plan. Used as the deterministic tie-break at run time. */
  readonly order: number;
  /** Intended offset from the start of the run, in milliseconds. */
  readonly delayMs: number;
}

/** A record of one transform, retained so a plan explains how it was built. */
export interface TransformRecord {
  readonly kind: string;
  readonly options: Readonly<Record<string, number | string | boolean>>;
}

/**
 * A serialisable, replayable set of delivery instructions.
 *
 * A plan is authoritative: replay executes the stored attempts rather than
 * re-running the planner, so a newer planner version can never quietly change
 * a reproduction case.
 */
export interface DeliveryPlan {
  readonly plannerVersion: string;
  readonly scenario: string;
  readonly seed: number;
  /** SHA-256 over the canonical form of the fixtures used to build the plan. */
  readonly fixtureDigest: string;
  readonly concurrency: number;
  readonly transforms: readonly TransformRecord[];
  readonly attempts: readonly DeliveryAttempt[];
}

/** The request EventLab should send for one attempt. */
export interface HttpRequestSpec {
  readonly method: string;
  /** Resolved against the target's `baseUrl`. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Exact bytes to send. Signing hooks see this value, unmodified. */
  readonly body?: string | Uint8Array;
}

/** Context handed to {@link HttpTarget.request} when constructing a request. */
export interface RequestContext {
  readonly event: EventFixture;
  readonly attempt: DeliveryAttempt;
}

/**
 * Where deliveries go. Requests are constructed at execution time so that
 * authentication headers and signatures are computed fresh per attempt.
 */
export interface HttpTarget {
  /** Absolute base URL. Loopback only, unless `allowRemoteTargets` is set. */
  readonly baseUrl: string;
  readonly request: (context: RequestContext) => HttpRequestSpec | Promise<HttpRequestSpec>;
  /** Per-request timeout override, in milliseconds. */
  readonly timeoutMs?: number;
}

/** Lifecycle callbacks into the application under test. */
export interface ScenarioHooks {
  /** Runs once before any delivery. Failure aborts the run as a harness error. */
  readonly setup?: () => void | Promise<void>;
  /** Runs after setup and before deliveries, to clear prior state. */
  readonly reset?: () => void | Promise<void>;
  /** Always runs, including after failure and cancellation. */
  readonly teardown?: () => void | Promise<void>;
}

/** What the runner observed for one attempt. */
export type DeliveryOutcome =
  | {
      readonly kind: "response";
      readonly status: number;
      readonly bodyPreview: string;
      readonly bodyTruncated: boolean;
    }
  | { readonly kind: "timeout"; readonly afterMs: number }
  | { readonly kind: "transport-error"; readonly message: string }
  | { readonly kind: "cancelled" };

/** One executed attempt, with intended and observed timing kept separate. */
export interface AttemptReport {
  readonly attemptId: string;
  readonly eventId: string;
  readonly copyIndex: number;
  readonly order: number;
  readonly intendedStartMs: number;
  readonly observedStartMs: number;
  readonly durationMs: number;
  readonly request: {
    readonly method: string;
    readonly url: string;
    readonly headerNames: readonly string[];
    readonly bodyBytes: number;
  };
  readonly outcome: DeliveryOutcome;
}

/** Context passed to user assertions. */
export interface AssertionContext {
  readonly plan: DeliveryPlan;
  readonly attempts: readonly AttemptReport[];
}

/** A single check run once, after all deliveries complete. */
export interface CheckAssertion {
  readonly name: string;
  readonly check: (context: AssertionContext) => void | Promise<void>;
}

/**
 * A check polled until it stops throwing or the deadline passes. Use this for
 * state that a background worker produces, never as a substitute for a
 * synchronisation point the application can actually signal.
 */
export interface EventuallyAssertion {
  readonly name: string;
  readonly eventually: (context: AssertionContext) => void | Promise<void>;
  /** Defaults to 2000. */
  readonly timeoutMs?: number;
  /** Defaults to 50. */
  readonly intervalMs?: number;
}

export type Assertion = CheckAssertion | EventuallyAssertion;

/** Outcome of one user assertion, kept distinct from delivery outcomes. */
export interface AssertionReport {
  readonly name: string;
  readonly kind: "check" | "eventually";
  readonly status: "passed" | "failed" | "timed-out";
  readonly durationMs: number;
  readonly message?: string;
  readonly polls?: number;
}

/** What the run expected of delivery outcomes themselves. */
export interface DeliveryExpectation {
  /**
   * `all-2xx` (the default when no expectation is declared) fails the run if
   * any attempt did not receive a 2xx response. `declared` accepts whatever
   * happened at the transport level and leaves judgement to the assertions.
   */
  readonly deliveries: "all-2xx" | "declared";
}

/** Effective, recorded limits for a run. */
export interface RunLimits {
  /** Per-request timeout. Default 5000. */
  readonly requestTimeoutMs: number;
  /** Whole-scenario timeout, measured from the first delivery. Default 30000. */
  readonly scenarioTimeoutMs: number;
  /** Maximum captured response body bytes. Default 65536. */
  readonly maxResponseBodyBytes: number;
}

/** Options for {@link runPlan}. */
export interface RunOptions {
  readonly target: HttpTarget;
  readonly events: readonly EventFixture[];
  readonly hooks?: ScenarioHooks;
  readonly assertions?: readonly Assertion[];
  readonly expect?: DeliveryExpectation;
  readonly limits?: Partial<RunLimits>;
  /** Opt in to non-loopback base URLs. Off by default. */
  readonly allowRemoteTargets?: boolean;
  /** Cancels the run; teardown still runs. */
  readonly signal?: AbortSignal;
}

/** The result of executing a plan. */
export interface RunReport {
  readonly reportSchemaVersion: string;
  readonly plannerVersion: string;
  readonly scenario: string;
  readonly seed: number;
  readonly fixtureDigest: string;
  readonly plan: DeliveryPlan;
  readonly limits: RunLimits;
  readonly startedAt: string;
  readonly wallClockMs: number;
  readonly attempts: readonly AttemptReport[];
  readonly assertions: readonly AssertionReport[];
  readonly expectation: DeliveryExpectation;
  /** True only when the declared expectation and every assertion passed. */
  readonly passed: boolean;
  readonly harnessError?: {
    readonly code: string;
    readonly message: string;
    readonly at?: string;
  };
  readonly cleanup: { readonly status: "ok" | "failed" | "skipped"; readonly message?: string };
  /** Bodies are never embedded; replay reads them from the fixture module. */
  readonly redaction: {
    readonly requestBodies: "omitted";
    readonly requestHeaders: "names-only";
  };
  readonly reproduce: { readonly note: string };
}
