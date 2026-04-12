import { LlmRequest, LlmResponse } from "@email-ai/shared";
import { BaseLlmProvider } from "./base.provider";

interface MistralResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class MistralProvider implements BaseLlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly apiEndpoint = "https://api.mistral.ai/v1",
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const messages: Array<{ role: string; content: string }> = [];

    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }

    messages.push({ role: "user", content: request.prompt });

    const response = await fetch(`${this.apiEndpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: request.temperature ?? 0.3,
        max_tokens: request.maxTokens ?? 1000,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        content: "",
        error: `Mistral API error: ${response.status} - ${error}`,
      };
    }

    const data = (await response.json()) as MistralResponse;
    const content = data.choices[0]?.message?.content ?? "";

    return {
      content,
      usage: data.usage
        ? {
            promptTokens: data.usage.prompt_tokens,
            completionTokens: data.usage.completion_tokens,
            totalTokens: data.usage.total_tokens,
          }
        : undefined,
    };
  }
}
