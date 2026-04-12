# AGENTS.md

## Project

Email AI Cleanup System — Self-hosted AI email triage for IMAP mailboxes.

## Quick Commands

```bash
# Setup (after git clone)
pnpm install
cp .env.example .env  # Edit: set ENCRYPTION_KEY via openssl rand -hex 32
docker compose up -d
pnpm --filter @email-ai/api db:migrate
pnpm --filter @email-ai/api db:generate

# Development
pnpm --filter @email-ai/api start:dev     # API watch mode
pnpm build                                  # Build all packages
pnpm test                                   # All tests
pnpm typecheck                              # Type check all packages

# Verification
curl http://localhost:3000/health
```

## Workspace Structure

```
apps/api                    NestJS application (main entry)
apps/api/prisma/            Database schema + migrations
packages/shared             Zod schemas + TypeScript types
packages/mail-client        IMAP client abstractions
packages/prompts            (reserved) LLM prompt builders
```

## Module Conventions

**Location**: `apps/api/src/modules/{kebab-case}/`

**Required files**:

- `{name}.module.ts` — NestJS module definition
- `{name}.service.ts` — Business logic
- `{name}.controller.ts` — API endpoints (only if exposing HTTP)

**Optional files**:

- `{name}.spec.ts` — Unit tests (colocated with service)
- `{name}.types.ts` — Module-specific types
- `dto/*.dto.ts` — Request/response DTOs
- `README.md` — Module documentation

**Pattern example**: `email-accounts/email-accounts.service.ts`

## Database Access Pattern

Prisma is wrapped in a custom `DatabaseService` (extends PrismaClient). Inject it:

```typescript
constructor(private db: DatabaseService) {}

// Usage
await this.db.emailAccount.findMany()
```

**Prisma commands** (run from `apps/api`):

- `pnpm db:generate` — Generate Prisma client
- `pnpm db:migrate` — Create/run migrations
- `pnpm db:push` — Prototype schema changes (dev only)
- `pnpm db:studio` — Open Prisma Studio GUI

Schema location: `apps/api/prisma/schema.prisma`

## Shared Package Pattern

**Schemas** (`packages/shared/src/schemas/`):

- PascalCase names ending in `Schema`: `EmailAddressSchema`
- Export as const + type: `export const EmailAddressSchema = z.object(...)`

**Types** (`packages/shared/src/types/`):

- Infer from schemas: `export type EmailAddress = z.infer<typeof EmailAddressSchema>`
- camelCase names

**Export** from `packages/shared/src/index.ts` via `export * from './schemas/...'`

## Build Order Dependency

`@email-ai/shared` must build before `@email-ai/api`. The root `build` script handles this:

```json
"build": "pnpm --filter @email-ai/shared build && pnpm --filter @email-ai/api build"
```

## Testing

- Unit tests only: `*.spec.ts` files colocated with source
- No e2e tests currently configured
- Test command: `pnpm --filter @email-ai/api test`
- Coverage: `pnpm --filter @email-ai/api test:cov`

## Safety Constraints

- Never auto-delete emails
- Never send replies unless explicitly requested
- Never silently mutate mailbox state
- Always default to dry-run mode for sync operations
- Always validate LLM outputs with Zod before acting
- All mailbox actions must be auditable

## Environment Requirements

- Node.js >= 22
- pnpm >= 9 (enforced via `packageManager` field)
- PostgreSQL 16 (via Docker Compose for local dev)
- `ENCRYPTION_KEY` required for IMAP password encryption

## Key Dependencies

- NestJS 11.x with @nestjs/config
- Prisma 6.x with @prisma/client
- imapflow for IMAP connections
- mailparser for email parsing
- Zod for validation

## API Conventions

- Health endpoint: `GET /health`
- Dry-run default: `POST /email-sync/:id/run?dryRun=true`
- Module paths use kebab-case matching directory names

## When Adding New Modules

1. Create directory under `apps/api/src/modules/{kebab-case}/`
2. Add `{name}.module.ts` with `@Module()` decorator
3. Export from `app.module.ts` imports array
4. Follow existing service/controller naming patterns
5. Add Prisma models to `schema.prisma` if needed
6. Run `pnpm db:generate` after schema changes
