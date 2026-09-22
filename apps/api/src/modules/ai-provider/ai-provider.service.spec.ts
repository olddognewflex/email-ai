import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { TypeSafeJudgeRequest } from "@email-ai/shared";
import { DatabaseService } from "../database/database.service";
import { AiProviderService } from "./ai-provider.service";
import {
  AiProviderConfigError,
  AiProviderError,
  BreakerOpenError,
  InvalidProviderResponseError,
  ProviderRequestRejectedError,
} from "./ai-provider.error";
import { BreakerState } from "./circuit-breaker";

function dbConfig(provider: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `cfg-${provider}`,
    provider,
    apiKey: `${provider}-key`,
    apiEndpoint: null,
    model: provider === "typesafe" ? "jev-latest" : "gpt-4o",
    temperature: 0.3,
    maxTokens: 1000,
    isActive: true,
    isEnabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const judgeRequest: TypeSafeJudgeRequest = {
  state: { email: { subject: "hi" } },
  questions: {
    sensitive: { type: "noul", instructions: "Is `email.subject` sensitive?" },
  },
};

const okBody = JSON.stringify({
  model: "jev-1.13.0",
  answers: { sensitive: { type: "noul", noul: 0.1 } },
  usage: { input_tokens: 10, output_tokens: 1 },
});

const openAiOk = JSON.stringify({
  choices: [{ message: { content: "classified" } }],
});

describe("AiProviderService", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };
  let dir: string;
  let statePath: string;
  let fetchMock: jest.Mock;

  function makeService(active: ReturnType<typeof dbConfig> | null) {
    const db = {
      aiProviderConfig: {
        findFirst: jest.fn().mockResolvedValue(active),
        update: jest
          .fn()
          .mockImplementation(({ data }: { data: object }) =>
            Promise.resolve({ ...active, ...data }),
          ),
        delete: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new AiProviderService(db as unknown as DatabaseService);
    return { service, db };
  }

  const readState = (): BreakerState =>
    JSON.parse(readFileSync(statePath, "utf8")) as BreakerState;

  const writeState = (state: Partial<BreakerState>) =>
    writeFileSync(
      statePath,
      JSON.stringify({
        consecutiveFailures: 1,
        updatedAt: new Date().toISOString(),
        ...state,
      }),
    );

  /** Breaker whose open window has elapsed: canAttempt() would go half_open. */
  const writeElapsedOpenState = () =>
    writeState({
      status: "open",
      reason: "unknown",
      nextAllowedAttempt: new Date(Date.now() - 1_000).toISOString(),
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "eai-aiprov-"));
    statePath = join(dir, "ai-breaker.json");
    process.env.AI_BREAKER_STATE_PATH = statePath;
    // Effectively no request spacing so tests stay fast.
    process.env.AI_REQUESTS_PER_MINUTE = "600000";
    fetchMock = jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(okBody, { status: 200 })),
      );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  describe("judge()", () => {
    it("rejects with AiProviderConfigError when the active provider isn't typesafe", async () => {
      const { service } = makeService(dbConfig("openai"));

      await expect(service.judge(judgeRequest)).rejects.toBeInstanceOf(
        AiProviderConfigError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(service.getBreakerStatus().open).toBe(false);
    });

    it("throws the config error before consulting the breaker (no half_open probe consumed)", async () => {
      writeElapsedOpenState();
      const { service } = makeService(dbConfig("openai"));

      await expect(service.judge(judgeRequest)).rejects.toBeInstanceOf(
        AiProviderConfigError,
      );
      expect(readState().status).toBe("open");
    });

    it("rejects when no provider is active", async () => {
      const { service } = makeService(null);
      await expect(service.judge(judgeRequest)).rejects.toThrow(/active: none/);
    });

    it("calls TypeSafe with the stored key/model and returns response + raw body", async () => {
      const { service } = makeService(dbConfig("typesafe"));

      const { response, rawBody } = await service.judge(judgeRequest);

      expect(response.answers.sensitive).toEqual({ type: "noul", noul: 0.1 });
      expect(rawBody).toBe(okBody);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.typesafe.ai/v1/systemone");
      expect((init.headers as Record<string, string>).Authorization).toBe(
        "Bearer typesafe-key",
      );
      expect(JSON.parse(init.body as string).model).toBe("jev-latest");
    });

    it("uses a configured apiEndpoint as the base URL", async () => {
      const { service } = makeService(
        dbConfig("typesafe", { apiEndpoint: "https://ts.internal" }),
      );
      await service.judge(judgeRequest);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://ts.internal/v1/systemone",
      );
    });

    it("rebuilds the cached client after updateConfig", async () => {
      const { service, db } = makeService(dbConfig("typesafe"));
      await service.judge(judgeRequest);

      await service.updateConfig("cfg-typesafe", { apiKey: "rotated" });
      db.aiProviderConfig.findFirst.mockResolvedValue(
        dbConfig("typesafe", { apiKey: "rotated" }),
      );
      await service.judge(judgeRequest);

      const auth = (i: number) =>
        (
          (fetchMock.mock.calls[i] as [string, RequestInit])[1]
            .headers as Record<string, string>
        ).Authorization;
      expect(auth(0)).toBe("Bearer typesafe-key");
      expect(auth(1)).toBe("Bearer rotated");
    });

    it("a 401 opens the breaker (auth) and the next call short-circuits", async () => {
      const { service } = makeService(dbConfig("typesafe"));
      fetchMock.mockResolvedValueOnce(new Response("bad key", { status: 401 }));

      await expect(service.judge(judgeRequest)).rejects.toBeInstanceOf(
        AiProviderError,
      );
      expect(service.getBreakerStatus()).toMatchObject({
        open: true,
        reason: "auth",
      });

      await expect(service.judge(judgeRequest)).rejects.toBeInstanceOf(
        BreakerOpenError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("a 422 becomes ProviderRequestRejectedError, is not retried, and closes the breaker", async () => {
      writeElapsedOpenState(); // the 422 is the half-open probe
      const { service } = makeService(dbConfig("typesafe"));
      fetchMock.mockResolvedValueOnce(
        new Response('{"detail":"state too large"}', { status: 422 }),
      );

      let thrown: unknown;
      try {
        await service.judge(judgeRequest);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(ProviderRequestRejectedError);
      expect(thrown).toMatchObject({
        provider: "typesafe",
        status: 422,
        body: '{"detail":"state too large"}',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(readState().status).toBe("closed");
    });

    it("a non-JSON 2xx (unparseable) records a breaker failure: systemic", async () => {
      const { service } = makeService(dbConfig("typesafe"));
      fetchMock.mockResolvedValueOnce(
        new Response("<html>captive portal</html>", { status: 200 }),
      );

      await expect(service.judge(judgeRequest)).rejects.toMatchObject({
        name: "InvalidProviderResponseError",
        kind: "unparseable",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(service.getBreakerStatus()).toMatchObject({
        open: true,
        reason: "unknown",
      });
      // The next call short-circuits without a network request.
      await expect(service.judge(judgeRequest)).rejects.toBeInstanceOf(
        BreakerOpenError,
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("schema-invalid JSON (invalid_shape) is per-request: breaker success, next call proceeds", async () => {
      writeElapsedOpenState(); // this call is the half-open probe
      const { service } = makeService(dbConfig("typesafe"));
      fetchMock.mockResolvedValueOnce(
        new Response('{"model":"jev","answers":{"x":{"type":"noul"}}}', {
          status: 200,
        }),
      );

      await expect(service.judge(judgeRequest)).rejects.toMatchObject({
        name: "InvalidProviderResponseError",
        kind: "invalid_shape",
      });
      expect(readState().status).toBe("closed");

      await expect(service.judge(judgeRequest)).resolves.toBeDefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("judgeWith: an interpret failure becomes invalid_shape and does not hold the breaker", async () => {
      const { service } = makeService(dbConfig("typesafe"));

      let thrown: unknown;
      try {
        await service.judgeWith(judgeRequest, () => {
          throw new Error("label outside enum");
        });
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(InvalidProviderResponseError);
      const err = thrown as InvalidProviderResponseError;
      expect(err.kind).toBe("invalid_shape");
      expect(err.message).toMatch(/label outside enum/);
      expect(err.rawBody).toBe(okBody);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(service.getBreakerStatus().open).toBe(false);
    });

    it.each([
      ["a 422", () => new Response('{"detail":"bad"}', { status: 422 })],
      [
        "a schema-invalid body",
        () =>
          new Response('{"model":"jev","answers":{"x":{"type":"noul"}}}', {
            status: 200,
          }),
      ],
    ])(
      "%s on the half-open probe of a QUOTA breaker leaves the probe to expire",
      async (_label, makeResponse) => {
        writeState({
          status: "open",
          reason: "quota",
          nextAllowedAttempt: new Date(Date.now() - 1_000).toISOString(),
        });
        const { service } = makeService(dbConfig("typesafe"));
        fetchMock.mockResolvedValueOnce(makeResponse());

        await expect(service.judge(judgeRequest)).rejects.toThrow();

        const state = readState();
        expect(state.reason).toBe("quota");
        expect(state.status).not.toBe("closed");
      },
    );

    it("judgeWith returns the interpreted value on success", async () => {
      const { service } = makeService(dbConfig("typesafe"));
      const model = await service.judgeWith(
        judgeRequest,
        (r) => r.response.model,
      );
      expect(model).toBe("jev-1.13.0");
      expect(service.getBreakerStatus().open).toBe(false);
    });
  });

  describe("complete()", () => {
    it("rejects for a typesafe config instead of falling back to mock", async () => {
      const { service } = makeService(dbConfig("typesafe"));

      await expect(service.complete({ prompt: "hi" })).rejects.toThrow(
        /does not support free-text completion/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(service.getBreakerStatus().open).toBe(false);
    });

    it("throws the typesafe config error before consulting the breaker", async () => {
      writeElapsedOpenState();
      const { service } = makeService(dbConfig("typesafe"));

      await expect(service.complete({ prompt: "hi" })).rejects.toBeInstanceOf(
        AiProviderConfigError,
      );
      expect(readState().status).toBe("open");
    });

    it("still uses the mock provider when nothing is active", async () => {
      const { service } = makeService(null);
      const res = await service.complete({ prompt: "Your receipt for order" });
      expect(res.content).toEqual(expect.any(String));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("an open breaker with no active config still throws BreakerOpenError", async () => {
      writeState({
        status: "open",
        reason: "quota",
        nextAllowedAttempt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const { service } = makeService(null);

      await expect(service.complete({ prompt: "hi" })).rejects.toBeInstanceOf(
        BreakerOpenError,
      );
    });

    it("LLM provider: a 429 with a long retry-after opens the breaker as quota", async () => {
      const { service } = makeService(dbConfig("openai"));
      fetchMock.mockResolvedValueOnce(
        new Response('{"error":{"message":"quota"}}', {
          status: 429,
          headers: { "retry-after": "3600" },
        }),
      );

      await expect(service.complete({ prompt: "hi" })).rejects.toMatchObject({
        name: "AiProviderError",
        status: 429,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1); // quota is not retried in-run
      const status = service.getBreakerStatus();
      expect(status).toMatchObject({ open: true, reason: "quota" });
      const until = Date.parse(status.nextAllowedAttempt!);
      expect(until - Date.now()).toBeGreaterThan(3_500_000);
    });

    it("LLM provider: a transient 5xx is retried in-run and then succeeds", async () => {
      const { service } = makeService(dbConfig("openai"));
      fetchMock
        .mockResolvedValueOnce(
          new Response("unavailable", {
            status: 503,
            headers: { "retry-after": "0" },
          }),
        )
        .mockResolvedValueOnce(new Response(openAiOk, { status: 200 }));

      const res = await service.complete({ prompt: "hi" });

      expect(res.content).toBe("classified");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://api.openai.com/v1/chat/completions",
      );
      expect(service.getBreakerStatus().open).toBe(false);
    });
  });
});
