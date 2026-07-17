import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { ErrorCategory } from "./ai-provider.error";

/**
 * Persisted circuit breaker for AI calls.
 *
 * The email-ai pipeline is triggered by launchd, which fires a *fresh
 * process every hour*. An in-memory backoff counter would reset to zero on
 * every wake and buy nothing — so this breaker persists its state to a JSON
 * file and is consulted at the very start of each run. When the state is
 * open, the run skips AI work entirely instead of firing one doomed request
 * per email against an exhausted quota.
 *
 * State machine:
 *   closed     → calls flow normally.
 *   open       → calls are skipped until `nextAllowedAttempt`.
 *   half_open  → the open window elapsed; exactly one probe is allowed. On
 *                success the breaker closes; on failure it re-opens with the
 *                next backoff step.
 */

export type BreakerStatus = "closed" | "open" | "half_open";

export interface BreakerState {
  status: BreakerStatus;
  reason?: ErrorCategory;
  /** ISO timestamp; calls are skipped until now >= this. */
  nextAllowedAttempt?: string;
  consecutiveFailures: number;
  provider?: string;
  lastError?: string;
  updatedAt: string;
}

export interface BreakerFailureInfo {
  resetAt?: number;
  retryAfterMs?: number;
  provider?: string;
  error?: string;
}

export interface CircuitBreakerOptions {
  statePath?: string;
  /** Exponential-backoff base used when a quota error carries no reset hint. */
  quotaBaseDelayMs?: number;
  /** Cap for quota backoff, and how long an auth/config error is held. */
  quotaMaxDelayMs?: number;
  /** Short hold applied when in-run transient retries are exhausted. */
  transientHoldMs?: number;
  /** Guard applied on the open→half_open transition so only one probe fires. */
  probeGuardMs?: number;
  now?: () => number;
  rng?: () => number;
}

const DEFAULT_STATE_PATH = join(
  homedir(),
  ".local/state/email-ai/ai-breaker.json",
);

export const CLOSED_STATE: BreakerState = {
  status: "closed",
  consecutiveFailures: 0,
  updatedAt: new Date(0).toISOString(),
};

export class CircuitBreaker {
  private readonly statePath: string;
  private readonly quotaBaseDelayMs: number;
  private readonly quotaMaxDelayMs: number;
  private readonly transientHoldMs: number;
  private readonly probeGuardMs: number;
  private readonly now: () => number;
  private readonly rng: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.statePath =
      opts.statePath ?? process.env.AI_BREAKER_STATE_PATH ?? DEFAULT_STATE_PATH;
    this.quotaBaseDelayMs =
      opts.quotaBaseDelayMs ??
      (Number(process.env.AI_QUOTA_BASE_DELAY_MS) || 60_000);
    this.quotaMaxDelayMs =
      opts.quotaMaxDelayMs ??
      (Number(process.env.AI_QUOTA_MAX_DELAY_MS) || 12 * 60 * 60 * 1000);
    this.transientHoldMs =
      opts.transientHoldMs ??
      (Number(process.env.AI_TRANSIENT_HOLD_MS) || 60_000);
    this.probeGuardMs = opts.probeGuardMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.rng = opts.rng ?? Math.random;
  }

  /** Read persisted state without mutating it (safe for status checks). */
  peek(): BreakerState {
    try {
      const raw = readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as BreakerState;
      if (parsed && typeof parsed.status === "string") {
        return parsed;
      }
    } catch {
      // Missing or corrupt file → treat as closed.
    }
    return { ...CLOSED_STATE };
  }

  /** True if AI calls should currently be skipped. */
  isOpen(state: BreakerState = this.peek()): boolean {
    if (state.status === "closed") return false;
    if (!state.nextAllowedAttempt) return true;
    return this.now() < Date.parse(state.nextAllowedAttempt);
  }

  /**
   * Decide whether a call may proceed. If the open window has elapsed, this
   * transitions the breaker to half_open and persists a short probe guard so
   * exactly one probe fires (even across a crash/restart).
   */
  canAttempt(): { allowed: boolean; state: BreakerState } {
    const state = this.peek();
    if (state.status === "closed") {
      return { allowed: true, state };
    }

    const readyAt = state.nextAllowedAttempt
      ? Date.parse(state.nextAllowedAttempt)
      : 0;
    if (this.now() >= readyAt) {
      const probed: BreakerState = {
        ...state,
        status: "half_open",
        nextAllowedAttempt: new Date(
          this.now() + this.probeGuardMs,
        ).toISOString(),
        updatedAt: new Date(this.now()).toISOString(),
      };
      this.save(probed);
      return { allowed: true, state: probed };
    }

    return { allowed: false, state };
  }

  /** Close the breaker after a successful call. */
  recordSuccess(): void {
    this.save({
      status: "closed",
      consecutiveFailures: 0,
      updatedAt: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Open the breaker after a failure. The delay depends on the category:
   *   quota → sleep until the provider's reset (or persisted exp backoff),
   *   auth  → held for quotaMaxDelayMs (stop & alert; needs manual attention),
   *   other → brief transient hold.
   */
  recordFailure(
    category: ErrorCategory,
    info: BreakerFailureInfo = {},
  ): BreakerState {
    const prev = this.peek();
    const consecutiveFailures = prev.consecutiveFailures + 1;
    const now = this.now();
    let delayMs: number;

    if (category === "auth") {
      delayMs = this.quotaMaxDelayMs;
    } else if (category === "quota") {
      if (info.resetAt && info.resetAt > now) {
        delayMs = info.resetAt - now;
      } else if (info.retryAfterMs && info.retryAfterMs > 0) {
        delayMs = info.retryAfterMs;
      } else {
        delayMs = this.expBackoff(consecutiveFailures);
      }
      delayMs = Math.min(delayMs, this.quotaMaxDelayMs);
    } else {
      delayMs = Math.min(
        this.expBackoff(consecutiveFailures),
        this.transientHoldMs,
      );
    }

    const next: BreakerState = {
      status: "open",
      reason: category,
      nextAllowedAttempt: new Date(now + delayMs).toISOString(),
      consecutiveFailures,
      provider: info.provider ?? prev.provider,
      lastError: info.error,
      updatedAt: new Date(now).toISOString(),
    };
    this.save(next);
    return next;
  }

  /** Manually clear the breaker (e.g. after fixing an auth/config error). */
  reset(): void {
    this.recordSuccess();
  }

  private expBackoff(failures: number): number {
    const base =
      this.quotaBaseDelayMs * Math.pow(2, Math.max(0, failures - 1));
    const jitter = base * 0.3 * this.rng();
    return Math.min(base + jitter, this.quotaMaxDelayMs);
  }

  private save(state: BreakerState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    writeFileSync(this.statePath, JSON.stringify(state, null, 2));
  }
}
