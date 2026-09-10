import { HarnessError, isHarnessError } from "../errors.js";
import { describeCause } from "../internal/describeCause.js";
import { assertFixturesMatch } from "../plan/savedPlan.js";
import { PLANNER_VERSION, REPORT_SCHEMA_VERSION } from "../version.js";
import type {
  AttemptReport,
  BarrierReport,
  DeliveryAttempt,
  DeliveryPlan,
  EventFixture,
  RunLimits,
  RunOptions,
  RunReport,
} from "../types.js";
import { runAssertions } from "./assertions.js";
import { deliver } from "./httpClient.js";
import { schedule } from "./scheduler.js";
import { resolveBaseUrl, resolveRequestUrl } from "./target.js";

const DEFAULT_LIMITS: RunLimits = {
  requestTimeoutMs: 5_000,
  scenarioTimeoutMs: 30_000,
  maxResponseBodyBytes: 64 * 1024,
};

/**
 * Executes a plan against an HTTP target and reports what happened.
 *
 * The shape of the run is fixed and boring on purpose:
 *
 *   setup -> reset -> scheduled deliveries -> assertions -> teardown
 *
 * teardown runs on every path, including cancellation, scenario timeout and
 * harness errors, and its own failure is reported as a cleanup failure rather
 * than replacing whatever went wrong first.
 */
export async function runPlan(plan: DeliveryPlan, options: RunOptions): Promise<RunReport> {
  const limits: RunLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const expectation = options.expect ?? { deliveries: "all-2xx" as const };
  const startedAtIso = new Date().toISOString();
  const startedAt = performance.now();

  const attempts: AttemptReport[] = [];
  const barrierReports: BarrierReport[] = [];
  let assertionReports: RunReport["assertions"] = [];
  let harnessError: RunReport["harnessError"];
  let cleanup: RunReport["cleanup"] = { status: "skipped" };
  let setupCompleted = false;

  const controller = new AbortController();
  const abort = () => controller.abort();
  // A signal that aborted before it was handed over never fires its event
  // again, so subscribing alone would silently run the whole scenario for a
  // caller who had already cancelled.
  if (options.signal?.aborted === true) {
    controller.abort();
  }
  options.signal?.addEventListener("abort", abort, { once: true });
  const scenarioTimer = setTimeout(() => controller.abort(), limits.scenarioTimeoutMs);

  try {
    if (plan.plannerVersion !== PLANNER_VERSION) {
      throw new HarnessError(
        "InvalidPlan",
        `plan was produced by planner version ${plan.plannerVersion}, this build ` +
          `understands ${PLANNER_VERSION}`,
        "plan.plannerVersion",
      );
    }

    const events = indexEvents(options.events);
    assertFixturesMatch(plan, options.events);
    assertCheckpointsExist(plan, options.hooks);
    const base = resolveBaseUrl(options.target, options.allowRemoteTargets ?? false);

    try {
      await options.hooks?.setup?.();
      setupCompleted = true;
      await options.hooks?.reset?.();
    } catch (cause) {
      throw new HarnessError(
        "SetupFailed",
        `scenario hooks failed before delivery: ${describeCause(cause)}`,
        "hooks",
      );
    }

    const executeAttempt = async (
      attempt: DeliveryAttempt,
      observedStartMs: number,
    ): Promise<void> => {
      const event = events.get(attempt.eventId);
      if (event === undefined) {
        // Guarded by assertFixturesMatch; kept as a loud failure rather than
        // a silently skipped delivery, which would corrupt the report.
        throw new HarnessError(
          "MissingFixture",
          `no fixture for event "${attempt.eventId}"`,
          "events",
        );
      }

      const spec = await options.target.request({ event, attempt });
      const url = resolveRequestUrl(base, spec.path);
      const requestStartedAt = performance.now();

      const outcome = await deliver({
        url,
        spec,
        timeoutMs: options.target.timeoutMs ?? limits.requestTimeoutMs,
        maxResponseBodyBytes: limits.maxResponseBodyBytes,
        signal: controller.signal,
      });

      attempts.push({
        attemptId: attempt.attemptId,
        eventId: attempt.eventId,
        copyIndex: attempt.copyIndex,
        order: attempt.order,
        intendedStartMs: attempt.delayMs,
        observedStartMs: Math.round(observedStartMs),
        durationMs: Math.round(performance.now() - requestStartedAt),
        request: {
          method: spec.method,
          url: url.toString(),
          // Header *names* only. Signatures and authorization values must
          // never end up in an artifact someone attaches to an issue.
          headerNames: Object.keys(spec.headers ?? {}).sort(),
          bodyBytes: byteLength(spec.body),
        },
        outcome,
      });
    };

    // One scheduling pass per phase, with barriers in between. A plan with no
    // barriers has exactly one phase, so this is the original behaviour.
    const phases = groupByPhase(plan.attempts);

    for (const [phase, phaseAttempts] of phases) {
      if (controller.signal.aborted) {
        break;
      }

      await schedule({
        attempts: phaseAttempts,
        concurrency: plan.concurrency,
        // Offsets are phase-relative: a barrier resets the clock, because what
        // follows one did not start until what preceded it had finished.
        startedAt: performance.now(),
        runStartedAt: startedAt,
        signal: controller.signal,
        execute: executeAttempt,
      });

      const barrier = plan.barriers.find((candidate) => candidate.afterPhase === phase);
      if (barrier === undefined) {
        continue;
      }
      if (controller.signal.aborted) {
        break;
      }

      // Every attempt in the phase has settled by now - schedule() awaits them
      // all - so the checkpoint observes a quiet system, which is the entire
      // point of a barrier.
      const barrierStartedAt = performance.now();
      const attemptsBefore = attempts.length;

      try {
        if (barrier.checkpoint !== undefined) {
          await options.hooks?.checkpoints?.[barrier.checkpoint]?.();
        }
        barrierReports.push({
          name: barrier.name,
          afterPhase: barrier.afterPhase,
          ...(barrier.checkpoint === undefined ? {} : { checkpoint: barrier.checkpoint }),
          status: "passed",
          attemptsBefore,
          durationMs: Math.round(performance.now() - barrierStartedAt),
        });
      } catch (cause) {
        // A checkpoint that throws is the application saying it never reached
        // the state the rest of the scenario assumes, so continuing would test
        // something nobody described.
        barrierReports.push({
          name: barrier.name,
          afterPhase: barrier.afterPhase,
          ...(barrier.checkpoint === undefined ? {} : { checkpoint: barrier.checkpoint }),
          status: "failed",
          attemptsBefore,
          durationMs: Math.round(performance.now() - barrierStartedAt),
          message: describeCause(cause),
        });
        break;
      }
    }

    // Barriers the run never got to are reported as skipped rather than
    // omitted, so a truncated run is visibly truncated.
    for (const barrier of plan.barriers) {
      if (!barrierReports.some((report) => report.name === barrier.name)) {
        barrierReports.push({
          name: barrier.name,
          afterPhase: barrier.afterPhase,
          ...(barrier.checkpoint === undefined ? {} : { checkpoint: barrier.checkpoint }),
          status: "skipped",
          attemptsBefore: attempts.length,
          durationMs: 0,
        });
      }
    }

    if (controller.signal.aborted && options.signal?.aborted !== true) {
      throw new HarnessError(
        "ScenarioTimeout",
        `scenario exceeded its ${limits.scenarioTimeoutMs}ms budget`,
        "limits.scenarioTimeoutMs",
      );
    }
    if (controller.signal.aborted) {
      throw new HarnessError("Cancelled", "run was cancelled by the caller");
    }

    attempts.sort((a, b) => a.observedStartMs - b.observedStartMs || a.order - b.order);
    assertionReports = await runAssertions(options.assertions ?? [], { plan, attempts });
  } catch (cause) {
    harnessError = isHarnessError(cause)
      ? { code: cause.code, message: cause.message, ...(cause.at === undefined ? {} : { at: cause.at }) }
      : { code: "Unknown", message: describeCause(cause) };
  } finally {
    clearTimeout(scenarioTimer);
    options.signal?.removeEventListener("abort", abort);
    cleanup = await runTeardown(options, setupCompleted);
  }

  return {
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    plannerVersion: plan.plannerVersion,
    scenario: plan.scenario,
    seed: plan.seed,
    fixtureDigest: plan.fixtureDigest,
    plan,
    limits,
    startedAt: startedAtIso,
    wallClockMs: Math.round(performance.now() - startedAt),
    attempts,
    assertions: assertionReports,
    barriers: barrierReports,
    expectation,
    passed:
      harnessError === undefined &&
      cleanup.status !== "failed" &&
      meetsDeliveryExpectation(attempts, expectation.deliveries) &&
      barrierReports.every((report) => report.status === "passed") &&
      assertionReports.every((report) => report.status === "passed"),
    ...(harnessError === undefined ? {} : { harnessError }),
    cleanup,
    redaction: { requestBodies: "omitted", requestHeaders: "names-only" },
    reproduce: {
      note:
        `Rebuild with seed ${plan.seed} and planner version ${plan.plannerVersion}, or replay ` +
        `the embedded plan against fixtures with digest ${plan.fixtureDigest}.`,
    },
  };
}

/**
 * With no declared expectation, a scenario passes only if every delivery got a
 * 2xx. Tests that mean to provoke a rejection must say so via
 * `expect: { deliveries: "declared" }`, so a run cannot pass by accident
 * because the server refused everything.
 */
function meetsDeliveryExpectation(
  attempts: readonly AttemptReport[],
  mode: "all-2xx" | "declared",
): boolean {
  if (mode === "declared") {
    return true;
  }
  return attempts.every(
    (attempt) =>
      attempt.outcome.kind === "response" &&
      attempt.outcome.status >= 200 &&
      attempt.outcome.status < 300,
  );
}

async function runTeardown(
  options: RunOptions,
  setupCompleted: boolean,
): Promise<RunReport["cleanup"]> {
  if (options.hooks?.teardown === undefined) {
    return { status: "skipped" };
  }
  if (!setupCompleted && options.hooks.setup !== undefined) {
    // setup() never finished, so there is nothing it owns to tear down.
    return { status: "skipped", message: "setup did not complete" };
  }

  try {
    await options.hooks.teardown();
    return { status: "ok" };
  } catch (cause) {
    return { status: "failed", message: describeCause(cause) };
  }
}

function indexEvents(events: readonly EventFixture[]): Map<string, EventFixture> {
  return new Map(events.map((event) => [event.id, event]));
}

/**
 * Splits a plan's attempts into phases, in ascending phase order.
 *
 * Attempts are already grouped by phase in plan order, but grouping explicitly
 * means a hand-edited or older saved plan cannot interleave phases by accident.
 */
function groupByPhase(
  attempts: readonly DeliveryAttempt[],
): Map<number, DeliveryAttempt[]> {
  const phases = new Map<number, DeliveryAttempt[]>();
  for (const attempt of attempts) {
    const phase = attempt.phase ?? 0;
    const existing = phases.get(phase);
    if (existing === undefined) {
      phases.set(phase, [attempt]);
    } else {
      existing.push(attempt);
    }
  }
  return new Map([...phases.entries()].sort(([a], [b]) => a - b));
}

/**
 * Rejects a barrier whose checkpoint the caller did not supply.
 *
 * Checked before setup rather than when the barrier is reached: discovering a
 * typo in a hook name after thirty seconds of deliveries, with the application
 * already in a modified state, is a much worse experience than failing
 * immediately.
 */
function assertCheckpointsExist(plan: DeliveryPlan, hooks: RunOptions["hooks"]): void {
  for (const barrier of plan.barriers) {
    if (barrier.checkpoint === undefined) {
      continue;
    }
    if (typeof hooks?.checkpoints?.[barrier.checkpoint] !== "function") {
      const available = Object.keys(hooks?.checkpoints ?? {});
      throw new HarnessError(
        "InvalidScenario",
        `barrier "${barrier.name}" waits for checkpoint "${barrier.checkpoint}", which is ` +
          `not defined in hooks.checkpoints` +
          (available.length === 0 ? "" : ` (available: ${available.join(", ")})`),
        "hooks.checkpoints",
      );
    }
  }
}

function byteLength(body: string | Uint8Array | undefined): number {
  if (body === undefined) {
    return 0;
  }
  return typeof body === "string" ? Buffer.byteLength(body, "utf8") : body.byteLength;
}

