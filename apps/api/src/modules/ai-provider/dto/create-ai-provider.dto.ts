import { AiProviderType } from "@email-ai/shared";

export interface CreateAiProviderDto {
  provider: AiProviderType;
  apiKey: string;
  apiEndpoint?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}
