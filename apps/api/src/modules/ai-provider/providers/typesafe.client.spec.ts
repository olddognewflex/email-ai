import { TypeSafeJudgeRequest } from "@email-ai/shared";
import { TypeSafeClient } from "./typesafe.client";
import {
  AiProviderError,
  InvalidProviderResponseError,
} from "../ai-provider.error";

const request: TypeSafeJudgeRequest = {
  state: { email: { subject: "Hello" } },
  questions: {
    kind: {
      type: "choice",
      instructions: "What kind of email is `email.subject`?",
      criteria: { greeting: "A greeting", other: "Anything else" },
    },
  },
};

const validBody = {
  model: "jev-1.13.0",
  answers: {
    kind: {
      type: "choice",
      choice: "greeting",
      confidence: 0.9,
      probabilities: { greeting: 0.95, other: 0.05 },
    },
  },
  usage: { input_tokens: 120, output_tokens: 3 },
};

describe("TypeSafeClient", () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  const mockFetch = (res: Response) => {
    fetchMock = jest.fn().mockResolvedValue(res);
    global.fetch = fetchMock as unknown as typeof fetch;
  };

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("POSTs state + model + questions to /v1/systemone with bearer auth", async () => {
    mockFetch(new Response(JSON.stringify(validBody), { status: 200 }));
    const client = new TypeSafeClient("ts-key", "jev-latest");

    await client.judge(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer ts-key",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      state: request.state,
      model: "jev-latest",
      questions: request.questions,
    });
  });

  it("honours a custom base URL (trailing slash tolerated)", async () => {
    mockFetch(new Response(JSON.stringify(validBody), { status: 200 }));
    const client = new TypeSafeClient("k", "jev-latest", "https://ts.local/");

    await client.judge(request);

    expect(fetchMock.mock.calls[0][0]).toBe("https://ts.local/v1/systemone");
  });

  it("returns the Zod-validated response plus the exact raw body", async () => {
    const raw = JSON.stringify(validBody);
    mockFetch(new Response(raw, { status: 200 }));
    const client = new TypeSafeClient("k", "jev-latest");

    const { response, rawBody } = await client.judge(request);

    expect(response.model).toBe("jev-1.13.0");
    expect(response.answers.kind).toEqual(validBody.answers.kind);
    expect(response.usage).toEqual({ input_tokens: 120, output_tokens: 3 });
    expect(rawBody).toBe(raw);
  });

  it("keeps unknown fields in rawBody even though Zod strips them", async () => {
    const raw = JSON.stringify({ ...validBody, trace_id: "abc" });
    mockFetch(new Response(raw, { status: 200 }));
    const client = new TypeSafeClient("k", "jev-latest");

    const { response, rawBody } = await client.judge(request);

    expect(response).not.toHaveProperty("trace_id");
    expect(JSON.parse(rawBody).trace_id).toBe("abc");
  });

  it("a 422 throws AiProviderError with status 422 and the body", async () => {
    mockFetch(new Response('{"detail":"state too large"}', { status: 422 }));
    const client = new TypeSafeClient("k", "jev-latest");

    await expect(client.judge(request)).rejects.toMatchObject({
      name: "AiProviderError",
      status: 422,
      body: '{"detail":"state too large"}',
    });
  });

  it("a 429 throws AiProviderError carrying retryAfterMs", async () => {
    mockFetch(
      new Response('{"error":"rate limited"}', {
        status: 429,
        headers: { "retry-after": "8" },
      }),
    );
    const client = new TypeSafeClient("k", "jev-latest");

    let thrown: unknown;
    try {
      await client.judge(request);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AiProviderError);
    const err = thrown as AiProviderError;
    expect(err.provider).toBe("typesafe");
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(8000);
  });

  it("a 529 (overloaded) throws AiProviderError with status 529", async () => {
    mockFetch(new Response("overloaded", { status: 529 }));
    const client = new TypeSafeClient("k", "jev-latest");

    await expect(client.judge(request)).rejects.toMatchObject({
      name: "AiProviderError",
      status: 529,
      provider: "typesafe",
    });
  });

  it("a 2xx with a malformed answer throws InvalidProviderResponseError", async () => {
    const bad = {
      ...validBody,
      answers: { kind: { type: "choice", choice: "greeting" } }, // no probs
    };
    mockFetch(new Response(JSON.stringify(bad), { status: 200 }));
    const client = new TypeSafeClient("k", "jev-latest");

    let thrown: unknown;
    try {
      await client.judge(request);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(InvalidProviderResponseError);
    const err = thrown as InvalidProviderResponseError;
    expect(err.message).toMatch(/failed validation/);
    expect(err.rawBody).toBe(JSON.stringify(bad));
  });

  it("a 2xx with a non-JSON body throws InvalidProviderResponseError", async () => {
    mockFetch(new Response("<html>oops</html>", { status: 200 }));
    const client = new TypeSafeClient("k", "jev-latest");

    await expect(client.judge(request)).rejects.toBeInstanceOf(
      InvalidProviderResponseError,
    );
  });
});
