import {
  TypeSafeJudgeRequest,
  TypeSafeResponse,
  TypeSafeResponseSchema,
} from "@email-ai/shared";
import {
  InvalidProviderResponseError,
  throwIfNotOk,
} from "../ai-provider.error";

export const TYPESAFE_DEFAULT_BASE_URL = "https://api.typesafe.ai";

/** Cap on the raw body carried by a validation error (audit trail only). */
const MAX_RAW_BODY = 10_000;

/** A validated TypeSafe answer plus the exact body text, for audit. */
export interface TypeSafeJudgeResult {
  response: TypeSafeResponse;
  /** Raw HTTP response body, exactly as received. */
  rawBody: string;
}

/**
 * Hand-written client for the TypeSafe "System One" judgment API.
 *
 * Deliberately NOT a `BaseLlmProvider`: TypeSafe takes state + typed
 * questions and returns typed answers with probabilities, so it has its own
 * contract (`judge`) rather than free-text `complete`. Like every adapter it
 * uses plain `fetch` (no vendor SDK) and routes non-2xx responses through
 * `throwIfNotOk` so 429/529 reach the rate limiter and breaker as typed
 * `AiProviderError`s.
 */
export class TypeSafeClient {
  private readonly baseURL: string;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    baseURL: string = TYPESAFE_DEFAULT_BASE_URL,
  ) {
    this.baseURL = baseURL.replace(/\/+$/, "");
  }

  async judge(request: TypeSafeJudgeRequest): Promise<TypeSafeJudgeResult> {
    const response = await fetch(`${this.baseURL}/v1/systemone`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        state: request.state,
        model: this.model,
        questions: request.questions,
      }),
    });

    await throwIfNotOk(response, "typesafe");

    const text = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new InvalidProviderResponseError(
        "typesafe",
        "unparseable",
        `TypeSafe response is not valid JSON: ${text.slice(0, 200)}`,
        text.slice(0, MAX_RAW_BODY),
      );
    }

    const result = TypeSafeResponseSchema.safeParse(data);
    if (!result.success) {
      throw new InvalidProviderResponseError(
        "typesafe",
        "invalid_shape",
        `TypeSafe response failed validation: ${result.error.errors
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join(", ")}`,
        text.slice(0, MAX_RAW_BODY),
      );
    }
    return { response: result.data, rawBody: text };
  }
}
