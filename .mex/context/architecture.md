---
name: architecture
description: How the major pieces of this project connect and flow. Load when working on system design, integrations, or understanding how components interact.
triggers:
  - "architecture"
  - "system design"
  - "how does X connect to Y"
  - "integration"
  - "flow"
edges:
  - target: context/stack.md
    condition: when specific technology details are needed
  - target: context/decisions.md
    condition: when understanding why the architecture is structured this way
  - target: context/pipeline.md
    condition: when working on any of the four ingest → parse → normalize → classify stages
  - target: context/ai-providers.md
    condition: when the work touches LLM calls, rate limiting, or the circuit breaker
  - target: context/credentials.md
    condition: when the work touches IMAP passwords, encryption, or Google OAuth
  - target: context/review-and-digest.md
    condition: when working on the human review loop, digest output, or launchd automation
grounds_to:
  - node: "method:efd8143865e919dd229b149ab5736020"
    fingerprint: "mh:64:7b226d696e68617368223a5b313336333738322c313037323836332c31363231393837352c333437383039392c31323833313539342c32313837393434392c32393738303138392c343137323934392c31303732373536352c33303339393233352c343136333032372c333135343831372c31313935343539322c383637363138382c31333137393237352c32353536373834312c34323138313935332c32363836363630392c393230383837362c31343739333537382c34333832323439322c31353830313837312c313830393030342c32313833393533372c343935373133332c34323533363137332c323034383432372c32333239363630332c31343332303431322c313634363838322c31313137393535322c31333237353231322c383035373739312c32313131343039342c31343237343234332c313934333631382c323232363838322c323430343634392c32343839343034332c373030313734352c343031343031302c33353832353131302c3832363536312c31353735353635332c353630353534392c383038393933302c32363234373734362c383539323535342c323639343539392c31313037342c31363132323235332c31353232313031332c33373738363738342c31313931323733372c313432303235342c31353033333735322c31353038393935392c32303038333238312c31333235333739312c31323932333335322c34363731393130372c393134333130362c373132303139352c323831373337375d2c226e65696768626f7273223a5b226d6574686f643a3063306263623836346535316134393161343238343962663036323939376132222c226d6574686f643a3463623331666534653766663533303136306466313634323730356534383035222c226d6574686f643a3732633138306632343839373065343435303939333464616433303933313635222c226d6574686f643a3864623265613938383536386434326135613238353439616233623332626633222c226d6574686f643a6330343065623933396662343734633138393238393862663934393333656635225d2c22746f6b656e436f756e74223a3831307d"
  - node: "method:1aa0e874cfac657a7450098f539a0f46"
    fingerprint: "mh:64:7b226d696e68617368223a5b313336333738322c313037323836332c35333638373230322c313733353730352c31323833313539342c32313837393434392c32393738303138392c343137323934392c31303732373536352c35303332323230372c343136333032372c343937393136322c36303336323334302c32313034343836352c31333137393237352c32353536373834312c34323138313935332c33303130323934322c393230383837362c31343739333537382c31393339373834312c31303636353633342c31373338313333312c363736383239302c343935373133332c33353630303631322c323034383432372c393938373439322c31343332303431322c3130313933303030352c373838333833362c31333537373834382c383035373739312c33323433363235352c31343237343234332c313934333631382c323232363838322c31373832333031322c32343839343034332c373030313734352c343031343031302c34313738343932362c3832363536312c313236393130392c353630353534392c383038393933302c31353237333637342c383539323535342c32323538363831352c31313037342c31303631323233302c31353232313031332c33373738363738342c31313931323733372c313432303235342c31353033333735322c31353038393935392c32303038333238312c31333235333739312c31323932333335322c32363235333133302c393134333130362c383934343635322c31313732363932355d2c226e65696768626f7273223a5b226d6574686f643a3033636534646232346430383137366265363633626532373166326266666633222c226d6574686f643a3063306263623836346535316134393161343238343962663036323939376132222c226d6574686f643a3463623331666534653766663533303136306466313634323730356534383035222c226d6574686f643a3765333637363936613863623666323336396333653064323165373663393266222c226d6574686f643a3864623265613938383536386434326135613238353439616233623332626633222c226d6574686f643a6131393565326465653130353961643032323263326537343538366531663737225d2c22746f6b656e436f756e74223a3836347d"
last_updated: 2026-08-10
---

# Architecture

## System Overview

email-ai is a single NestJS API (`apps/api`) plus a pnpm workspace of libraries, driven
by HTTP endpoints that a launchd shell script calls on a schedule. There is no queue and
no worker process — each pipeline stage is a POST endpoint that scans Postgres for rows
the previous stage produced and has not yet consumed.

```
IMAP mailbox
  → POST /email-sync/:id/run     EmailSyncService.syncAccount   → RawEmail        (+ SyncState uid watermark)
  → POST /email-parser/run       EmailParserService             → ParsedEmail     (mailparser)
  → POST /normalization/run      NormalizationService           → NormalizedEmail (+ RulesEngineService pre-classification)
  → POST /classification/run     ClassificationService          → EmailClassification (LLM via AiProviderService)
  → GET  /review-queue           ReviewQueueService             → ReviewDecision  (human approve/reject)
  → POST /digest/generate        DigestService                  → markdown file in an Obsidian vault
```

Stage coupling is purely relational: each stage's "find work" query is a Prisma
`findMany` for rows whose downstream relation is `null` (`rawEmail.parsed: null`,
`parsedEmail.normalized: null`, `normalizedEmail.classification: null`). Nothing calls
the next stage directly, so re-running any stage is safe and idempotent. The
`scripts/daily-digest.sh` launchd job is what actually chains them in order.

`apps/tui` (Ink) and the server-rendered HTML in `ReviewController` are two front ends
over the same review-queue endpoints; neither touches the database.

## Key Components

- **`EmailSyncService`** — the production ingestion path. Talks to IMAP through `imapflow`
  directly, writes `RawEmail` rows, and advances the per-mailbox `SyncState.lastSyncedUid`
  watermark so the next run fetches only `lastSyncedUid+1:*`. Depends on
  `EmailAccountsService` for credentials.
- **`ImapIngestionService`** — a *second*, parallel ingestion path behind
  `POST /email-sync/:accountId/ingest`. It uses the `@email-ai/mail-client` wrapper and
  writes `EmailMessage` rows, which **no downstream stage reads**. Only `EmailSyncService`
  feeds the pipeline. Do not "fix" a pipeline bug by editing the ingestion service.
- **`RulesEngineService`** — deterministic, zero-cost pre-classification run during
  normalization. Scores matched rules per category and writes `ruleCategory` /
  `ruleConfidence` / `ruleReasons` onto `NormalizedEmail`. Its output is fed to the LLM
  as a hint, not used as the final answer.
- **`AiProviderService`** — the only place that calls an LLM. Owns provider selection
  from the `AiProviderConfig` table, a per-minute `RateLimiter`, and a file-persisted
  `CircuitBreaker`. See `context/ai-providers.md`.
- **`DatabaseService`** — `extends PrismaClient` with Nest lifecycle hooks. Every module
  injects this; nothing constructs a `PrismaClient` of its own.
- **`AppConfigService`** — typed accessors over env vars validated by `envSchema` at
  boot. Config is a `@Global()` module, so it needs no explicit import.
- **`@email-ai/shared`** — Zod schemas and inferred types shared by the API and the TUI.
  This is also the contract the LLM response is validated against.

## External Dependencies

- **PostgreSQL 16** — the only datastore, run locally via `docker-compose.yml`. All access
  goes through the injected `DatabaseService`; there is no repository layer.
- **IMAP servers** — reached with `imapflow`, authenticating with either a decrypted
  stored password or a freshly minted Google XOAUTH2 access token.
- **Google OAuth (`google-auth-library`)** — optional. Only needed for Gmail accounts;
  the app boots and runs without `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
- **LLM HTTP APIs** — OpenAI, Anthropic, Mistral, Google, Kimi, DeepSeek, plus an
  offline `mock`. Each is a hand-written `fetch` adapter; no vendor SDKs are installed.
- **launchd + `qi`** — `scripts/daily-digest.sh` runs the pipeline hourly and the digest
  at 07:30, writing markdown into an Obsidian vault and piping actionable items into the
  `qi` CLI.

## What Does NOT Exist Here

- **No authentication or authorization.** Every endpoint is open; the API is expected to
  bind to localhost only. Do not add features that assume a current user.
- **No job queue, scheduler, or background worker inside the app.** Scheduling lives
  entirely in launchd plists under `scripts/`. Do not add `@nestjs/schedule` or BullMQ
  without revisiting `context/decisions.md`.
- **No mailbox writes.** The system never deletes, moves, flags, or replies to mail — it
  only reads and records recommendations. See the non-negotiables in `.mex/AGENTS.md`.
- **No linter.** Every package's `lint` script is `echo 'no linter configured yet'`.
  Typecheck plus tests are the whole quality gate.
- **No e2e tests.** `apps/api/test/jest-e2e.json` exists but no spec files use it.
