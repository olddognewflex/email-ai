import { LlmRequest, LlmResponse } from "@email-ai/shared";
import { BaseLlmProvider } from "./base.provider";

interface AnthropicResponse {
  content: Array<{
    type: string;
    text: string;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  error?: {
    message: string;
  };
}

export class AnthropicProvider implements BaseLlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly apiEndpoint = "https://api.anthropic.com/v1",
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await fetch(`${this.apiEndpoint}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: request.maxTokens ?? 1000,
        temperature: request.temperature ?? 0.3,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.prompt }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return {
        content: "",
        error: `Anthropic API error: ${response.status} - ${error}`,
      };
    }

    const data = (await response.json()) as AnthropicResponse;

    if (data.error) {
      return {
        content: "",
        error: `Anthropic API error: ${data.error.message}`,
      };
    }

    const content = data.content?.[0]?.text ?? "";

    return {
      content,
      usage: data.usage
        ? {
            promptTokens: data.usage.input_tokens,
            completionTokens: data.usage.output_tokens,
            totalTokens: data.usage.input_tokens + data.usage.output_tokens,
          }
        : undefined,
    };
  }
}
