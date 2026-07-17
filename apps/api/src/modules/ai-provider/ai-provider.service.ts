import { Injectable, Logger } from "@nestjs/common";
import {
  AiProviderConfig,
  AiProviderType,
  AI_PROVIDER_METADATA,
  CreateAiProviderConfig,
  LlmRequest,
  LlmResponse,
  UpdateAiProviderConfig,
} from "@email-ai/shared";
import { DatabaseService } from "../database/database.service";
import {
  BaseLlmProvider,
  MockLlmProvider,
  OpenAiProvider,
  AnthropicProvider,
  MistralProvider,
  GoogleProvider,
  KimiProvider,
  DeepSeekProvider,
} from "./providers";
import { RateLimiter, RateLimiterConfig } from "./rate-limiter";
import {
  AiProviderError,
  BreakerOpenError,
  categorizeError,
} from "./ai-provider.error";
import { CircuitBreaker } from "./circuit-breaker";

@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);
  private providerInstances: Map<string, BaseLlmProvider> = new Map();
  private rateLimiter: RateLimiter;
  private breaker: CircuitBreaker;
  private transientCapMs: number;

  constructor(private readonly db: DatabaseService) {
    // The transient cap doubles as the 429 short-vs-quota threshold.
    this.transientCapMs = Number(process.env.AI_TRANSIENT_MAX_DELAY_MS) || 60000;
    const config: RateLimiterConfig = {
      requestsPerMinute: Number(process.env.AI_REQUESTS_PER_MINUTE) || 20,
      maxRetries: Number(process.env.AI_MAX_RETRIES) || 3,
      baseDelayMs: 1000,
      maxDelayMs: this.transientCapMs,
    };
    this.rateLimiter = new RateLimiter(config);
    this.breaker = new CircuitBreaker();
  }

  async getAllConfigs(): Promise<AiProviderConfig[]> {
    const configs = await this.db.aiProviderConfig.findMany({
      orderBy: { createdAt: "desc" },
    });

    return configs.map((c) => this.mapDbToConfig(c));
  }

  async getConfig(id: string): Promise<AiProviderConfig | null> {
    const config = await this.db.aiProviderConfig.findUnique({
      where: { id },
    });

    return config ? this.mapDbToConfig(config) : null;
  }

  async getConfigByProvider(
    provider: AiProviderType,
  ): Promise<AiProviderConfig | null> {
    const config = await this.db.aiProviderConfig.findUnique({
      where: { provider },
    });

    return config ? this.mapDbToConfig(config) : null;
  }

  async getActiveConfig(): Promise<AiProviderConfig | null> {
    const config = await this.db.aiProviderConfig.findFirst({
      where: { isActive: true, isEnabled: true },
    });

    return config ? this.mapDbToConfig(config) : null;
  }

  async createConfig(data: CreateAiProviderConfig): Promise<AiProviderConfig> {
    const existing = await this.db.aiProviderConfig.findUnique({
      where: { provider: data.provider },
    });

    if (existing) {
      throw new Error(
        `Provider ${data.provider} already configured. Use update instead.`,
      );
    }

    const config = await this.db.aiProviderConfig.create({
      data: {
        provider: data.provider,
        apiKey: data.apiKey,
        apiEndpoint: data.apiEndpoint,
        model: data.model,
        temperature: data.temperature,
        maxTokens: data.maxTokens,
        isEnabled: true,
        isActive: false,
      },
    });

    return this.mapDbToConfig(config);
  }

  async updateConfig(
    id: string,
    data: UpdateAiProviderConfig,
  ): Promise<AiProviderConfig> {
    const config = await this.db.aiProviderConfig.update({
      where: { id },
      data: {
        ...(data.apiKey && { apiKey: data.apiKey }),
        ...(data.apiEndpoint !== undefined && {
          apiEndpoint: data.apiEndpoint,
        }),
        ...(data.model && { model: data.model }),
        ...(data.temperature !== undefined && {
          temperature: data.temperature,
        }),
        ...(data.maxTokens !== undefined && { maxTokens: data.maxTokens }),
      },
    });

    this.providerInstances.delete(id);

    return this.mapDbToConfig(config);
  }

  async setActiveProvider(id: string): Promise<AiProviderConfig> {
    await this.db.$transaction([
      this.db.aiProviderConfig.updateMany({
        data: { isActive: false },
      }),
      this.db.aiProviderConfig.update({
        where: { id },
        data: { isActive: true, isEnabled: true },
      }),
    ]);

    const config = await this.db.aiProviderConfig.findUniqueOrThrow({
      where: { id },
    });

    return this.mapDbToConfig(config);
  }

  async deleteConfig(id: string): Promise<void> {
    await this.db.aiProviderConfig.delete({
      where: { id },
    });

    this.providerInstances.delete(id);
  }

  /**
   * Run an LLM completion behind the circuit breaker.
   *
   * On any provider failure this THROWS (it no longer resolves to
   * `{ content: "", error }`): transient errors are retried in-run by the
   * rate limiter, and quota/auth errors open the persisted breaker before
   * propagating. Callers should treat a throw as "no answer" and defer.
   */
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const gate = this.breaker.canAttempt();
    if (!gate.allowed) {
      throw new BreakerOpenError(
        gate.state.nextAllowedAttempt,
        gate.state.reason,
      );
    }

    const providerType = await this.getActiveProviderType();
    try {
      const provider = await this.getProviderInstance();
      const result = await this.rateLimiter.execute(() =>
        provider.complete(request),
      );
      this.breaker.recordSuccess();
      return result;
    } catch (error) {
      const category = categorizeError(error, {
        transientCapMs: this.transientCapMs,
      });
      const info =
        error instanceof AiProviderError
          ? {
              resetAt: error.resetAt,
              retryAfterMs: error.retryAfterMs,
              provider: error.provider,
              error: error.message,
            }
          : {
              provider: providerType ?? undefined,
              error: error instanceof Error ? error.message : String(error),
            };
      const state = this.breaker.recordFailure(category, info);
      if (category === "auth") {
        this.logger.error(
          `AI ${providerType ?? "provider"} auth/config error — breaker held ` +
            `until ${state.nextAllowedAttempt}. Manual fix required: ${info.error}`,
        );
      } else {
        this.logger.warn(
          `AI ${providerType ?? "provider"} ${category} error — breaker open ` +
            `until ${state.nextAllowedAttempt}`,
        );
      }
      throw error;
    }
  }

  /** Read-only breaker status for run-start checks (does not consume a probe). */
  getBreakerStatus(): {
    open: boolean;
    nextAllowedAttempt?: string;
    reason?: string;
  } {
    const state = this.breaker.peek();
    return {
      open: this.breaker.isOpen(state),
      nextAllowedAttempt: state.nextAllowedAttempt,
      reason: state.reason,
    };
  }

  /** Manually clear the breaker (e.g. after rotating a bad API key). */
  resetBreaker(): void {
    this.breaker.reset();
  }

  async getActiveProviderType(): Promise<string | null> {
    const config = await this.getActiveConfig();
    return config?.provider ?? null;
  }

  private async getProviderInstance(): Promise<BaseLlmProvider> {
    const config = await this.getActiveConfig();

    if (!config) {
      this.logger.warn("No active AI provider configured, using mock");
      return new MockLlmProvider();
    }

    const cached = this.providerInstances.get(config.id);
    if (cached) {
      return cached;
    }

    const provider = this.createProviderInstance(config);
    this.providerInstances.set(config.id, provider);

    return provider;
  }

  private createProviderInstance(config: AiProviderConfig): BaseLlmProvider {
    switch (config.provider) {
      case "openai":
        return new OpenAiProvider(
          config.apiKey,
          config.model,
          config.apiEndpoint,
        );
      case "anthropic":
        return new AnthropicProvider(
          config.apiKey,
          config.model,
          config.apiEndpoint,
        );
      case "mistral":
        return new MistralProvider(
          config.apiKey,
          config.model,
          config.apiEndpoint,
        );
      case "google":
        return new GoogleProvider(config.apiKey, config.model);
      case "kimi":
        return new KimiProvider(
          config.apiKey,
          config.model,
          config.apiEndpoint ?? "https://api.moonshot.cn/v1",
        );
      case "deepseek":
        return new DeepSeekProvider(
          config.apiKey,
          config.model,
          config.apiEndpoint ?? "https://api.deepseek.com/v1",
        );
      case "mock":
        return new MockLlmProvider();
      default:
        this.logger.warn(
          `Unknown provider ${config.provider}, falling back to mock`,
        );
        return new MockLlmProvider();
    }
  }

  private mapDbToConfig(dbConfig: {
    id: string;
    provider: string;
    apiKey: string;
    apiEndpoint: string | null;
    model: string;
    temperature: number;
    maxTokens: number;
    isActive: boolean;
    isEnabled: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): AiProviderConfig {
    return {
      id: dbConfig.id,
      provider: dbConfig.provider as AiProviderType,
      apiKey: dbConfig.apiKey,
      apiEndpoint: dbConfig.apiEndpoint ?? undefined,
      model: dbConfig.model,
      temperature: dbConfig.temperature,
      maxTokens: dbConfig.maxTokens,
      isActive: dbConfig.isActive,
      isEnabled: dbConfig.isEnabled,
      createdAt: dbConfig.createdAt,
      updatedAt: dbConfig.updatedAt,
    };
  }

  getAvailableProviders(): Array<{
    type: AiProviderType;
    displayName: string;
    defaultModel: string;
    availableModels: string[];
    docsUrl: string;
  }> {
    return Object.entries(AI_PROVIDER_METADATA).map(([type, metadata]) => ({
      type: type as AiProviderType,
      ...metadata,
    }));
  }
}
