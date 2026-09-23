---
name: setup
description: Dev environment setup and commands. Load when setting up the project for the first time or when environment issues arise.
triggers:
  - "setup"
  - "install"
  - "environment"
  - "getting started"
  - "how do I run"
  - "local development"
edges:
  - target: context/stack.md
    condition: when specific technology versions or library details are needed
  - target: context/architecture.md
    condition: when understanding how components connect during setup
  - target: context/credentials.md
    condition: when ENCRYPTION_KEY or Google OAuth env vars need explaining
  - target: patterns/debug-pipeline-stall.md
    condition: when the stack is up but no emails are flowing through it
grounds_to: []
last_updated: 2026-08-10
---

# Setup

## Prerequisites

- Node.js >= 22 (`mise.toml` pins `node = "latest"`; global `fetch` is assumed everywhere)
- pnpm >= 9 (`npm install -g pnpm`) — root `packageManager` is `pnpm@11.5.3`
- Docker, for the local PostgreSQL 16 container in `docker-compose.yml`

## First-time Setup

1. `pnpm install`
2. `cp .env.example .env`, then set `ENCRYPTION_KEY` to a strong value
   (`openssl rand -hex 32`). Note the API process also reads `apps/api/.env` when started
   from that directory — keep the two consistent or you will chase a phantom config bug.
3. `docker compose up -d`
4. `pnpm --filter @email-ai/api db:migrate`
5. `pnpm --filter @email-ai/api db:generate`
6. `pnpm build` (or at minimum `pnpm --filter @email-ai/shared build`) — `@email-ai/api`
   resolves `@email-ai/shared` through its `dist/`, so typecheck fails on a fresh clone
   until the shared package is built.
7. `pnpm --filter @email-ai/api start:dev`, then verify with `curl http://localhost:3000/health`
   → `{"status":"ok","db":"ok","timestamp":"..."}`.

## Environment Variables

Validated by `envSchema` (`apps/api/src/modules/config/env.schema.ts`) at boot — an invalid
value aborts startup rather than failing later.

Required:
- `DATABASE_URL` — PostgreSQL connection string; must parse as a URL.
- `ENCRYPTION_KEY` — any non-empty string; SHA-256 hashed to a 32-byte AES key. Changing it
  makes every stored IMAP password and refresh token undecryptable.

Optional, schema-validated:
- `PORT` — default `3000`. The launchd deployment, the `eai` TUI launcher and
  `scripts/daily-digest.sh` assume `3100` (override the script with `EMAIL_AI_API_URL`).
- `NODE_ENV` — `development` | `test` | `production`, default `development`.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — required only for Gmail XOAUTH2 accounts;
  the app boots fine without them.
- `GOOGLE_REDIRECT_URI` — must match the URI registered in the GCP console exactly; defaults
  to `http://localhost:$PORT/email-accounts/oauth/google/callback`.

Optional, read directly from `process.env` (**not** in `envSchema`, so typos fail silently):
- `AI_REQUESTS_PER_MINUTE` — rate-limiter ceiling, default 20.
- `AI_MAX_TOKENS` — output ceiling per classification call, default 4000. Reasoning models
  spend hidden thinking tokens from this budget; too low truncates the JSON mid-string.
- `AI_BREAKER_STATE_PATH` — default `~/.local/state/email-ai/ai-breaker.json`.
- `AI_QUOTA_BASE_DELAY_MS` (60s), `AI_QUOTA_MAX_DELAY_MS` (12h), `AI_TRANSIENT_HOLD_MS` (60s).
- `DIGEST_LINK_BASE_URL` — base for approve/reject links in generated digest markdown.

## Common Commands

- `pnpm --filter @email-ai/api start:dev` — API in watch mode.
- `pnpm build` — builds `@email-ai/shared` then `@email-ai/api`, in that order.
- `pnpm typecheck` — builds shared, then `tsc --noEmit` across every package. This is the
  real gate; run it after any schema or shared-package change.
- `pnpm test` — recursive Jest. API-only: `pnpm --filter @email-ai/api test`;
  coverage: `... test:cov`.
- `pnpm --filter @email-ai/api db:migrate` / `db:generate` / `db:studio` — create+apply a
  migration, regenerate the client, open Prisma Studio.
- `pnpm lint` — **a stub.** Every package's lint script is `echo 'no linter configured yet'`.
- `./scripts/daily-digest.sh [sync|digest|all]` — run the whole pipeline the way launchd does.
- `eai` — the review TUI (`apps/tui`), defaulting to `PORT=3100`.

## Common Issues

**`Cannot find module '@email-ai/shared'` on typecheck or build:** the shared package has not
been built. Run `pnpm --filter @email-ai/shared build`. API *tests* do not hit this — Jest's
`moduleNameMapper` points at the shared source.

**Prisma type errors after editing `schema.prisma`:** the generated client is stale. Run
`pnpm --filter @email-ai/api db:generate`, then typecheck again.

**`/health` returns non-ok `db`, or the API keeps restarting:** Postgres is not up. Run
`docker compose up -d`. Under launchd the API has `KeepAlive` with a 30s `ThrottleInterval`
specifically so it retries while Docker comes up — check `~/.local/state/email-ai/api.log`.

**Classification runs report `skipped` and process nothing:** the AI circuit breaker is open,
not a config problem. See `context/ai-providers.md` and
`patterns/debug-pipeline-stall.md`.

**Sync says the account `needs re-authorization`:** the Google refresh token was revoked or
expired. Re-connect via `POST /email-accounts/oauth/google/start` with the `accountId`. In a
GCP consent screen still in "Testing" status, refresh tokens expire after 7 days.
