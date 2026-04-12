import { z } from "zod";

export const AiProviderTypeSchema = z.enum([
  "openai",
  "anthropic",
  "mistral",
  "google",
  "kimi",
  "deepseek",
  "mock",
]);

export type AiProviderType = z.infer<typeof AiProviderTypeSchema>;

export const AiProviderConfigSchema = z.object({
  id: z.string(),
  provider: AiProviderTypeSchema,
  apiKey: z.string(),
  apiEndpoint: z.string().url().optional(),
  model: z.string(),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().positive().default(1000),
  isActive: z.boolean().default(false),
  isEnabled: z.boolean().default(true),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type AiProviderConfig = z.infer<typeof AiProviderConfigSchema>;

export const CreateAiProviderConfigSchema = z.object({
  provider: AiProviderTypeSchema,
  apiKey: z.string().min(1, "API key is required"),
  apiEndpoint: z.string().url().optional(),
  model: z.string().min(1, "Model name is required"),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().positive().default(1000),
});

export type CreateAiProviderConfig = z.infer<
  typeof CreateAiProviderConfigSchema
>;

export const UpdateAiProviderConfigSchema =
  CreateAiProviderConfigSchema.partial();

export type UpdateAiProviderConfig = z.infer<
  typeof UpdateAiProviderConfigSchema
>;

export const AI_PROVIDER_METADATA: Record<
  AiProviderType,
  {
    displayName: string;
    defaultModel: string;
    availableModels: string[];
    docsUrl: string;
  }
> = {
  openai: {
    displayName: "OpenAI",
    defaultModel: "gpt-4o",
    availableModels: [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4-turbo",
      "gpt-4",
      "gpt-3.5-turbo",
    ],
    docsUrl: "https://platform.openai.com/docs",
  },
  anthropic: {
    displayName: "Anthropic (Claude)",
    defaultModel: "claude-3-5-sonnet-20241022",
    availableModels: [
      "claude-3-5-sonnet-20241022",
      "claude-3-opus-20240229",
      "claude-3-sonnet-20240229",
      "claude-3-haiku-20240307",
    ],
    docsUrl: "https://docs.anthropic.com",
  },
  mistral: {
    displayName: "Mistral AI",
    defaultModel: "mistral-large-latest",
    availableModels: [
      "mistral-large-latest",
      "mistral-medium-latest",
      "mistral-small-latest",
      "codestral-latest",
    ],
    docsUrl: "https://docs.mistral.ai",
  },
  google: {
    displayName: "Google (Gemini)",
    defaultModel: "gemini-1.5-flash",
    availableModels: ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-1.0-pro"],
    docsUrl: "https://ai.google.dev/docs",
  },
  kimi: {
    displayName: "Kimi (Moonshot)",
    defaultModel: "kimi-k2",
    availableModels: [
      "kimi-k2",
      "kimi-k2-0711-longcontext",
      "kimi-k2-0711-search",
    ],
    docsUrl: "https://platform.moonshot.cn/docs",
  },
  deepseek: {
    displayName: "DeepSeek",
    defaultModel: "deepseek-chat",
    availableModels: ["deepseek-chat", "deepseek-reasoner"],
    docsUrl: "https://platform.deepseek.com/docs",
  },
  mock: {
    displayName: "Mock Provider (Testing)",
    defaultModel: "mock",
    availableModels: ["mock"],
    docsUrl: "",
  },
};

export interface LlmRequest {
  prompt: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LlmResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  error?: string;
}

export function supportsSystemPrompt(provider: AiProviderType): boolean {
  return provider !== "mock";
}

export function requiresCustomEndpoint(provider: AiProviderType): boolean {
  return provider === "kimi" || provider === "deepseek";
}
