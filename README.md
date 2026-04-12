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

## Workspace structure

```
apps/api           NestJS application
apps/api/prisma/   Database schema and migrations
packages/shared    Shared Zod schemas and TypeScript types
```
