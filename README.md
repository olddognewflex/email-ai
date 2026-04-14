# email-ai

A self-hosted AI email triage and cleanup system for IMAP mailboxes.

## Prerequisites

- Node.js >= 22
- pnpm >= 9 (`npm install -g pnpm`)
- Docker (for local PostgreSQL)

## Setup

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY to a strong random value:
#   openssl rand -hex 32

# 3. Start the database
docker compose up -d

# 4. Run migrations and generate the Prisma client
pnpm --filter @email-ai/api db:migrate
pnpm --filter @email-ai/api db:generate
```

## Running

```bash
# Development (watch mode)
pnpm --filter @email-ai/api start:dev

# Production build then start
pnpm build
pnpm --filter @email-ai/api start
```

## Verification

```bash
# Health check (requires a running DB)
curl http://localhost:3000/health

# Expected: {"status":"ok","db":"ok","timestamp":"..."}
```

## Tests

```bash
# All packages
pnpm test

# API unit tests only
pnpm --filter @email-ai/api test

# With coverage
pnpm --filter @email-ai/api test:cov
```

## API — Phase 1 endpoints

| Method | Path                            | Description                                    |
| ------ | ------------------------------- | ---------------------------------------------- |
| GET    | /health                         | Health + DB check                              |
| POST   | /email-accounts                 | Register an IMAP account                       |
| GET    | /email-accounts                 | List registered accounts                       |
| GET    | /email-accounts/:id             | Get account by ID                              |
| DELETE | /email-accounts/:id             | Remove account (fails if emails exist)         |
| POST   | /email-sync/:id/run?dryRun=true | Sync from IMAP (default dry-run)               |
| GET    | /email-sync/:id/states          | Sync state per mailbox                         |
| POST   | /email-parser/run               | Parse all unprocessed raw emails               |
| POST   | /email-parser/:id/parse         | Parse a single raw email                       |
| POST   | /normalization/run              | Normalize all unparsed emails                  |
| POST   | /normalization/:id/normalize    | Normalize (or reprocess) a single parsed email |
| POST   | /normalization/reprocess        | Reprocess all already-normalized emails        |
| POST   | /classification/run             | Classify all unclassified normalized emails    |
| POST   | /classification/:id/classify    | Classify a single normalized email             |
| GET    | /ai-providers                   | List AI provider configurations                |
| GET    | /ai-providers/available         | List available AI provider types               |
| POST   | /ai-providers                   | Create AI provider configuration               |
| PUT    | /ai-providers/:id               | Update AI provider configuration               |
| POST   | /ai-providers/:id/activate      | Set active AI provider                         |
| DELETE | /ai-providers/:id               | Delete AI provider configuration               |
| GET    | /review-queue                   | List classifications pending review            |
| POST   | /review-queue/:id/approve       | Approve a classification                       |
| POST   | /review-queue/:id/reject        | Reject a classification                        |
| GET    | /digest                         | Get daily digest as JSON                       |
| POST   | /digest/generate                | Generate and save digest to file system        |

`dryRun=true` (default) connects to IMAP and counts new messages without writing to the database.
Pass `dryRun=false` to persist raw emails.

## Daily Digest & Obsidian Export

Generate daily email digests grouped by actionability and export to Obsidian-compatible markdown.

### Digest Grouping

Emails are automatically categorized into three groups:

- **Actionable**: Items requiring user action (needs_attention, reply_needed, high importance personal)
- **FYI**: Informational items (newsletters, receipts, notifications, read_later)
- **Low Value**: Items safe to batch process (social, archive, delete, unknown)

### Generate Digest

```bash
# Get digest as JSON
curl "http://localhost:3000/digest"

# Get digest for specific date
curl "http://localhost:3000/digest?date=2025-04-12"

# Generate and save to Obsidian vault
curl -X POST "http://localhost:3000/digest/generate" \
  -H "Content-Type: application/json" \
  -d '{
    "outputPath": "/path/to/ObsidianVault/DailyNotes",
    "date": "2025-04-12"
  }'
```

Output file: `email-digest-YYYY-MM-DD.md` with idempotent filenames (same date = same file).

See [Digest Module README](apps/api/src/modules/digest/README.md) for full documentation.

## AI Provider Configuration

Configure AI providers for email classification. Supports OpenAI, Anthropic (Claude), Mistral, Google (Gemini), Kimi, and DeepSeek.

### Supported Providers

| Provider  | Type        | Default Model        | Notes                                       |
| --------- | ----------- | -------------------- | ------------------------------------------- |
| OpenAI    | `openai`    | gpt-4o               | Requires API key from platform.openai.com   |
| Anthropic | `anthropic` | claude-3-5-sonnet    | Requires API key from console.anthropic.com |
| Mistral   | `mistral`   | mistral-large-latest | Requires API key from console.mistral.ai    |
| Google    | `google`    | gemini-1.5-flash     | Requires API key from ai.google.dev         |
| Kimi      | `kimi`      | kimi-k2              | Chinese provider, requires custom endpoint  |
| DeepSeek  | `deepseek`  | deepseek-chat        | Requires custom endpoint                    |
| Mock      | `mock`      | mock                 | For testing, no API key needed              |

### Setup Steps

1. **Create a provider configuration:**

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

Response:

```json
{
  "id": "cl...",
  "provider": "openai",
  "model": "gpt-4o",
  "temperature": 0.3,
  "maxTokens": 1000,
  "isActive": false,
  "isEnabled": true,
  "createdAt": "2025-01-15T10:30:00.000Z",
  "updatedAt": "2025-01-15T10:30:00.000Z"
}
```

2. **Activate the provider:**

```bash
curl -X POST http://localhost:3000/ai-providers/{id}/activate
```

3. **List available providers:**

```bash
curl http://localhost:3000/ai-providers/available
```

4. **Update configuration:**

```bash
curl -X PUT http://localhost:3000/ai-providers/{id} \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o-mini",
    "temperature": 0.2
  }'
```

5. **Delete configuration:**

```bash
curl -X DELETE http://localhost:3000/ai-providers/{id}
```

### Configuration with Custom Endpoints

For providers like Kimi or DeepSeek that require custom endpoints:

```bash
curl -X POST http://localhost:3000/ai-providers \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "kimi",
    "apiKey": "your-kimi-api-key",
    "apiEndpoint": "https://api.moonshot.cn/v1",
    "model": "kimi-k2",
    "temperature": 0.3,
    "maxTokens": 1000
  }'
```

### Rate Limiting

The AI provider service includes automatic rate limiting and exponential backoff to prevent 429 errors from API providers. By default, it limits requests to 20 per minute with 3 retries and exponential backoff.

See the [AI Provider README](apps/api/src/modules/ai-provider/README.md) for details on configuring rate limits for your specific provider.

### Fallback Behavior

If no AI provider is configured or the active provider fails, the system automatically falls back to the Mock provider for testing. The Mock provider returns keyword-based classifications without making external API calls.

## Workspace structure

```
apps/api                          NestJS application
apps/api/prisma/                  Database schema and migrations
apps/api/src/modules/ai-provider/ AI provider configuration and adapters
packages/shared                   Shared Zod schemas and TypeScript types
```
