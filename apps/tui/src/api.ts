/**
 * Typed fetch client for the local email-ai API review-queue endpoints.
 * Node 22: global fetch is available.
 */

const PORT = process.env.PORT ?? "3000";

// 127.0.0.1, not "localhost": the API binds IPv4 loopback only, and
// "localhost" may resolve to ::1 first.
export const API_BASE = `http://127.0.0.1:${PORT}`;

/**
 * Sent on every request. The API requires it on write-capable endpoints
 * (trash rules, apply, undo); a browser cannot add it cross-site without a
 * CORS preflight the API never grants.
 */
export const CLIENT_HEADER = { "X-Email-AI-Client": "eai-tui" } as const;

export const UNREACHABLE_MESSAGE = `API not running on ${API_BASE} — check launchd service`;

/** Item shape returned by GET /review-queue (list endpoint). */
export interface QueueItem {
  classification: {
    id: string;
    category: string;
    importance: string;
    urgency: string;
    recommendedAction: string;
    confidence: string;
    needsReview: boolean;
    reason: string;
    createdAt: string;
  };
  email: {
    id: string;
    subject: string | null;
    fromAddress: string | null;
    fromName: string | null;
    senderDomain: string;
    accountLabel: string | null;
    internalDate: string;
    unsubscribeLink: string | null;
  };
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/**
 * Effective received-date window the API applied. `since` is an ISO
 * timestamp (null = all mail); `days` is null for an explicit since/all.
 */
export interface QueueWindow {
  since: string | null;
  days: number | null;
}

export interface QueueResponse {
  success: boolean;
  data: QueueItem[];
  pagination: Pagination;
  /** Absent from API builds that predate the received-date window. */
  window?: QueueWindow;
}

/** Shape returned by GET /review-queue/:id (detail endpoint). */
export interface ClassificationDetail {
  id: string;
  category: string;
  importance: string;
  urgency: string;
  recommendedAction: string;
  confidence: string;
  reason: string;
  needsReview: boolean;
  providerUsed: string | null;
  createdAt: string;
  reviewDecision: {
    decision: string;
    correctedCategory?: string | null;
    decidedAt?: string;
  } | null;
  rule: {
    category: string | null;
    confidence: string | null;
    reasons: string[];
  } | null;
  email: {
    subject: string | null;
    fromAddress: string | null;
    fromName: string | null;
    toAddresses: string[];
    ccAddresses: string[];
    date: string | null;
    attachmentCount: number;
    unsubscribeLink: string | null;
    senderDomain: string;
    accountLabel: string | null;
    isNewsletter: boolean;
    isBulk: boolean;
    tags: string[];
  };
  body: {
    text: string | null;
    html: string | null;
  };
}

export interface DetailResponse {
  success: boolean;
  data: ClassificationDetail;
}

export interface DecisionResponse {
  success: boolean;
  data: {
    id: string;
    classificationId: string;
    decision: string;
    decidedAt: string;
  };
  message?: string;
}

/** Per-account result from POST /email-sync/run-all. */
export interface SyncResult {
  accountId: string;
  mailbox: string;
  fetchedCount: number;
  storedCount: number;
  dryRun: boolean;
  lastUid: number;
}

/** Aggregate shape returned by POST /email-sync/run-all. */
export interface SyncAllResponse {
  total: number;
  succeeded: number;
  failed: number;
  results: SyncResult[];
  errors: { accountId: string; error: string }[];
}

/** An API error with its HTTP status (0 when the API was unreachable). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Parsed JSON error body, e.g. a Zod 400's { formErrors, fieldErrors }. */
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Joins a ZodValidationPipe 400 body ({ formErrors, fieldErrors }). */
function zodErrorMessage(body: unknown): string | null {
  const b = body as {
    formErrors?: string[];
    fieldErrors?: Record<string, string[] | undefined>;
  } | null;
  if (!b || (!b.formErrors && !b.fieldErrors)) return null;
  const parts = [
    ...(b.formErrors ?? []),
    ...Object.entries(b.fieldErrors ?? {}).flatMap(([field, errs]) =>
      (errs ?? []).map((e) => `${field}: ${e}`),
    ),
  ];
  return parts.length ? parts.join("; ") : null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    const headers = new Headers(init?.headers);
    for (const [k, v] of Object.entries(CLIENT_HEADER)) headers.set(k, v);
    res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiError(UNREACHABLE_MESSAGE, 0);
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body; fall through to status handling.
  }

  if (!res.ok) {
    const body = json as { message?: string | string[]; error?: string } | null;
    const raw =
      body?.message ?? zodErrorMessage(json) ?? body?.error ?? `HTTP ${res.status}`;
    const msg = Array.isArray(raw) ? raw.join("; ") : String(raw);
    throw new ApiError(msg, res.status, json);
  }

  return json as T;
}

/**
 * Review queue. Without `all`, the API applies its default received-date
 * window (last 14 days); `all` disables it.
 */
export function fetchQueue(page = 1, limit = 50, all = false): Promise<QueueResponse> {
  return request<QueueResponse>(
    `/review-queue?page=${page}&limit=${limit}${all ? "&all=true" : ""}`,
  );
}

/** Emails the classifier flagged as needing action (the digest's Actionable set). */
export function fetchActionable(page = 1, limit = 50, all = false): Promise<QueueResponse> {
  return request<QueueResponse>(
    `/review-queue/actionable?page=${page}&limit=${limit}${all ? "&all=true" : ""}`,
  );
}

/** Short label for the effective window, e.g. "last 14 days" or "all mail". */
export function describeWindow(window: QueueWindow | undefined): string | null {
  if (!window) return null;
  if (!window.since) return "all mail";
  if (window.days !== null) return `last ${window.days} days`;
  // Local calendar date: slicing the UTC ISO string is a day off east of UTC.
  const d = new Date(window.since);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `since ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fetchDetail(id: string): Promise<DetailResponse> {
  return request<DetailResponse>(`/review-queue/${encodeURIComponent(id)}`);
}

/**
 * Sync every active account from IMAP. Persists by default (dryRun=false)
 * since a manual sync from the TUI is meant to fetch real mail.
 */
export function syncAllAccounts(dryRun = false): Promise<SyncAllResponse> {
  return request<SyncAllResponse>(`/email-sync/run-all?dryRun=${dryRun}`, {
    method: "POST",
  });
}

export function approveClassification(id: string): Promise<DecisionResponse> {
  return request<DecisionResponse>(
    `/review-queue/${encodeURIComponent(id)}/approve`,
    { method: "POST" },
  );
}

export function rejectClassification(
  id: string,
  correctedCategory?: string,
): Promise<DecisionResponse> {
  const init: RequestInit = { method: "POST" };
  if (correctedCategory) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify({ correctedCategory });
  }
  return request<DecisionResponse>(
    `/review-queue/${encodeURIComponent(id)}/reject`,
    init,
  );
}

// ---------------------------------------------------------------------------
// Sender rules (EMAIL-1). Rules only pre-classify matching mail until the
// mailbox-writes kill switch ships; `trash` rules then also move to Trash.
// ---------------------------------------------------------------------------

export type SenderRuleMatchType =
  | "address"
  | "domain"
  | "domain_suffix"
  | "glob"
  | "regex";

export type SenderRuleAction = "classify" | "trash";

/** A stored rule as returned by GET /sender-rules. */
export interface SenderRule {
  id: string;
  pattern: string;
  matchType: SenderRuleMatchType;
  action: SenderRuleAction;
  category: string;
  enabled: boolean;
  note: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * GET /sender-rules/:id: the rule plus its linked classification count.
 * `_count` is absent from API builds that predate it.
 */
export interface SenderRuleDetail extends SenderRule {
  _count?: { classifications: number };
}

export interface CreateSenderRuleInput {
  pattern: string;
  matchType: SenderRuleMatchType;
  action: SenderRuleAction;
  category?: string;
  enabled?: boolean;
  note?: string | null;
  source?: "manual" | "suggestion" | "tui";
}

/** POST/PATCH result: the rule plus warnings such as protected-sender hits. */
export interface SenderRuleWriteResult {
  rule: SenderRule;
  warnings: string[];
}

/** POST /sender-rules/preview: what a pattern matches in stored mail. */
export interface SenderRulePreview {
  matchedEmails: number;
  unclassifiedMatches: number;
  domains: { domain: string; count: number }[];
  protectedHits: string[];
}

export interface SuggestedRule {
  pattern: string;
  matchType: SenderRuleMatchType;
  action: "classify";
  category: "marketing" | "newsletter";
}

export interface SuggestionFamily {
  key: string;
  kind: "prefix" | "news-subdomain" | "single";
  totalEmails: number;
  domains: { domain: string; total: number; share: number }[];
  proposedRules: SuggestedRule[];
  excludedLegit: string[];
}

export interface SuggestionsResponse {
  families: SuggestionFamily[];
}

/** Shown when the running API predates an endpoint. */
export const OLD_API_MESSAGE =
  "The running API does not support this yet — update and restart it";

/**
 * A 404 that means the route itself is missing (API older than the TUI),
 * rather than a missing record: Nest's "Cannot GET /x", or an older API
 * reading "suggestions" or "match" as a rule id.
 */
function isMissingRoute(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 404 &&
    /^Cannot (GET|POST|PATCH|DELETE) |^Sender rule (suggestions|match) not found/.test(
      err.message,
    )
  );
}

async function withOldApiMessage<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isMissingRoute(err)) throw new ApiError(OLD_API_MESSAGE, 404);
    throw err;
  }
}

/** GET /sender-rules/match: the enabled rule (if any) covering a sender. */
export interface SenderRuleMatchResult {
  rule: SenderRule | null;
  matchedOn: "address" | "domain" | null;
}

/**
 * Read-only: which enabled rule covers this sender, with the precedence
 * classification uses. At least one of address/domain must be set.
 */
export function matchSenderRule(sender: {
  address?: string | null;
  domain?: string | null;
}): Promise<SenderRuleMatchResult> {
  const qs = new URLSearchParams();
  if (sender.address) qs.set("address", sender.address);
  if (sender.domain) qs.set("domain", sender.domain);
  return withOldApiMessage(
    request<SenderRuleMatchResult>(`/sender-rules/match?${qs.toString()}`),
  );
}

export function listRules(): Promise<SenderRule[]> {
  return withOldApiMessage(request<SenderRule[]>("/sender-rules"));
}

export function getRule(id: string): Promise<SenderRuleDetail> {
  return withOldApiMessage(
    request<SenderRuleDetail>(`/sender-rules/${encodeURIComponent(id)}`),
  );
}

export function createRule(input: CreateSenderRuleInput): Promise<SenderRuleWriteResult> {
  return withOldApiMessage(
    request<SenderRuleWriteResult>("/sender-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export function updateRule(
  id: string,
  patch: Partial<CreateSenderRuleInput>,
): Promise<SenderRuleWriteResult> {
  return withOldApiMessage(
    request<SenderRuleWriteResult>(`/sender-rules/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  );
}

export async function deleteRule(id: string): Promise<void> {
  await withOldApiMessage(
    request<null>(`/sender-rules/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

export function previewRule(
  pattern: string,
  matchType: SenderRuleMatchType,
): Promise<SenderRulePreview> {
  return withOldApiMessage(
    request<SenderRulePreview>("/sender-rules/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern, matchType }),
    }),
  );
}

/** Read-only: GET /sender-rules/suggestions never creates rules. */
export function fetchSuggestions(
  params: { minEmails?: number; minShare?: number; provider?: string } = {},
): Promise<SuggestionsResponse> {
  const qs = new URLSearchParams();
  if (params.minEmails !== undefined) qs.set("minEmails", String(params.minEmails));
  if (params.minShare !== undefined) qs.set("minShare", String(params.minShare));
  if (params.provider) qs.set("provider", params.provider);
  const query = qs.toString();
  return withOldApiMessage(
    request<SuggestionsResponse>(
      `/sender-rules/suggestions${query ? `?${query}` : ""}`,
    ),
  );
}

// ---------------------------------------------------------------------------
// Mailbox actions (EMAIL-1). Mirrors packages/shared/src/schemas/
// mailbox-actions.schemas.ts. The TUI can undo a move and run reconcile
// (both refused by the API unless MAILBOX_WRITES_ENABLED=true), and preview
// an apply run. It can never start a live apply: see applyRulesDryRun.
// ---------------------------------------------------------------------------

export type MailboxActionType = "move_to_trash" | "restore";

export type MailboxActionStatus =
  | "pending"
  | "succeeded"
  | "failed"
  | "skipped"
  | "undone"
  | "unknown";

/** A MailboxAction audit row as returned by GET /mailbox-actions. */
export interface MailboxAction {
  id: string;
  action: MailboxActionType;
  status: MailboxActionStatus;
  accountId: string;
  rawEmailId: string | null;
  senderRuleId: string | null;
  undoOfId: string | null;
  sourceMailbox: string;
  sourceUid: number;
  sourceUidValidity: string | null;
  destMailbox: string | null;
  destUid: number | null;
  destUidValidity: string | null;
  messageId: string | null;
  fromAddress: string | null;
  subject: string | null;
  gmailLabels: string[];
  error: string | null;
  undoneAt: string | null;
  createdAt: string;
  account: { label: string };
}

/** GET /mailbox-actions/status. */
export interface MailboxWritesStatus {
  writesEnabled: boolean;
}

/** POST /mailbox-actions/:id/undo. */
export interface MailboxUndoResult {
  original: Omit<MailboxAction, "account">;
  restore: Omit<MailboxAction, "account">;
}

export interface SenderRuleApplyCounts {
  /** Eligible mail matched by the rule(s), before `limit`. */
  matched: number;
  /** Of those, selected for this run: what a live run would try to move. */
  selected: number;
  moved: number;
  skipped: number;
  failed: number;
  unknown: number;
}

export interface SenderRuleApplySample {
  rawEmailId: string;
  fromAddress: string | null;
  subject: string | null;
  outcome: "would_move" | "succeeded" | "failed" | "skipped" | "unknown";
  error?: string | null;
}

export interface SenderRuleApplyAccount extends SenderRuleApplyCounts {
  accountId: string;
  accountLabel: string;
  /** Account-level refusal (e.g. no MOVE, no \Trash, needs re-auth). */
  error?: string | null;
  sample: SenderRuleApplySample[];
}

export interface SenderRuleApplyRule {
  ruleId: string;
  pattern: string;
  matchType: string;
  byAccount: SenderRuleApplyAccount[];
}

/** POST /sender-rules/apply response. */
export interface SenderRuleApplyResponse {
  dryRun: boolean;
  writesEnabled: boolean;
  limit: number;
  totals: SenderRuleApplyCounts;
  byRule: SenderRuleApplyRule[];
}

export interface MailboxReconcileItem {
  id: string;
  action: MailboxActionType;
  from: MailboxActionStatus;
  /** New status, or null when left unresolved. */
  to: MailboxActionStatus | null;
  detail: string;
}

/** POST /mailbox-actions/reconcile response. */
export interface MailboxReconcileResponse {
  examined: number;
  resolved: number;
  unresolved: number;
  accounts: { accountId: string; error: string | null; items: MailboxReconcileItem[] }[];
}

/** Shown when the running API predates the mailbox-actions endpoints. */
export const MAILBOX_ACTIONS_UNSUPPORTED_MESSAGE =
  "This API version doesn't support mailbox actions yet — update and restart it";

/** Shown when the running API predates POST /sender-rules/apply. */
export const APPLY_PREVIEW_UNSUPPORTED_MESSAGE =
  "This API version doesn't support rule apply preview yet";

/**
 * Like withOldApiMessage, with a feature-specific wording. Only a missing
 * route is rewritten: a 404 for an unknown action id stays verbatim.
 */
async function withMissingRouteMessage<T>(promise: Promise<T>, message: string): Promise<T> {
  try {
    return await promise;
  } catch (err) {
    if (isMissingRoute(err)) throw new ApiError(message, 404);
    throw err;
  }
}

function withMailboxActionsSupport<T>(promise: Promise<T>): Promise<T> {
  return withMissingRouteMessage(promise, MAILBOX_ACTIONS_UNSUPPORTED_MESSAGE);
}

/** Kill-switch state. Config only on the API side: never opens IMAP. */
export function fetchWriteStatus(): Promise<MailboxWritesStatus> {
  return withMailboxActionsSupport(request<MailboxWritesStatus>("/mailbox-actions/status"));
}

/** Recent audit rows, newest first. Read-only. */
export function fetchMailboxActions(params: {
  limit: number;
  accountId?: string;
  status?: MailboxActionStatus;
}): Promise<MailboxAction[]> {
  const qs = new URLSearchParams({ limit: String(params.limit) });
  if (params.accountId) qs.set("accountId", params.accountId);
  if (params.status) qs.set("status", params.status);
  return withMailboxActionsSupport(
    request<MailboxAction[]>(`/mailbox-actions?${qs.toString()}`),
  );
}

/**
 * Move a trashed message back to INBOX. The API refuses with 403 (writes
 * disabled), 404 (unknown id), 409 (not a succeeded move / already undone)
 * or 502 (not found in Trash); the caller shows the message verbatim.
 */
export function undoMailboxAction(id: string): Promise<MailboxUndoResult> {
  return withMailboxActionsSupport(
    request<MailboxUndoResult>(`/mailbox-actions/${encodeURIComponent(id)}/undo`, {
      method: "POST",
    }),
  );
}

/**
 * Preview of POST /sender-rules/apply: always a DRY RUN. The TUI must never
 * start a live apply, so `dryRun=true` is a literal in the path and this
 * function deliberately takes no dryRun option — there is no parameter or
 * code path that could send dryRun=false. Live moves run only from the
 * hourly job (and only when the kill switch is on).
 */
export function applyRulesDryRun(
  params: { limit?: number; ruleId?: string } = {},
): Promise<SenderRuleApplyResponse> {
  const limit = params.limit !== undefined ? `&limit=${encodeURIComponent(String(params.limit))}` : "";
  // Scoped to one stored rule; the API 400s unless it is an enabled trash rule.
  const ruleId = params.ruleId !== undefined ? `&ruleId=${encodeURIComponent(params.ruleId)}` : "";
  return withMissingRouteMessage(
    request<SenderRuleApplyResponse>(`/sender-rules/apply?dryRun=true${limit}${ruleId}`, {
      method: "POST",
    }),
    APPLY_PREVIEW_UNSUPPORTED_MESSAGE,
  );
}

/**
 * Resolve pending/unknown rows older than 10 minutes by looking the
 * messages up in INBOX and Trash. Read-only on IMAP; needs the kill switch.
 */
export function reconcileMailboxActions(accountId?: string): Promise<MailboxReconcileResponse> {
  const qs = accountId ? `?accountId=${encodeURIComponent(accountId)}` : "";
  return withMailboxActionsSupport(
    request<MailboxReconcileResponse>(`/mailbox-actions/reconcile${qs}`, { method: "POST" }),
  );
}

// ---------------------------------------------------------------------------
// Reclassify existing mail for one rule (EMAIL-4). Mirrors the
// SenderRuleReclassify* schemas in packages/shared/src/schemas/
// sender-rules.schemas.ts. Database only: never touches a mailbox, but a
// live run rewrites real classification rows (and may call the AI), so
// previews and the live run are separate functions: reclassifyRule() can
// only send dryRun=true, applyReclassify() is the one live call.
// ---------------------------------------------------------------------------

export type SenderRuleReclassifyScope = "linked" | "matching";
export type SenderRuleReclassifyRelease = "reclassify" | "mark_review";
export type ClassificationRevisionAction = "update" | "claim" | "release";

export interface SenderRuleReclassifyParams {
  scope: SenderRuleReclassifyScope;
  /** API default: reclassify. */
  release?: SenderRuleReclassifyRelease;
  /** API default 500, max 5000. */
  limit?: number;
}

export interface SenderRuleReclassifyCounts {
  update: number;
  claim: number;
  release: number;
  skippedReviewed: number;
  unchanged: number;
  /** Of `release`: classified again in this request. */
  reclassified: number;
  /** Of `release`: needed the AI but it was unavailable; kept and flagged for review. */
  deferred: number;
  /** Of `release` with release=mark_review: kept with needsReview. */
  markedReview: number;
  errors: number;
}

export interface SenderRuleReclassifySample {
  normalizedEmailId: string;
  fromAddress: string | null;
  subject: string | null;
  action: ClassificationRevisionAction;
  from: { category: string; recommendedAction: string; providerUsed: string | null };
  /** Null when not known: a released row still to be classified by the AI. */
  to: { category: string; recommendedAction: string } | null;
}

/** POST /sender-rules/:id/reclassify response. */
export interface SenderRuleReclassifyResponse {
  dryRun: boolean;
  scope: SenderRuleReclassifyScope;
  release: SenderRuleReclassifyRelease;
  limit: number;
  /** Null on a dry run. */
  batchId: string | null;
  counts: SenderRuleReclassifyCounts;
  /** AI classifications made (live) or expected (dry run). */
  aiCalls: number;
  /** Active AI provider type, or null when none is configured. */
  aiProvider: string | null;
  /** True when releases that needed the AI were flagged for review instead. */
  aiUnavailable: boolean;
  /** Estimate for `aiCalls`; null when the provider's cost is unknown. */
  estimatedAiCostUsd: number | null;
  /** True when changes remained beyond `limit`. */
  more: boolean;
  sample: SenderRuleReclassifySample[];
}

/** POST /sender-rules/reclassify-batches/:batchId/undo response. */
export interface SenderRuleReclassifyUndoResponse {
  batchId: string;
  counts: {
    restored: number;
    /** Changed again since the batch; left as they are. */
    conflicts: number;
    /** Gained a ReviewDecision since the batch; left as they are. */
    skippedReviewed: number;
    /** Already undone by an earlier call. */
    alreadyUndone: number;
  };
}

/** Shown when the running API predates the reclassify endpoints. */
export const RECLASSIFY_UNSUPPORTED_MESSAGE =
  "This API version doesn't support reclassify yet";

function reclassifyPath(id: string, dryRun: "true" | "false", params: SenderRuleReclassifyParams): string {
  const qs = new URLSearchParams({ dryRun, scope: params.scope });
  if (params.release !== undefined) qs.set("release", params.release);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  return `/sender-rules/${encodeURIComponent(id)}/reclassify?${qs.toString()}`;
}

/**
 * Preview: always a DRY RUN. `dryRun=true` is a literal and this function
 * takes no dryRun option, so it can never change a classification.
 */
export function reclassifyRule(
  id: string,
  params: SenderRuleReclassifyParams,
): Promise<SenderRuleReclassifyResponse> {
  return withMissingRouteMessage(
    request<SenderRuleReclassifyResponse>(reclassifyPath(id, "true", params), {
      method: "POST",
    }),
    RECLASSIFY_UNSUPPORTED_MESSAGE,
  );
}

/**
 * The LIVE run (dryRun=false): rewrites classification rows and may call
 * the AI provider for released rows. The only live reclassify call in the
 * TUI; ReclassifyScreen calls it only after a y on a loaded dry run for
 * the same scope and release (and a second y when AI calls are expected).
 */
export function applyReclassify(
  id: string,
  params: SenderRuleReclassifyParams,
): Promise<SenderRuleReclassifyResponse> {
  return withMissingRouteMessage(
    request<SenderRuleReclassifyResponse>(reclassifyPath(id, "false", params), {
      method: "POST",
    }),
    RECLASSIFY_UNSUPPORTED_MESSAGE,
  );
}

/** Restore a batch's previous values; the API refuses rows changed or reviewed since. */
export function undoReclassifyBatch(batchId: string): Promise<SenderRuleReclassifyUndoResponse> {
  return withMissingRouteMessage(
    request<SenderRuleReclassifyUndoResponse>(
      `/sender-rules/reclassify-batches/${encodeURIComponent(batchId)}/undo`,
      { method: "POST" },
    ),
    RECLASSIFY_UNSUPPORTED_MESSAGE,
  );
}

/** Message text of any thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
