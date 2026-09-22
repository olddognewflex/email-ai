import { LlmRequest, LlmResponse } from "@email-ai/shared";
import { BaseLlmProvider } from "./base.provider";
import { throwIfNotOk } from "../ai-provider.error";

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text: string;
      }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export class GoogleProvider implements BaseLlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {}

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const apiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const contents: Array<{ role: string; parts: Array<{ text: string }> }> =
      [];

    if (request.systemPrompt) {
      contents.push({
        role: "user",
        parts: [{ text: `System: ${request.systemPrompt}` }],
      });
    }

    contents.push({
      role: "user",
      parts: [{ text: request.prompt }],
    });

    const response = await fetch(apiEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents,
        generationConfig: {
          temperature: request.temperature ?? 0.3,
          maxOutputTokens: request.maxTokens ?? 1000,
        },
      }),
    });

    await throwIfNotOk(response, "google");

    const data = (await response.json()) as GeminiResponse;
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    return {
      content,
      usage: data.usageMetadata
        ? {
            promptTokens: data.usageMetadata.promptTokenCount,
            completionTokens: data.usageMetadata.candidatesTokenCount,
            totalTokens: data.usageMetadata.totalTokenCount,
          }
        : undefined,
    };
  }
}
