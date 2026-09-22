---
name: change-prisma-schema
description: Change the Prisma schema and land the migration — the build-order and regeneration steps that make or break typecheck and CI.
triggers:
  - "prisma"
  - "migration"
  - "schema.prisma"
  - "new table"
  - "new column"
  - "db:migrate"
  - "database change"
edges:
  - target: context/stack.md
    condition: when the Prisma pin, build order, or client generation is the issue
  - target: context/pipeline.md
    condition: when the new column participates in a stage's find-work query
  - target: patterns/add-api-module.md
    condition: when the schema change accompanies a new module or endpoint
  - target: context/setup.md
    condition: when the database itself is not running
grounds_to: []
last_updated: 2026-08-10
---

# Change the Prisma Schema

## Context

One schema file: `apps/api/prisma/schema.prisma`. Ten migrations exist under
`prisma/migrations/`, each a timestamped directory with a single `migration.sql`. Prisma
commands run through the API package's scripts, so use the `--filter` form from the repo root
or `cd apps/api` first.

The generated client is what typechecking sees, so **regeneration is not optional** — a schema
edit without `db:generate` produces confusing "property does not exist" errors on the Prisma
delegate rather than anything pointing at the schema.

## Steps

1. Make sure Postgres is up: `docker compose up -d`.
2. Edit `apps/api/prisma/schema.prisma`. Models are PascalCase singular, fields camelCase; do
   not add `@map`/`@@map` — nothing in this schema uses them.
3. Add an `@@index` for any column a stage will filter on. The existing indexes
   (`category`, `needsReview`, `confidence`, `createdAt` on `EmailClassification`;
   `ruleCategory`, `ruleConfidence` on `NormalizedEmail`) exist because the queue and digest
   queries filter on exactly those.
4. `pnpm --filter @email-ai/api db:migrate` — creates and applies the migration. Give it a
   snake_case name that reads as a change (`add_review_decision_table`,
   `add_corrected_category_to_review_decision`), matching the existing directory names.
5. `pnpm --filter @email-ai/api db:generate`.
6. If the shape is visible to the TUI or the API contract, mirror it as a Zod schema in
   `packages/shared/src/schemas/` and re-export from `packages/shared/src/index.ts`. The Prisma
   type and the Zod schema are maintained by hand — nothing generates one from the other.
7. `pnpm typecheck` then `pnpm test`.
8. Commit the generated `prisma/migrations/<timestamp>_<name>/migration.sql` alongside the
   schema change. CI runs `db:generate` but never `migrate`, so a missing migration file means
   the change simply does not exist for anyone else.

## Gotchas

- **`db:push` is prototype-only.** It mutates the database with no migration file; anything you
  push is invisible to CI and to other checkouts. Use `db:migrate` for anything you intend to keep.
- **Prisma is pinned to exactly `6.19.3`** in devDependencies while `@prisma/client` is a caret
  range. Do not bump one without the other.
- A stage's "find work" query is a null-relation check (`{ parsed: null }`,
  `{ classification: null }`). Adding a new one-to-one relation to an existing model can change
  which rows an existing stage considers unprocessed — check every `findMany` that references
  the model before adding a relation.
- Adding a required column to a populated table needs a default or a backfill; the ten existing
  migrations all add nullable columns or defaults for this reason.
- `onDelete: Cascade` is used consistently down the email chain
  (`EmailAccount → RawEmail → ParsedEmail → NormalizedEmail → EmailClassification → ReviewDecision`).
  Keep that going, or deleting an account will fail on a foreign key.
- Adding a value to a Prisma `enum` and to the matching Zod enum in `packages/shared` are two
  separate edits, and a third is often needed in behaviour — a new `EmailCategorySchema` value
  that is not handled in `DigestService.determineActionabilityGroup` silently falls into **fyi**.

## Verify

- [ ] A new directory exists under `prisma/migrations/` and its `migration.sql` is staged.
- [ ] `pnpm --filter @email-ai/api db:generate` has run since the last schema edit.
- [ ] `pnpm typecheck` passes from a clean state (`pnpm build` first if in doubt).
- [ ] `pnpm test` passes.
- [ ] `curl localhost:3000/health` returns `{"status":"ok","db":"ok",...}` against the migrated DB.
- [ ] Any corresponding Zod schema in `packages/shared` was updated and re-exported.

## Debug

- `Property 'x' does not exist on type 'PrismaClient'` → client not regenerated.
- `Cannot find module '@email-ai/shared'` → shared package not built; `pnpm build`.
- Migration hangs or refuses → Postgres is not running, or `DATABASE_URL` in the `.env` that the
  process actually reads (root vs `apps/api/.env`) points somewhere else.
- Drift warning from `migrate dev` → someone used `db:push`. Reconcile before generating a new
  migration.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update any `.mex/context/` files that are now out of date
- [ ] If this is a new task type without a pattern, create one in `.mex/patterns/` and add to `INDEX.md`
