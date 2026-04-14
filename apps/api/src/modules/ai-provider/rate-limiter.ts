/**
 * Rate limiter with exponential backoff for API calls.
 * Implements token bucket algorithm with retry logic for 429 errors.
 */
export interface RateLimiterConfig {
  requestsPerMinute: number;
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimiterConfig = {
  requestsPerMinute: 20, // Conservative default for most providers
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60000,
};

export interface RateLimitInfo {
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export class RateLimiter {
  private lastRequestTime = 0;
  private minIntervalMs: number;

  constructor(private config: RateLimiterConfig = DEFAULT_RATE_LIMIT) {
    this.minIntervalMs = (60 * 1000) / config.requestsPerMinute;
  }

  /**
   * Execute a function with rate limiting and exponential backoff.
   */
  async execute<T>(
    fn: () => Promise<T>,
    getRetryAfter?: (error: unknown) => number | undefined,
  ): Promise<T> {
    await this.waitForRateLimit();

    let attempt = 0;

    while (true) {
      try {
        const result = await fn();
        this.lastRequestTime = Date.now();
        return result;
      } catch (error) {
        attempt++;

        if (attempt > this.config.maxRetries) {
          throw error;
        }

        // Check for rate limit error and get retry delay
        const retryDelay = getRetryAfter?.(error);

        if (retryDelay !== undefined && retryDelay > 0) {
          this.logger.debug(
            `Rate limited, waiting ${retryDelay}ms before retry ${attempt}`,
          );
          await this.delay(retryDelay + 100); // Add buffer
        } else if (this.isRateLimitError(error)) {
          const backoffDelay = this.calculateBackoff(attempt);
          this.logger.debug(
            `Rate limit error, backing off ${backoffDelay}ms before retry ${attempt}`,
          );
          await this.delay(backoffDelay);
        } else {
          // Non-rate-limit error, rethrow immediately
          throw error;
        }
      }
    }
  }

  /**
   * Wait for the rate limit interval to pass.
   */
  private async waitForRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const waitTime = Math.max(0, this.minIntervalMs - timeSinceLastRequest);

    if (waitTime > 0) {
      this.logger.debug(`Rate limit: waiting ${waitTime.toFixed(0)}ms`);
      await this.delay(waitTime);
    }
  }

  /**
   * Calculate exponential backoff delay with jitter.
   */
  private calculateBackoff(attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 0.3 * exponentialDelay; // 30% jitter
    const delay = Math.min(exponentialDelay + jitter, this.config.maxDelayMs);
    return Math.floor(delay);
  }

  /**
   * Check if error is a rate limit error (429).
   */
  private isRateLimitError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return (
        message.includes("429") ||
        message.includes("rate limit") ||
        message.includes("rate_limit") ||
        message.includes("too many requests")
      );
    }
    return false;
  }

  /**
   * Simple delay promise.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private get logger() {
    return {
      debug: (message: string) => {
        if (process.env.NODE_ENV === "development") {
          console.debug(`[RateLimiter] ${message}`);
        }
      },
    };
  }
}

/**
 * Parse retry-after header or error message for delay in milliseconds.
 */
export function parseRetryAfter(error: unknown): number | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  const message = error.message;

  // Look for retry-after in seconds (e.g., "Please try again in 5.976s")
  const secondsMatch = message.match(/try again in ([\d.]+)s/i);
  if (secondsMatch) {
    const seconds = parseFloat(secondsMatch[1]);
    if (!isNaN(seconds)) {
      return Math.ceil(seconds * 1000);
    }
  }

  // Look for milliseconds
  const msMatch = message.match(/try again in ([\d.]+)ms/i);
  if (msMatch) {
    const ms = parseFloat(msMatch[1]);
    if (!isNaN(ms)) {
      return Math.ceil(ms);
    }
  }

  // Look for "Retry-After: <seconds>" header format
  const headerMatch = message.match(/retry-after[:\s]+(\d+)/i);
  if (headerMatch) {
    const seconds = parseInt(headerMatch[1], 10);
    if (!isNaN(seconds)) {
      return seconds * 1000;
    }
  }

  return undefined;
}
