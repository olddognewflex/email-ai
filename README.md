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

`dryRun=true` (default) connects to IMAP and counts new messages without writing to the database.
Pass `dryRun=false` to persist raw emails.

## Workspace structure

```
apps/api           NestJS application
apps/api/prisma/   Database schema and migrations
packages/shared    Shared Zod schemas and TypeScript types
```
