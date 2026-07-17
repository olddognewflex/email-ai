/**
 * In-run rate limiter + transient-retry executor for AI calls.
 *
 * Scope narrowed deliberately: this layer now retries *only* transient
 * failures (timeouts, 5xx, connection errors, short-hint 429s) with
 * exponential backoff + jitter, capped by `maxDelayMs`. Quota and auth
 * errors are rethrown immediately so the circuit breaker one level up can
 * open and persist — retrying those in-run just burns more doomed calls.
 */
import { AiProviderError, categorizeError } from "./ai-provider.error";

export interface RateLimiterConfig {
  requestsPerMinute: number;
  maxRetries: number;
  baseDelayMs: number;
  /** Cap for transient backoff (the "transient cap" knob). */
  maxDelayMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimiterConfig = {
  requestsPerMinute: 20,
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

export interface RateLimiterDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
}

export class RateLimiter {
  private lastRequestTime = 0;
  private minIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rng: () => number;

  constructor(
    private config: RateLimiterConfig = DEFAULT_RATE_LIMIT,
    deps: RateLimiterDeps = {},
  ) {
    this.minIntervalMs = (60 * 1000) / config.requestsPerMinute;
    this.now = deps.now ?? (() => Date.now());
    this.sleep =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.rng = deps.rng ?? Math.random;
  }

  /**
   * Execute `fn` with request spacing and transient-only retry. Non-transient
   * errors (quota/auth/unknown) are rethrown on the first occurrence.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForRateLimit();

    let attempt = 0;
    while (true) {
      try {
        const result = await fn();
        this.lastRequestTime = this.now();
        return result;
      } catch (error) {
        attempt++;
        const category = categorizeError(error, {
          transientCapMs: this.config.maxDelayMs,
        });

        if (category !== "transient" || attempt > this.config.maxRetries) {
          throw error;
        }

        // Honor a short reset hint if the provider gave one; else back off.
        const hint =
          error instanceof AiProviderError ? error.retryAfterMs : undefined;
        const delay =
          hint !== undefined && hint <= this.config.maxDelayMs
            ? hint + 100
            : this.calculateBackoff(attempt);
        await this.sleep(delay);
      }
    }
  }

  private async waitForRateLimit(): Promise<void> {
    const now = this.now();
    const sinceLast = now - this.lastRequestTime;
    const waitTime = Math.max(0, this.minIntervalMs - sinceLast);
    if (waitTime > 0) {
      await this.sleep(waitTime);
    }
  }

  /** Exponential backoff with 30% jitter, capped at maxDelayMs. */
  private calculateBackoff(attempt: number): number {
    const exponential = this.config.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = this.rng() * 0.3 * exponential;
    return Math.floor(Math.min(exponential + jitter, this.config.maxDelayMs));
  }
}
