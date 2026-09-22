# AI Provider Module

Multi-provider LLM integration for email classification. Supports OpenAI, Anthropic (Claude), Mistral, Google (Gemini), Kimi, DeepSeek, TypeSafe (Jev), and Mock providers.

## Architecture

```
AiProviderModule
├── AiProviderService (loads active provider, handles API calls)
├── AiProviderController (REST API for configuration)
└── Provider Adapters (OpenAI, Anthropic, etc.)
```

## Supported Providers

| Provider           | Type        | Default Model        | Custom Endpoint                                  |
| ------------------ | ----------- | -------------------- | ------------------------------------------------ |
| OpenAI             | `openai`    | gpt-4o               | Optional                                         |
| Anthropic (Claude) | `anthropic` | claude-3-5-sonnet    | Optional                                         |
| Mistral            | `mistral`   | mistral-large-latest | Optional                                         |
| Google (Gemini)    | `google`    | gemini-1.5-flash     | No                                               |
| Kimi (Moonshot)    | `kimi`      | kimi-k2              | Yes (required)                                   |
| DeepSeek           | `deepseek`  | deepseek-chat        | Yes (required)                                   |
| TypeSafe (Jev)     | `typesafe`  | jev-latest           | Optional (defaults to `https://api.typesafe.ai`) |
| Mock               | `mock`      | mock                 | N/A                                              |

TypeSafe is not an LLM completion API — see [TypeSafe (judgment API)](#typesafe-judgment-api) below.

## Configuration

### 1. Create Provider Configuration

```bash
curl -X POST http://localhost:3000/ai-providers \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "openai",
    "apiKey": "sk-...",
    "model": "gpt-4o",
    "temperature": 0.3,
    "maxTokens": 1000
  }'
```

### 2. Activate Provider

```bash
curl -X POST http://localhost:3000/ai-providers/{id}/activate
```

### 3. List Available Providers

```bash
curl http://localhost:3000/ai-providers/available
```

## API Endpoints

| Method | Path                         | Description                   |
| ------ | ---------------------------- | ----------------------------- |
| GET    | `/ai-providers`              | List all configured providers |
| GET    | `/ai-providers/available`    | List available provider types |
| GET    | `/ai-providers/:id`          | Get specific provider config  |
| POST   | `/ai-providers`              | Create new provider config    |
| PUT    | `/ai-providers/:id`          | Update provider config        |
| POST   | `/ai-providers/:id/activate` | Set as active provider        |
| DELETE | `/ai-providers/:id`          | Delete provider config        |

## Rate Limiting

The AI provider service implements automatic rate limiting and retry logic to prevent 429 errors from API providers.

### Default Limits

- **Requests per minute**: 20 (configurable)
- **Max retries**: 3 with exponential backoff
- **Base delay**: 1000ms
- **Max delay**: 60000ms

### Retry Logic

When a rate limit error (429) is encountered:

1. If the API returns a `retry-after` value, wait for that duration plus a 100ms buffer
2. Otherwise, use exponential backoff with 30% jitter:
   - Retry 1: ~1000ms delay
   - Retry 2: ~2000ms delay
   - Retry 3: ~4000ms delay

### Provider-Specific Limits

| Provider  | Typical TPM Limit | Recommended RPM |
| --------- | ----------------- | --------------- |
| OpenAI    | 30,000 TPM        | 20-30           |
| Anthropic | 40,000 TPM        | 30-40           |
| Mistral   | Varies by tier    | 20-60           |
| Google    | 60,000 TPM        | 40-60           |
| Kimi      | Varies            | 20-30           |
| DeepSeek  | Varies            | 20-30           |

To adjust rate limits for your provider, modify the `RateLimiterConfig` in `ai-provider.service.ts`.

## Fallback Behavior

If no provider is configured or the active provider fails, the system falls back to the Mock provider which returns keyword-based classifications for testing.

## Database Schema

```prisma
model AiProviderConfig {
  id          String   @id @default(cuid())
  provider    String   @unique
  apiKey      String
  apiEndpoint String?
  model       String
  temperature Float    @default(0.3)
  maxTokens   Int      @default(1000)
  isActive    Boolean  @default(false)
  isEnabled   Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

## Usage in Classification

The `ClassificationService` automatically uses the active AI provider:

```typescript
const request: LlmRequest = {
  prompt: buildClassificationPrompt(input),
  temperature: 0.3,
  maxTokens: 1000,
};

const response = await this.aiProviderService.complete(request);
```

## TypeSafe (judgment API)

[TypeSafe](https://docs.typesafe.ai) is a "System One" judgment API (model
family Jev): the caller sends structured `state` plus typed questions
(`choice`, `score`, `noul`) and gets typed answers with probabilities back —
no free text. It therefore has its own contract instead of `BaseLlmProvider`:

- `providers/typesafe.client.ts` — `TypeSafeClient.judge({ state, questions })`
  does one `fetch` to `POST {baseURL}/v1/systemone`, calls
  `throwIfNotOk(response, "typesafe")` first (so 401/422/429/529 become
  `AiProviderError`s), then Zod-validates the body with
  `TypeSafeResponseSchema` from `@email-ai/shared`. It returns
  `{ response, rawBody }` — the validated answers plus the exact body text for
  audit. A 2xx body that is not JSON throws `InvalidProviderResponseError`
  with `kind: "unparseable"`; JSON that fails validation throws it with
  `kind: "invalid_shape"`. No vendor SDK, no fetch timeout (matching
  the other adapters).
- `AiProviderService.judge(request)` / `judgeWith(request, interpret)` —
  require the **active** config to be `typesafe` (otherwise
  `AiProviderConfigError`), cache one client per config id (dropped on
  update/delete, like `providerInstances`), and run through the same private
  `guarded()` helper as `complete()`: breaker gate → rate limiter → breaker
  bookkeeping. `judgeWith` runs `interpret` (e.g. mapping answers to a
  classification) **inside** the guard; if it throws, the error is rethrown
  as `InvalidProviderResponseError` (`invalid_shape`).
- `AiProviderService.complete()` with TypeSafe active throws
  `AiProviderConfigError` ("does not support free-text completion") — it does
  **not** fall back to the mock provider.
- `ClassificationService` routes to `judgeWith()` automatically when the
  active provider is `typesafe` (see the classification module README).

Ordering and breaker interplay:

- Both `complete()` and `judge()` resolve and validate the active config
  **before** `breaker.canAttempt()`. A wrong provider type is a local wiring
  error that waiting can't fix, so `AiProviderConfigError` is thrown without
  touching the breaker (in particular without consuming a half-open probe).
  The breaker is still consulted before any network call, and with no active
  config `complete()` uses the mock provider — an open breaker still throws
  `BreakerOpenError`. The cost is one DB read before the breaker check, which
  `guarded()` previously did right after it anyway.
- `InvalidProviderResponseError` with `kind: "unparseable"` (the 2xx body is
  not JSON — a wrong `apiEndpoint` returning 200 HTML, a proxy) is systemic
  and a normal breaker **failure**: `unknown`, short transient hold, so the
  next email short-circuits and the batch stops.
- `InvalidProviderResponseError` with `kind: "invalid_shape"` (valid JSON that
  fails the schema, or answers `interpret` can't map) may be specific to one
  email. Holding the breaker would stop every run at that email and starve
  everything after it, so it is per-request: breaker **success**, rethrown.
- A TypeSafe **422** (the request was rejected: state/question validation) is
  per-request, not systemic. The rate limiter does not retry it (4xx is not
  transient); `guarded()` then records a breaker **success** and rethrows it as
  `ProviderRequestRejectedError` (status + truncated body). Without this, the
  general "non-429 4xx → `auth` → 12h hold" rule would let one oversized email
  stall the whole pipeline. 401/403 and other providers' 4xx keep the `auth`
  behavior.
- Exception to both per-request cases: if the call was the half-open probe of
  a breaker opened for **quota**, no success is recorded (a 422 says nothing
  about whether the quota reset); the 30s probe guard simply expires.
- Because 422s and invalid shapes record a breaker success, a _systemic_
  version of either (a broken question set, an API contract change) does
  **not** show up in `GET /ai-providers/breaker`. The signal is the error log
  line "… consecutive per-email failures … question set or API contract is
  probably broken" and a non-zero `errors` count (with `skipped`) in the
  `POST /classification/run` response.
- 529 (overloaded) is a 5xx and is retried in-run as `transient`.

Activate it:

```bash
curl -X POST http://localhost:3000/ai-providers \
  -H "Content-Type: application/json" \
  -d '{ "provider": "typesafe", "apiKey": "<key>", "model": "jev-latest" }'

curl -X POST http://localhost:3000/ai-providers/{id}/activate
```

`temperature` and `maxTokens` are accepted (schema defaults apply) but unused
by TypeSafe. `apiEndpoint` optionally overrides the base URL.

## Adding New Providers

1. Create adapter class implementing `BaseLlmProvider` (or, for a
   non-completion API like TypeSafe, a dedicated client plus a service method
   that validates the provider type and then runs through `guarded()`)
2. Add to `AiProviderType` enum in shared schemas
3. Add metadata to `AI_PROVIDER_METADATA`
4. Register in `AiProviderService.createProviderInstance()`
