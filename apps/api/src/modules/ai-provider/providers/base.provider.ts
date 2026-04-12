import { LlmRequest, LlmResponse } from "@email-ai/shared";

export interface BaseLlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
}
