import { readFileSync } from "fs";
import { join } from "path";
import {
  AiProviderError,
  categorizeError,
  isNetworkError,
  parseDurationMs,
  parseRateLimitHeaders,
  throwIfNotOk,
} from "./ai-provider.error";

const NOW = 1_700_000_000_000;
const CAP = 60_000; // transient cap / 429 short-vs-quota threshold

interface HttpFixture {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function loadFixture(name: string): HttpFixture {
  return JSON.parse(
    readFileSync(join(__dirname, "__fixtures__", name), "utf8"),
  ) as HttpFixture;
}

function responseFromFixture(name: string): Response {
  const fx = loadFixture(name);
  return new Response(fx.body, { status: fx.status, headers: fx.headers });
}

describe("parseDurationMs", () => {
  it.each<[string, number]>([
    ["8s", 8000],
    ["150ms", 150],
    ["6m0s", 360000],
    ["2h3m", 7_380_000],
    ["3h30m0s", 12_600_000],
    ["8", 8000], // bare number = seconds
  ])("parses %s", (input: string, expected: number) => {
    expect(parseDurationMs(input)).toBe(expected);
  });

  it("returns undefined for junk", () => {
    expect(parseDurationMs("")).toBeUndefined();
    expect(parseDurationMs("soon")).toBeUndefined();
  });
});

describe("parseRateLimitHeaders", () => {
  it("honors Retry-After in seconds", () => {
    const h = new Headers({ "retry-after": "12" });
    expect(parseRateLimitHeaders(h, NOW)).toEqual({
      retryAfterMs: 12_000,
      resetAt: NOW + 12_000,
    });
  });

  it("honors Retry-After as an HTTP-date", () => {
    const when = new Date(NOW + 30_000).toUTCString();
    const h = new Headers({ "retry-after": when });
    const parsed = parseRateLimitHeaders(h, NOW);
    // HTTP-date has second precision, so allow a 1s slack.
    expect(parsed.retryAfterMs).toBeGreaterThanOrEqual(29_000);
    expect(parsed.retryAfterMs).toBeLessThanOrEqual(30_000);
  });

  it("takes the soonest of the x-ratelimit-reset-* durations", () => {
    const h = new Headers({
      "x-ratelimit-reset-requests": "3h30m0s",
      "x-ratelimit-reset-tokens": "45s",
    });
    expect(parseRateLimitHeaders(h, NOW)).toEqual({
      retryAfterMs: 45_000,
      resetAt: NOW + 45_000,
    });
  });

  it("treats a large x-ratelimit-reset as an absolute epoch", () => {
    const epochSecs = Math.floor(NOW / 1000) + 100;
    const h = new Headers({ "x-ratelimit-reset": String(epochSecs) });
    expect(parseRateLimitHeaders(h, NOW)).toEqual({
      retryAfterMs: 100_000,
      resetAt: epochSecs * 1000,
    });
  });

  it("returns empty when there are no rate-limit headers", () => {
    expect(parseRateLimitHeaders(new Headers(), NOW)).toEqual({});
  });
});

describe("categorizeError", () => {
  it("429 with a short reset hint is transient", () => {
    const err = new AiProviderError({
      provider: "kimi",
      status: 429,
      retryAfterMs: 8_000,
    });
    expect(categorizeError(err, { transientCapMs: CAP })).toBe("transient");
  });

  it("429 with a long reset hint is quota", () => {
    const err = new AiProviderError({
      provider: "kimi",
      status: 429,
      retryAfterMs: 3 * 60 * 60 * 1000,
    });
    expect(categorizeError(err, { transientCapMs: CAP })).toBe("quota");
  });

  it("429 with no hint is quota", () => {
    const err = new AiProviderError({ provider: "kimi", status: 429 });
    expect(categorizeError(err, { transientCapMs: CAP })).toBe("quota");
  });

  it("401 and other 4xx are auth/config errors", () => {
    for (const status of [400, 401, 403, 404]) {
      const err = new AiProviderError({ provider: "kimi", status });
      expect(categorizeError(err, { transientCapMs: CAP })).toBe("auth");
    }
  });

  it("5xx and 408 are transient", () => {
    for (const status of [500, 502, 503, 408]) {
      const err = new AiProviderError({ provider: "kimi", status });
      expect(categorizeError(err, { transientCapMs: CAP })).toBe("transient");
    }
  });

  it("timeouts and connection errors are transient", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    const refused = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(categorizeError(abort, { transientCapMs: CAP })).toBe("transient");
    expect(categorizeError(refused, { transientCapMs: CAP })).toBe("transient");
    expect(isNetworkError(abort)).toBe(true);
    expect(isNetworkError(refused)).toBe(true);
  });
});

describe("throwIfNotOk", () => {
  it("REGRESSION: a non-ok response throws instead of resolving", async () => {
    const res = responseFromFixture("server-500.json");
    await expect(throwIfNotOk(res, "kimi")).rejects.toBeInstanceOf(
      AiProviderError,
    );
  });

  it("carries status + parsed reset hint from a quota 429", async () => {
    const res = responseFromFixture("ratelimit-429-quota.json");
    await expect(throwIfNotOk(res, "kimi", NOW)).rejects.toMatchObject({
      status: 429,
      provider: "kimi",
      // 3h30m0s reset window
      retryAfterMs: 12_600_000,
      resetAt: NOW + 12_600_000,
    });
  });

  it("carries a short Retry-After from a transient 429", async () => {
    const res = responseFromFixture("ratelimit-429-retry-after.json");
    await expect(throwIfNotOk(res, "kimi", NOW)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 8_000,
    });
  });

  it("maps the real captured 401 to an auth category", async () => {
    const res = responseFromFixture("moonshot-401-auth.json");
    let thrown: unknown;
    try {
      await throwIfNotOk(res, "kimi");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AiProviderError);
    expect((thrown as AiProviderError).status).toBe(401);
    expect(categorizeError(thrown, { transientCapMs: CAP })).toBe("auth");
  });

  it("does nothing for an ok response", async () => {
    const res = new Response("{}", { status: 200 });
    await expect(throwIfNotOk(res, "kimi")).resolves.toBeUndefined();
  });
});
