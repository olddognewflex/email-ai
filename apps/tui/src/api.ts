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

export interface QueueResponse {
  success: boolean;
  data: QueueItem[];
  pagination: Pagination;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, init);
  } catch {
    throw new Error(UNREACHABLE_MESSAGE);
  }

  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body; fall through to status handling.
  }

  if (!res.ok) {
    const body = json as { message?: string | string[]; error?: string } | null;
    const raw = body?.message ?? body?.error ?? `HTTP ${res.status}`;
    const msg = Array.isArray(raw) ? raw.join("; ") : String(raw);
    throw new Error(msg);
  }

  return json as T;
}

export function fetchQueue(page = 1, limit = 50): Promise<QueueResponse> {
  return request<QueueResponse>(`/review-queue?page=${page}&limit=${limit}`);
}

export function fetchDetail(id: string): Promise<DetailResponse> {
  return request<DetailResponse>(`/review-queue/${encodeURIComponent(id)}`);
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
