---
name: stack
description: Technology stack, library choices, and the reasoning behind them. Load when working with specific technologies or making decisions about libraries and tools.
triggers:
  - "library"
  - "package"
  - "dependency"
  - "which tool"
  - "technology"
edges:
  - target: context/decisions.md
    condition: when the reasoning behind a tech choice is needed
  - target: context/conventions.md
    condition: when understanding how to use a technology in this codebase
  - target: context/setup.md
    condition: when a library needs a install/build/migration step before it works
  - target: patterns/change-prisma-schema.md
    condition: when a change touches the Prisma schema or generated client
grounds_to: []
last_updated: 2026-08-10
---

# Stack

## Core Technologies

- **TypeScript 5.5, strict mode** — `tsconfig.base.json` sets `strict: true`, `target: ES2022`,
  `module: CommonJS`, and the decorator flags NestJS needs. Every package extends it.
- **Node.js >= 22** — enforced by root `engines`. Relied on for global `fetch` (all LLM
  adapters and `apps/tui/src/api.ts` use it with no polyfill).
- **NestJS 11** — the API framework. Modules under `apps/api/src/modules/{kebab-case}/`,
  wired into `AppModule`'s `imports` array.
- **Prisma 6 / PostgreSQL 16** — schema at `apps/api/prisma/schema.prisma`, database via
  `docker-compose.yml`. Ten migrations exist; `prisma migrate dev` is the change path.
- **pnpm 9+ workspaces** — `apps/*` and `packages/*`. Cross-package deps use
  `workspace:*`. The root `packageManager` field pins `pnpm@11.5.3`.

## Key Libraries

- **Zod 3** (not `class-validator` for new work) — every schema in `packages/shared` is Zod,
  the env is validated with `envSchema`, and the LLM's JSON reply is checked with
  `EmailClassificationOutputSchema`. `class-validator`/`class-transformer` are installed and
  still used by a few `dto/*.dto.ts` classes; prefer Zod plus `ZodValidationPipe` for new code.
- **`imapflow`** (not `node-imap`) — IMAP transport. Used directly in `EmailSyncService`, and
  wrapped by `@email-ai/mail-client` for the secondary ingestion path.
- **`mailparser`** (`simpleParser`) — MIME parsing in `EmailParserService`. This is the only
  thing that reads `RawEmail.rawSource`.
- **`html-to-text`** — HTML body flattening inside `EmailNormalizer`.
- **`google-auth-library`** — Gmail XOAUTH2 refresh-token exchange. Optional at runtime.
- **Jest 29 + ts-jest** (not vitest, not node:test) — config lives inline in
  `apps/api/package.json`, `rootDir: src`, `testRegex: .*\.spec\.ts$`. Its `moduleNameMapper`
  points `@email-ai/shared` at the package *source*, so API tests do not need a built shared package.
- **Ink 5 + React 18** — `apps/tui` only. Nothing else in the repo uses React.
- **No LLM vendor SDKs.** Every provider adapter is a hand-written `fetch` call against
  the vendor's REST endpoint. Adding `openai` or `@anthropic-ai/sdk` would break the
  uniform `BaseLlmProvider` shape and the shared error handling in `throwIfNotOk`.

## What We Deliberately Do NOT Use

- **No linter.** Every package's `lint` script is a stub `echo`. `pnpm lint` passing means
  nothing — do not read it as a green signal, and do not add ESLint as a drive-by change.
- **No ORM repository layer.** Services inject `DatabaseService` and call Prisma directly.
  Do not introduce repository classes.
- **No vendor LLM SDKs** — see above.
- **No `@nestjs/schedule` / queue library.** Scheduling is launchd (`scripts/*.plist`).
- **No e2e/integration test harness.** `supertest` and `apps/api/test/jest-e2e.json` are present but
  unused; only colocated `*.spec.ts` unit tests run.

## Version Constraints

- **Prisma is pinned to exactly `6.19.3`** in `apps/api` devDependencies (the client is a
  caret range). Regenerate with `pnpm --filter @email-ai/api db:generate` after any schema edit —
  typecheck fails against a stale client.
- **`@nestjs/core` is force-resolved to `^11.0.0`** via `overrides` in `pnpm-workspace.yaml`.
  A transitive dep asking for Nest 10 will silently get 11.
- **`@email-ai/shared` must be built before `@email-ai/api`.** `tsc` resolves it through
  `dist/`, so a fresh clone typechecks only after the shared build. The root `build` and
  `typecheck` scripts and the CI workflow all sequence this explicitly.
