import type { AttemptReport, RunReport } from "@masterplaycoding/eventlab";

/**
 * Renders a report as a standalone HTML timeline.
 *
 * Constraints, all deliberate:
 *
 * - **No server, no network, no analytics.** One file you can open, email, or
 *   attach to an issue.
 * - **No response bodies.** The report already keeps request bodies out; this
 *   also declines to render the response previews it *does* hold, because a
 *   timeline is skimmed rather than read and a token echoed by a target should
 *   not be sitting in a file people forward.
 * - **Everything escaped.** Attempt ids, URLs, assertion messages and error
 *   text all come from outside this process. None of it is trusted markup.
 * - **Status conveyed by text as well as colour**, so the document is usable
 *   without seeing the colours.
 */
export function renderHtml(report: RunReport): string {
  const total = Math.max(
    1,
    ...report.attempts.map((attempt) => attempt.observedStartMs + attempt.durationMs),
  );

  const byEvent = new Map<string, AttemptReport[]>();
  for (const attempt of report.attempts) {
    const existing = byEvent.get(attempt.eventId);
    if (existing === undefined) byEvent.set(attempt.eventId, [attempt]);
    else existing.push(attempt);
  }

  const verdict = report.passed ? "passed" : "failed";

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EventLab — ${escape(report.scenario)}</title>
<style>
  :root { color-scheme: light dark; --line: #8883; --ok: #1a7f37; --bad: #cf222e; --warn: #9a6700; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 0; padding: 2rem; }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  .meta { color: #7a7a7a; margin-bottom: 1.5rem; }
  .verdict { font-weight: 600; }
  .verdict.passed { color: var(--ok); }
  .verdict.failed { color: var(--bad); }
  section { margin: 1.5rem 0; }
  h2 { font-size: 1rem; margin: 0 0 .5rem; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { padding: .2rem 0; }
  .msg { color: #7a7a7a; padding-left: 1.4rem; }
  .event { margin: .75rem 0; }
  .event-id { font: 12px ui-monospace, monospace; color: #7a7a7a; }
  .track { position: relative; height: 1.4rem; border-left: 1px solid var(--line);
           border-bottom: 1px solid var(--line); }
  .bar { position: absolute; top: .3rem; height: .8rem; min-width: 3px; border-radius: 2px;
         background: var(--ok); }
  .bar.bad { background: var(--bad); }
  .bar.warn { background: var(--warn); }
  .scale { display: flex; justify-content: space-between; font: 11px ui-monospace, monospace;
           color: #7a7a7a; }
  table { border-collapse: collapse; width: 100%; font: 12px ui-monospace, monospace; }
  th, td { text-align: left; padding: .25rem .5rem; border-bottom: 1px solid var(--line); }
  .note { color: #7a7a7a; font-size: 12px; margin-top: 2rem; }
</style>
<main>
  <h1>${escape(report.scenario)}</h1>
  <p class="meta">
    <span class="verdict ${verdict}">${verdict}</span> ·
    seed ${report.seed} · planner ${escape(report.plannerVersion)} ·
    fixtures ${escape(report.fixtureDigest)} · ${report.attempts.length} deliveries
  </p>

  ${section("Assertions", report.assertions.length === 0
    ? `<p class="msg">none declared</p>`
    : `<ul>${report.assertions
        .map(
          (assertion) =>
            `<li>${mark(assertion.status === "passed")} ${escape(assertion.name)}` +
            ` <span class="event-id">(${escape(assertion.status)})</span>` +
            (assertion.message === undefined
              ? ""
              : `<div class="msg">${escape(assertion.message)}</div>`) +
            `</li>`,
        )
        .join("")}</ul>`)}

  ${report.barriers.length === 0 ? "" : section("Barriers", `<ul>${report.barriers
    .map(
      (barrier) =>
        `<li>${mark(barrier.status === "passed")} ${escape(barrier.name)}` +
        ` <span class="event-id">after ${barrier.attemptsBefore} deliveries, ` +
        `${escape(barrier.status)}</span></li>`,
    )
    .join("")}</ul>`)}

  ${section(
    "Timeline",
    `<div class="scale"><span>0 ms</span><span>${total} ms</span></div>` +
      [...byEvent.entries()]
        .map(
          ([eventId, attempts]) =>
            `<div class="event"><div class="event-id">${escape(eventId)} — ` +
            `${attempts.length} ${attempts.length === 1 ? "delivery" : "deliveries"}</div>` +
            `<div class="track">${attempts.map((attempt) => bar(attempt, total)).join("")}</div>` +
            `</div>`,
        )
        .join(""),
  )}

  ${section(
    "Attempts",
    `<table><thead><tr><th>attempt</th><th>intended</th><th>observed</th>` +
      `<th>duration</th><th>outcome</th></tr></thead><tbody>` +
      report.attempts
        .map(
          (attempt) =>
            `<tr><td>${escape(attempt.attemptId)}</td>` +
            `<td>${attempt.intendedStartMs} ms</td>` +
            `<td>${attempt.observedStartMs} ms</td>` +
            `<td>${attempt.durationMs} ms</td>` +
            `<td>${escape(describe(attempt))}</td></tr>`,
        )
        .join("") +
      `</tbody></table>`,
  )}

  <p class="note">
    Intended and observed start times are shown separately: the plan is
    deterministic, the run is not. Response bodies are deliberately omitted.
  </p>
</main>
</html>
`;
}

function section(title: string, body: string): string {
  return `<section><h2>${escape(title)}</h2>${body}</section>`;
}

function mark(ok: boolean): string {
  // Text, not only colour.
  return ok ? "✓" : "✗";
}

function bar(attempt: AttemptReport, total: number): string {
  const left = (attempt.observedStartMs / total) * 100;
  const width = Math.max((attempt.durationMs / total) * 100, 0.5);
  const kind = attempt.outcome.kind;
  const failed =
    kind === "transport-error" ||
    (kind === "response" && (attempt.outcome.status < 200 || attempt.outcome.status >= 300));

  const className = kind === "timeout" ? "bar warn" : failed ? "bar bad" : "bar";
  return (
    `<div class="${className}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" ` +
    `title="${escape(attempt.attemptId)} — ${escape(describe(attempt))}"></div>`
  );
}

function describe(attempt: AttemptReport): string {
  switch (attempt.outcome.kind) {
    case "response":
      return `${attempt.outcome.status}${attempt.outcome.bodyTruncated ? " (truncated)" : ""}`;
    case "timeout":
      return `timeout after ${attempt.outcome.afterMs} ms`;
    case "transport-error":
      return `transport error: ${attempt.outcome.message}`;
    case "cancelled":
      return "cancelled";
  }
}

/** Escapes text for both element content and double-quoted attributes. */
function escape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
