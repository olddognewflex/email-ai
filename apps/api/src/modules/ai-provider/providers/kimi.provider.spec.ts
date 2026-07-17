import { readFileSync } from "fs";
import { join } from "path";
import { KimiProvider } from "./kimi.provider";
import { AiProviderError } from "../ai-provider.error";

const FIXTURES = join(__dirname, "..", "__fixtures__");

interface HttpFixture {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function responseFromFixture(name: string): Response {
  const fx = JSON.parse(
    readFileSync(join(FIXTURES, name), "utf8"),
  ) as HttpFixture;
  return new Response(fx.body, { status: fx.status, headers: fx.headers });
}

describe("KimiProvider (regression: non-ok HTTP must throw, not resolve)", () => {
  const originalFetch = global.fetch;
  let provider: KimiProvider;

  beforeEach(() => {
    provider = new KimiProvider("test-key", "kimi-k2", "https://api.moonshot.cn/v1");
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const mockFetch = (res: Response) => {
    global.fetch = jest.fn().mockResolvedValue(res) as unknown as typeof fetch;
  };

  it("REGRESSION: a 500 rejects with AiProviderError (previously resolved to {error})", async () => {
    mockFetch(responseFromFixture("server-500.json"));
    await expect(provider.complete({ prompt: "hi" })).rejects.toBeInstanceOf(
      AiProviderError,
    );
  });

  it("a quota 429 throws carrying status + parsed reset hint", async () => {
    mockFetch(responseFromFixture("ratelimit-429-quota.json"));
    let thrown: unknown;
    try {
      await provider.complete({ prompt: "hi" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AiProviderError);
    const err = thrown as AiProviderError;
    expect(err.provider).toBe("kimi");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(12_600_000); // 3h30m0s
    expect(err.resetAt).toBeGreaterThan(Date.now());
  });

  it("the real captured 401 throws with status 401", async () => {
    mockFetch(responseFromFixture("moonshot-401-auth.json"));
    await expect(provider.complete({ prompt: "hi" })).rejects.toMatchObject({
      status: 401,
      provider: "kimi",
    });
  });

  it("a 200 response returns parsed content + usage", async () => {
    const body = JSON.stringify({
      choices: [{ message: { content: "classified" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    mockFetch(new Response(body, { status: 200 }));
    const result = await provider.complete({ prompt: "hi" });
    expect(result.content).toBe("classified");
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(result.error).toBeUndefined();
  });
});
