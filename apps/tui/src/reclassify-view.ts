/**
 * Pure helpers for ReclassifyScreen (`C` on RulesScreen): the scope and
 * release toggles, when `y` may apply, the AI cost message, count lines,
 * and sample rows budgeted to the terminal width. No React, no I/O.
 */
import type {
  SenderRuleReclassifyParams,
  SenderRuleReclassifyRelease,
  SenderRuleReclassifyResponse,
  SenderRuleReclassifySample,
  SenderRuleReclassifyScope,
  SenderRuleReclassifyUndoResponse,
} from "./api.js";

/**
 * Smaller than the API default (500). A live apply that re-classifies
 * released mail through the AI takes ~0.7s per email and runs inside one
 * HTTP request; Node's fetch aborts after 300s without a response, so 500
 * AI releases could time out mid-run. 200 stays well under that; "more
 * remain" then prompts another run.
 */
export const DEFAULT_RECLASSIFY_LIMIT = 200;

export interface ReclassifyOptions extends SenderRuleReclassifyParams {
  release: SenderRuleReclassifyRelease;
  limit: number;
}

export const DEFAULT_RECLASSIFY_OPTIONS: ReclassifyOptions = {
  scope: "linked",
  release: "reclassify",
  limit: DEFAULT_RECLASSIFY_LIMIT,
};

export const NOTHING_TO_CHANGE = "Nothing to change";

export function toggleScope(scope: SenderRuleReclassifyScope): SenderRuleReclassifyScope {
  return scope === "linked" ? "matching" : "linked";
}

export function toggleRelease(release: SenderRuleReclassifyRelease): SenderRuleReclassifyRelease {
  return release === "reclassify" ? "mark_review" : "reclassify";
}

export function sameOptions(a: ReclassifyOptions, b: ReclassifyOptions): boolean {
  return a.scope === b.scope && a.release === b.release && a.limit === b.limit;
}

/**
 * The dry run on screen. `stale` after an apply or undo: the rows have
 * changed, so y needs a fresh dry run first.
 */
export type PreviewState =
  | { state: "none" }
  | { state: "loading"; options: ReclassifyOptions }
  | { state: "done"; options: ReclassifyOptions; value: SenderRuleReclassifyResponse }
  | { state: "error"; options: ReclassifyOptions; message: string }
  | { state: "stale" };

/** Rows a live run would write: update + claim + release. */
export function changeCount(res: Pick<SenderRuleReclassifyResponse, "counts">): number {
  return res.counts.update + res.counts.claim + res.counts.release;
}

/** What `y` does now. */
export type ApplyGate =
  | { kind: "wait"; message: string }
  | { kind: "nothing"; message: string }
  | { kind: "confirmCost"; message: string }
  | { kind: "apply" };

/**
 * `y` applies only a loaded dry run for the CURRENT options that has
 * something to change. When that dry run expects AI calls, the caller
 * shows the cost message and needs a second `y`.
 */
export function applyGate(preview: PreviewState, options: ReclassifyOptions): ApplyGate {
  switch (preview.state) {
    case "none":
    case "loading":
      return { kind: "wait", message: "Wait for the dry run to load" };
    case "error":
      return { kind: "wait", message: "The dry run failed: press r to run it again" };
    case "stale":
      return { kind: "wait", message: "Press r for a fresh dry run before applying again" };
    case "done":
      break;
  }
  if (!sameOptions(preview.options, options)) {
    return { kind: "wait", message: "Wait for the dry run to load" };
  }
  if (changeCount(preview.value) === 0) return { kind: "nothing", message: NOTHING_TO_CHANGE };
  if (preview.value.aiCalls > 0) return { kind: "confirmCost", message: costMessage(preview.value) };
  return { kind: "apply" };
}

/** "$0.0054", "$1.20", or "cost unknown" (null: no estimate for the provider). */
export function formatUsd(usd: number | null): string {
  if (usd === null) return "cost unknown";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "27 emails will be re-classified by typesafe (~$0.0054)". */
export function costMessage(
  res: Pick<SenderRuleReclassifyResponse, "aiCalls" | "aiProvider" | "estimatedAiCostUsd">,
): string {
  const cost = res.estimatedAiCostUsd === null ? "cost unknown" : `~${formatUsd(res.estimatedAiCostUsd)}`;
  return `${plural(res.aiCalls, "email")} will be re-classified by ${res.aiProvider ?? "the AI provider"} (${cost})`;
}

/** "update 3 · claim 27 · release 2 · skipped (reviewed) 1 · unchanged 5". */
export function countsLine(res: Pick<SenderRuleReclassifyResponse, "counts">): string {
  const c = res.counts;
  return `update ${c.update} · claim ${c.claim} · release ${c.release} · skipped (reviewed) ${c.skippedReviewed} · unchanged ${c.unchanged}`;
}

/** How the releases break down, or null when there are none. */
export function releaseLine(res: SenderRuleReclassifyResponse): string | null {
  const c = res.counts;
  if (c.release === 0) return null;
  if (res.release === "mark_review") {
    return res.dryRun
      ? `Released rows would be kept and flagged for review (no AI call)`
      : `Released: ${c.markedReview} kept and flagged for review${c.errors ? ` · ${c.errors} errors` : ""}`;
  }
  if (res.dryRun) {
    const byRules = Math.max(0, c.release - res.aiCalls - c.deferred);
    const parts = [`${byRules} by another rule`, `${res.aiCalls} by AI`];
    if (c.deferred) parts.push(`${c.deferred} deferred (AI unavailable)`);
    return `Released would be re-classified: ${parts.join(" · ")}`;
  }
  const parts = [`${c.reclassified} re-classified`, `${c.deferred} deferred`];
  if (c.errors) parts.push(`${c.errors} errors`);
  return `Released: ${parts.join(" · ")}`;
}

/** "AI: 27 calls expected by typesafe · est. ~$0.0054" (null when no AI is involved). */
export function aiLine(res: SenderRuleReclassifyResponse): string | null {
  if (res.aiCalls === 0) return null;
  const verb = res.dryRun ? "expected" : "made";
  const cost = res.estimatedAiCostUsd === null ? "cost unknown" : `est. ~${formatUsd(res.estimatedAiCostUsd)}`;
  return `AI: ${plural(res.aiCalls, "call")} ${verb} by ${res.aiProvider ?? "(no provider)"} · ${cost}`;
}

/** The aiUnavailable notice, or null when the AI was available. */
export function aiUnavailableNotice(res: SenderRuleReclassifyResponse): string | null {
  if (!res.aiUnavailable) return null;
  const n = res.counts.deferred;
  return res.dryRun
    ? `AI unavailable: ${plural(n, "email")} would keep their classification and be flagged for review`
    : `AI unavailable: ${plural(n, "email")} kept their classification and were flagged for review`;
}

export function moreLine(res: SenderRuleReclassifyResponse): string | null {
  if (!res.more) return null;
  return res.dryRun
    ? `More remain beyond the limit of ${res.limit}: apply, then run again`
    : `More remain beyond the limit of ${res.limit}: press r, then y to continue`;
}

/** "Undo abc…: restored 12 · conflicts 1 · skipped (reviewed) 0 · already undone 0". */
export function undoSummary(res: SenderRuleReclassifyUndoResponse): string {
  const c = res.counts;
  return `Undid batch ${res.batchId}: restored ${c.restored} · conflicts ${c.conflicts} · skipped (reviewed) ${c.skippedReviewed} · already undone ${c.alreadyUndone}`;
}

/**
 * A failed call, verbatim with its HTTP status. Status 0 is no response:
 * for the live run that means it may still have run on the server.
 */
export function failureText(what: "Dry run" | "Apply" | "Undo", status: number, message: string): string {
  if (status > 0) return `${what} failed (HTTP ${status}): ${message}`;
  if (what === "Apply") {
    return `Apply: no response from the API (${message}). It may still have run: press r for a fresh dry run before retrying`;
  }
  if (what === "Undo") {
    return `Undo: no response from the API (${message}). It may still have run; retrying U is safe (already-undone rows are reported)`;
  }
  return `${what} failed: ${message}`;
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return value.length > 1 ? "…" : value;
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

function cell(value: string, width: number): string {
  return truncate(value, width).padEnd(width);
}

export interface SampleColumns {
  action: number;
  change: number;
  sender: number;
  subject: number;
}

/**
 * Column widths for a sample row of at most `width` characters (three
 * single-space gaps). At 80 terminal columns the panel leaves 73:
 * action 7, change 27, sender 16, subject 20.
 */
export function sampleColumns(width: number): SampleColumns {
  const action = 7;
  const change = Math.min(32, Math.max(12, Math.floor(width * 0.38)));
  const rest = Math.max(2, width - action - change - 3);
  const sender = Math.min(32, Math.max(1, Math.floor(rest * 0.45)));
  const subject = Math.max(1, rest - sender);
  return { action, change, sender, subject };
}

/** "marketing → newsletter"; "→ AI" when the AI decides, "→ review" for mark_review. */
export function changeText(
  sample: SenderRuleReclassifySample,
  release: SenderRuleReclassifyRelease,
): string {
  let to: string;
  if (sample.action === "release" && release === "mark_review") to = "review";
  else if (sample.to === null) to = "AI";
  else to = sample.to.category;
  return `${sample.from.category} → ${to}`;
}

/** One sample row, never longer than `width`. */
export function sampleRow(
  sample: SenderRuleReclassifySample,
  release: SenderRuleReclassifyRelease,
  width: number,
): string {
  const cols = sampleColumns(width);
  const row = [
    cell(sample.action, cols.action),
    cell(changeText(sample, release), cols.change),
    cell(sample.fromAddress ?? "(unknown)", cols.sender),
    truncate(sample.subject ?? "(no subject)", cols.subject),
  ].join(" ");
  return truncate(row.trimEnd(), width);
}

/**
 * Usable text width inside the bordered panel: the screen's paddingX 1
 * each side, the border, the panel's paddingX 1 each side, and one spare
 * column so a full row never wraps.
 */
export function panelTextWidth(columns: number): number {
  return Math.max(20, columns - 7);
}
