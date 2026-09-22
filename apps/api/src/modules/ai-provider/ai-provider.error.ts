/**
 * Typed AI-provider errors + error taxonomy.
 *
 * Providers previously swallowed non-2xx HTTP responses into a *resolved*
 * `{ content: "", error }` value, which meant the rate limiter and circuit
 * breaker never saw them — a 429 looked identical to a success. Providers now
 * throw `AiProviderError` carrying the raw facts parsed from the real HTTP
 * response (status + rate-limit headers), and `categorizeError` maps any
 * thrown value into one of three buckets the caller acts on:
 *
 *   - quota      → sleep until the reset window (breaker opens)
 *   - transient  → exponential backoff with jitter, capped (retried in-run)
 *   - auth       → stop and alert; never auto-retry
 */

export type ErrorCategory = "quota" | "transient" | "auth" | "unknown";

export interface AiProviderErrorInit {
  provider: string;
  status: number;
  body?: string;
  /** Delay hint in ms parsed from Retry-After / x-ratelimit-reset-* headers. */
  retryAfterMs?: number;
  /** Absolute epoch-ms the limit is expected to reset, when derivable. */
  resetAt?: number;
  message?: string;
}

export class AiProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  readonly body?: string;
  readonly retryAfterMs?: number;
  readonly resetAt?: number;

  constructor(init: AiProviderErrorInit) {
    super(init.message ?? `${init.provider} API error: ${init.status}`);
    this.name = "AiProviderError";
    this.provider = init.provider;
    this.status = init.status;
    this.body = init.body;
    this.retryAfterMs = init.retryAfterMs;
    this.resetAt = init.resetAt;
  }
}

/** Thrown by AiProviderService.complete() when the circuit breaker is open. */
export class BreakerOpenError extends Error {
  readonly nextAllowedAttempt?: string;
  readonly reason?: ErrorCategory;

  constructor(nextAllowedAttempt?: string, reason?: ErrorCategory) {
    super(
      `AI circuit breaker open${
        nextAllowedAttempt ? ` until ${nextAllowedAttempt}` : ""
      }`,
    );
    this.name = "BreakerOpenError";
    this.nextAllowedAttempt = nextAllowedAttempt;
    this.reason = reason;
  }
}

/**
 * Why a 2xx response was unusable:
 * - `unparseable`   — the body is not JSON at all (wrong `apiEndpoint`
 *   returning 200 HTML, a captive proxy). Systemic: every request will fail.
 * - `invalid_shape` — valid JSON that fails the response schema, or answers
 *   that cannot be interpreted (label outside the enum, missing answer).
 *   May be specific to one email, so it is handled per item.
 */
export type InvalidResponseKind = "unparseable" | "invalid_shape";

/**
 * The provider answered with HTTP 2xx but the body was unusable. Callers
 * write NO row either way, so the email is retried later rather than
 * poisoned with a fallback. `AiProviderService` records an `unparseable`
 * body as a breaker failure (`unknown`, short hold → the batch stops) and
 * an `invalid_shape` one like a 422 (breaker success; the batch continues).
 */
export class InvalidProviderResponseError extends Error {
  readonly provider: string;
  readonly kind: InvalidResponseKind;
  /** Raw response body (truncated), for logs. */
  readonly rawBody?: string;

  constructor(
    provider: string,
    kind: InvalidResponseKind,
    message: string,
    rawBody?: string,
  ) {
    super(message);
    this.name = "InvalidProviderResponseError";
    this.provider = provider;
    this.kind = kind;
    this.rawBody = rawBody;
  }
}

/**
 * True for failures that concern ONE request/email rather than the provider
 * as a whole: a 422 rejection or an `invalid_shape` response. Batch callers
 * skip the item (no row) and continue, stopping only after a run of them.
 */
export function isPerRequestFailure(
  error: unknown,
): error is ProviderRequestRejectedError | InvalidProviderResponseError {
  return (
    error instanceof ProviderRequestRejectedError ||
    (error instanceof InvalidProviderResponseError &&
      error.kind === "invalid_shape")
  );
}

/**
 * The provider is reachable and the key valid, but it rejected THIS request
 * (TypeSafe HTTP 422 — e.g. state/question validation). Per-request, not
 * systemic: the breaker records a success and callers skip just this item.
 */
export class ProviderRequestRejectedError extends Error {
  readonly provider: string;
  readonly status: number;
  /** Response body (truncated) explaining the rejection. */
  readonly body?: string;

  constructor(provider: string, status: number, body?: string) {
    const snippet = body ? ` - ${body.slice(0, 300)}` : "";
    super(`${provider} rejected the request: ${status}${snippet}`);
    this.name = "ProviderRequestRejectedError";
    this.provider = provider;
    this.status = status;
    this.body = body?.slice(0, 2000);
  }
}

/**
 * The active provider cannot serve the requested operation (e.g. `complete()`
 * with TypeSafe active, or `judge()` with an LLM active). Raised before any
 * network call; it is a local wiring problem, so it never touches the breaker.
 */
export class AiProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiProviderConfigError";
  }
}

export interface CategorizeConfig {
  /** 429s whose reset hint is within this window are transient; longer = quota. */
  transientCapMs: number;
}

/**
 * Map an arbitrary thrown value into an {@link ErrorCategory}.
 * The decision drives whether the caller retries, sleeps, or stops.
 */
export function categorizeError(
  error: unknown,
  config: CategorizeConfig,
): ErrorCategory {
  if (error instanceof AiProviderError) {
    const { status, retryAfterMs } = error;
    if (status === 429) {
      // A short reset hint is a normal per-minute rate-limit (transient);
      // a long hint or no hint at all means the quota is spent (quota).
      if (retryAfterMs !== undefined && retryAfterMs <= config.transientCapMs) {
        return "transient";
      }
      return "quota";
    }
    if (status === 408) return "transient"; // request timeout
    if (status >= 500) return "transient";
    if (status === 401 || status === 403) return "auth";
    if (status >= 400) return "auth"; // other 4xx = config error → stop & alert
    return "unknown";
  }
  if (isNetworkError(error)) return "transient";
  return "unknown";
}

/** True for connection/timeout failures that never reached the provider. */
export function isNetworkError(error: unknown): boolean {
  if (error instanceof AiProviderError) return false;
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true; // fetch() timeout via AbortController
  const code =
    (error as { code?: string }).code ??
    (error as { cause?: { code?: string } }).cause?.code ??
    "";
  if (
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(
      code,
    )
  ) {
    return true;
  }
  // Undici / global fetch surfaces network failures as a generic TypeError.
  if (error instanceof TypeError && /fetch failed|network/i.test(error.message)) {
    return true;
  }
  return false;
}

/**
 * Parse rate-limit reset hints from real HTTP headers.
 * Precedence: `Retry-After`, then the soonest of the `x-ratelimit-reset-*`
 * duration headers, then a generic `x-ratelimit-reset` (epoch or duration).
 */
export function parseRateLimitHeaders(
  headers: Headers,
  now: number = Date.now(),
): { retryAfterMs?: number; resetAt?: number } {
  const get = (k: string): string | undefined => headers.get(k) ?? undefined;

  // 1. Retry-After: integer seconds or an HTTP-date.
  const retryAfter = get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) {
      const ms = Math.max(0, secs * 1000);
      return { retryAfterMs: ms, resetAt: now + ms };
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      return { retryAfterMs: Math.max(0, date - now), resetAt: date };
    }
  }

  // 2. OpenAI-compatible reset durations, e.g. "1s", "6m0s", "150ms".
  const durations = [
    get("x-ratelimit-reset-requests"),
    get("x-ratelimit-reset-tokens"),
  ]
    .map((v) => (v ? parseDurationMs(v) : undefined))
    .filter((v): v is number => v !== undefined);
  if (durations.length > 0) {
    const ms = Math.max(0, Math.min(...durations));
    return { retryAfterMs: ms, resetAt: now + ms };
  }

  // 3. Generic x-ratelimit-reset: absolute epoch seconds or a duration.
  const reset = get("x-ratelimit-reset");
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) {
      // Values that look like a Unix timestamp are absolute; else seconds-from-now.
      if (n > 1_000_000_000) {
        const resetAt = n * 1000;
        return { retryAfterMs: Math.max(0, resetAt - now), resetAt };
      }
      const ms = Math.max(0, n * 1000);
      return { retryAfterMs: ms, resetAt: now + ms };
    }
    const dur = parseDurationMs(reset);
    if (dur !== undefined) return { retryAfterMs: dur, resetAt: now + dur };
  }

  return {};
}

/** Parse Go-style duration strings ("1s", "6m0s", "2h3m", "150ms") to ms. */
export function parseDurationMs(value: string): number | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  // A bare number is interpreted as seconds (common for reset headers).
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(parseFloat(v) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
  let match: RegExpExecArray | null;
  let total = 0;
  let found = false;
  while ((match = re.exec(v)) !== null) {
    found = true;
    const n = parseFloat(match[1]);
    switch (match[2]) {
      case "ms":
        total += n;
        break;
      case "s":
        total += n * 1000;
        break;
      case "m":
        total += n * 60_000;
        break;
      case "h":
        total += n * 3_600_000;
        break;
    }
  }
  return found ? Math.round(total) : undefined;
}

/**
 * Throw a typed {@link AiProviderError} for any non-ok HTTP response,
 * parsing rate-limit headers off the real `Response`. Shared by every
 * provider so the throw/parse logic lives in exactly one place.
 */
export async function throwIfNotOk(
  response: Response,
  provider: string,
  now: number = Date.now(),
): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  const { retryAfterMs, resetAt } = parseRateLimitHeaders(response.headers, now);
  throw new AiProviderError({
    provider,
    status: response.status,
    body,
    retryAfterMs,
    resetAt,
    message: `${provider} API error: ${response.status} - ${body}`,
  });
}
