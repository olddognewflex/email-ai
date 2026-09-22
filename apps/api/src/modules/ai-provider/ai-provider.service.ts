import { Injectable, Logger } from "@nestjs/common";
import {
  AiProviderConfig,
  AiProviderType,
  AI_PROVIDER_METADATA,
  CreateAiProviderConfig,
  LlmRequest,
  LlmResponse,
  TypeSafeJudgeRequest,
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
  TypeSafeClient,
  TypeSafeJudgeResult,
  TYPESAFE_DEFAULT_BASE_URL,
} from "./providers";
import { RateLimiter, RateLimiterConfig } from "./rate-limiter";
import {
  AiProviderConfigError,
  AiProviderError,
  BreakerOpenError,
  InvalidProviderResponseError,
  ProviderRequestRejectedError,
  categorizeError,
} from "./ai-provider.error";
import { CircuitBreaker } from "./circuit-breaker";

@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);
  private providerInstances: Map<string, BaseLlmProvider> = new Map();
  private typeSafeClients: Map<string, TypeSafeClient> = new Map();
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
    this.typeSafeClients.delete(id);

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
    this.typeSafeClients.delete(id);
  }

  /**
   * Run an LLM completion behind the circuit breaker.
   *
   * On any provider failure this THROWS (it no longer resolves to
   * `{ content: "", error }`): transient errors are retried in-run by the
   * rate limiter, and quota/auth errors open the persisted breaker before
   * propagating. Callers should treat a throw as "no answer" and defer.
   *
   * Ordering: the active config is resolved and validated FIRST (a DB read,
   * no network). A wrong provider type (TypeSafe active) is a local wiring
   * error that waiting cannot fix, so it throws `AiProviderConfigError`
   * without consuming a half-open probe. Only then is the breaker consulted
   * — still before any network call. With no active config the mock
   * provider is used, and an open breaker still throws `BreakerOpenError`.
   */
  async complete(request: LlmRequest): Promise<LlmResponse> {
    const config = await this.getActiveConfig();
    if (config?.provider === "typesafe") {
      throw new AiProviderConfigError(
        "TypeSafe does not support free-text completion; use judge() " +
          "(ClassificationService routes to it automatically)",
      );
    }
    const provider = this.getProviderInstance(config);
    return this.guarded(config?.provider ?? null, () =>
      this.rateLimiter.execute(() => provider.complete(request)),
    );
  }

  /**
   * Run a TypeSafe (System One) judgment behind the same breaker + rate
   * limiter as `complete()`. Requires the active provider to be `typesafe`
   * (checked before the breaker, as in `complete()`).
   *
   * Throws like `complete()` on provider failure. A 2xx body that is not
   * JSON throws `InvalidProviderResponseError` (kind `unparseable`) and
   * counts as a breaker failure (`unknown` → short hold): systemic. JSON
   * that fails the schema throws it with kind `invalid_shape`, and a 422
   * throws `ProviderRequestRejectedError`; both are per-request and count
   * as a breaker success (see `guarded`).
   */
  async judge(request: TypeSafeJudgeRequest): Promise<TypeSafeJudgeResult> {
    return this.judgeWith(request, (result) => result);
  }

  /**
   * `judge()` plus an `interpret` step that runs INSIDE the breaker guard.
   * If `interpret` throws (e.g. an answer label outside the expected enum),
   * it is rethrown as `InvalidProviderResponseError` (kind `invalid_shape`)
   * and handled exactly like a schema-invalid body: per-request.
   */
  async judgeWith<T>(
    request: TypeSafeJudgeRequest,
    interpret: (result: TypeSafeJudgeResult) => T,
  ): Promise<T> {
    const client = await this.getTypeSafeClient();
    return this.guarded("typesafe", async () => {
      const result = await this.rateLimiter.execute(() =>
        client.judge(request),
      );
      try {
        return interpret(result);
      } catch (error) {
        if (error instanceof InvalidProviderResponseError) throw error;
        throw new InvalidProviderResponseError(
          "typesafe",
          "invalid_shape",
          `TypeSafe answers could not be interpreted: ${
            error instanceof Error ? error.message : String(error)
          }`,
          result.rawBody.slice(0, 10_000),
        );
      }
    });
  }

  /**
   * Breaker gate → fn → breaker bookkeeping. `fn` is expected to wrap its
   * network call in `rateLimiter.execute` so in-run retries stay inside the
   * breaker. Failures are categorized and recorded, then rethrown.
   */
  private async guarded<T>(
    providerType: string | null,
    fn: () => Promise<T>,
  ): Promise<T> {
    const gate = this.breaker.canAttempt();
    if (!gate.allowed) {
      throw new BreakerOpenError(
        gate.state.nextAllowedAttempt,
        gate.state.reason,
      );
    }

    // A per-request failure proves the server is reachable and the key
    // valid, so it normally closes the breaker. Exception: when this call is
    // the half-open probe of a breaker opened for QUOTA, a 422/invalid shape
    // says nothing about whether the quota has reset — leave the probe guard
    // to expire rather than closing the breaker on it.
    const recordPerRequestOutcome = () => {
      const isQuotaProbe =
        gate.state.status === "half_open" && gate.state.reason === "quota";
      if (!isQuotaProbe) this.breaker.recordSuccess();
    };

    try {
      const result = await fn();
      this.breaker.recordSuccess();
      return result;
    } catch (error) {
      // TypeSafe 422: the service is up and the key is valid, but it
      // rejected THIS request. Per-item, not systemic — don't hold the
      // breaker (the 4xx → auth → 12h rule would stall the whole pipeline).
      // The rate limiter already rethrew it without retrying (4xx ≠ transient).
      if (
        error instanceof AiProviderError &&
        error.provider === "typesafe" &&
        error.status === 422
      ) {
        recordPerRequestOutcome();
        throw new ProviderRequestRejectedError(
          error.provider,
          error.status,
          error.body,
        );
      }
      // Valid JSON with the wrong shape (or unmappable answers) can be
      // specific to one email. Holding the breaker would end the batch at
      // that email on every run and starve everything after it. Only an
      // `unparseable` (non-JSON) body falls through as a systemic failure.
      if (
        error instanceof InvalidProviderResponseError &&
        error.kind === "invalid_shape"
      ) {
        recordPerRequestOutcome();
        throw error;
      }
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

  private getProviderInstance(
    config: AiProviderConfig | null,
  ): BaseLlmProvider {
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

  private async getTypeSafeClient(): Promise<TypeSafeClient> {
    const config = await this.getActiveConfig();
    if (!config || config.provider !== "typesafe") {
      throw new AiProviderConfigError(
        `TypeSafe judgment requires the active AI provider to be "typesafe" ` +
          `(active: ${config?.provider ?? "none"})`,
      );
    }

    const cached = this.typeSafeClients.get(config.id);
    if (cached) {
      return cached;
    }

    const client = new TypeSafeClient(
      config.apiKey,
      config.model,
      config.apiEndpoint ?? TYPESAFE_DEFAULT_BASE_URL,
    );
    this.typeSafeClients.set(config.id, client);
    return client;
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
      case "typesafe":
        // TypeSafe answers typed questions, not free-text prompts. Failing
        // loudly beats silently producing mock classifications.
        throw new AiProviderConfigError(
          "TypeSafe does not support free-text completion; use judge() " +
            "(ClassificationService routes to it automatically)",
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
