import { RateLimiter, RateLimiterConfig } from "./rate-limiter";
import { AiProviderError } from "./ai-provider.error";

const CONFIG: RateLimiterConfig = {
  requestsPerMinute: 6000, // effectively no spacing wait in tests
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 60_000,
};

describe("RateLimiter", () => {
  let slept: number[];

  const makeLimiter = (config: RateLimiterConfig = CONFIG) =>
    new RateLimiter(config, {
      // Large fixed clock so the request-spacing wait never fires (the
      // limiter sees a long gap since lastRequestTime=0).
      now: () => 1_000_000_000,
      rng: () => 0,
      sleep: async (ms: number) => {
        slept.push(ms);
      },
    });

  beforeEach(() => {
    slept = [];
  });

  it("returns the result when fn succeeds first try", async () => {
    const limiter = makeLimiter();
    const fn = jest.fn().mockResolvedValue("ok");
    await expect(limiter.execute(fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a transient (5xx) error, then succeeds", async () => {
    const limiter = makeLimiter();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new AiProviderError({ provider: "k", status: 500 }))
      .mockRejectedValueOnce(new AiProviderError({ provider: "k", status: 503 }))
      .mockResolvedValue("recovered");
    await expect(limiter.execute(fn)).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(slept.length).toBe(2); // two backoffs
  });

  it("does NOT retry a quota 429 — it rethrows immediately", async () => {
    const limiter = makeLimiter();
    const quota = new AiProviderError({
      provider: "kimi",
      status: 429,
      retryAfterMs: 3 * 60 * 60 * 1000, // long → quota
    });
    const fn = jest.fn().mockRejectedValue(quota);
    await expect(limiter.execute(fn)).rejects.toBe(quota);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it("does NOT retry an auth 401 — it rethrows immediately", async () => {
    const limiter = makeLimiter();
    const auth = new AiProviderError({ provider: "kimi", status: 401 });
    const fn = jest.fn().mockRejectedValue(auth);
    await expect(limiter.execute(fn)).rejects.toBe(auth);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxRetries transient failures", async () => {
    const limiter = makeLimiter();
    const fn = jest
      .fn()
      .mockRejectedValue(new AiProviderError({ provider: "k", status: 500 }));
    await expect(limiter.execute(fn)).rejects.toBeInstanceOf(AiProviderError);
    // 1 initial + maxRetries
    expect(fn).toHaveBeenCalledTimes(CONFIG.maxRetries + 1);
  });

  it("honors a short Retry-After hint instead of computed backoff", async () => {
    const limiter = makeLimiter();
    const fn = jest
      .fn()
      .mockRejectedValueOnce(
        new AiProviderError({ provider: "k", status: 429, retryAfterMs: 5_000 }),
      )
      .mockResolvedValue("ok");
    await expect(limiter.execute(fn)).resolves.toBe("ok");
    expect(slept).toEqual([5_100]); // hint + 100ms buffer
  });
});
