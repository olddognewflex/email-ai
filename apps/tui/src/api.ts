/**
 * Typed fetch client for the local email-ai API review-queue endpoints.
 * Node 22: global fetch is available.
 */

const PORT = process.env.PORT ?? "3000";

export const API_BASE = `http://localhost:${PORT}`;

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
    res = await fetch(`${API_BASE}${path}`, init);
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
    throw new ApiError(msg, res.status);
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
 * reading "suggestions" as a rule id.
 */
function isMissingRoute(err: unknown): boolean {
  return (
    err instanceof ApiError &&
    err.status === 404 &&
    /^Cannot (GET|POST|PATCH|DELETE) |^Sender rule suggestions not found/.test(
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

export function listRules(): Promise<SenderRule[]> {
  return withOldApiMessage(request<SenderRule[]>("/sender-rules"));
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

/** Message text of any thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
