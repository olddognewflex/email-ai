# AI Provider Module

Multi-provider LLM integration for email classification. Supports OpenAI, Anthropic (Claude), Mistral, Google (Gemini), Kimi, DeepSeek, and Mock providers.

## Architecture

```
AiProviderModule
├── AiProviderService (loads active provider, handles API calls)
├── AiProviderController (REST API for configuration)
└── Provider Adapters (OpenAI, Anthropic, etc.)
```

## Supported Providers

| Provider           | Type        | Default Model        | Custom Endpoint |
| ------------------ | ----------- | -------------------- | --------------- |
| OpenAI             | `openai`    | gpt-4o               | Optional        |
| Anthropic (Claude) | `anthropic` | claude-3-5-sonnet    | Optional        |
| Mistral            | `mistral`   | mistral-large-latest | Optional        |
| Google (Gemini)    | `google`    | gemini-1.5-flash     | No              |
| Kimi (Moonshot)    | `kimi`      | kimi-k2              | Yes (required)  |
| DeepSeek           | `deepseek`  | deepseek-chat        | Yes (required)  |
| Mock               | `mock`      | mock                 | N/A             |

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

## Adding New Providers

1. Create adapter class implementing `BaseLlmProvider`
2. Add to `AiProviderType` enum in shared schemas
3. Add metadata to `AI_PROVIDER_METADATA`
4. Register in `AiProviderService.createProviderInstance()`
