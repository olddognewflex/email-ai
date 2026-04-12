import { AiProviderType } from "@email-ai/shared";

export interface UpdateAiProviderDto {
  apiKey?: string;
  apiEndpoint?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}
