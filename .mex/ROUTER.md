---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: context/pipeline.md
    condition: when the task touches sync, parse, normalize, or classify
  - target: context/ai-providers.md
    condition: when the task touches an LLM call, rate limiting, or the circuit breaker
  - target: context/credentials.md
    condition: when the task touches IMAP auth, encryption, or Google OAuth
  - target: context/review-and-digest.md
    condition: when the task touches the review queue, the TUI, the digest, or launchd automation
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
last_updated: 2026-08-10
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State

**Working:**
- Full four-stage pipeline end to end: IMAP sync → parse → normalize (+ deterministic rules
  engine) → LLM classification, each as an idempotent, independently re-runnable endpoint.
- Multi-provider LLM support (OpenAI, Anthropic, Mistral, Google, Kimi, DeepSeek, mock) with
  DB-stored config, per-minute rate limiting, transient retry, and a file-persisted circuit
  breaker that survives the hourly launchd restart.
- Human review loop: `/review-queue` JSON, a server-rendered HTML UI, and the `eai` Ink TUI,
  with approve / reject / recategorize decisions recorded in `ReviewDecision`.
- Daily digest grouped into actionable / FYI / low-value, exported as idempotent markdown into
  an Obsidian vault, with actionable items captured into the `qi` CLI.
- Email accounts with both stored-password (AES-256-GCM) and Gmail XOAUTH2 auth, including a
  `needsReauth` re-consent loop.
- Automated operation on macOS via three launchd jobs (always-on API, hourly sync, 07:30 digest).

**Not yet built:**
- Any authentication or authorization on the API — every endpoint is open and localhost-only.
- Any mailbox write-back: the recommended actions (archive, delete, unsubscribe) are never
  executed, only recorded.
- A linter. Every package's `lint` script is a stub `echo`; typecheck and unit tests are the
  entire quality gate.
- E2E/integration tests. `supertest` and `apps/api/test/jest-e2e.json` exist but nothing uses them.
- Portable deployment. The launchd plists hardcode absolute `/Users/raymonddoran/...` paths and
  use macOS-only `date -v-1d`.

**Known issues:**
- Two IMAP ingestion paths coexist. `EmailSyncService.syncAccount` → `RawEmail` feeds the
  pipeline; `ImapIngestionService.ingestAccount` → `EmailMessage` has no reader anywhere. A fix
  applied to the wrong one is silently ineffective. See the open decision in `context/decisions.md`.
- A 400 from a provider is categorized `auth`, so a bad prompt or model name holds the breaker
  for 12 hours — indistinguishable at a glance from a real quota exhaustion.
- `ClassificationService` reads `AI_MAX_TOKENS` from the environment rather than the `maxTokens`
  on the active `AiProviderConfig` row, so the DB value does not govern the call.
- AI provider API keys are stored in Postgres in plaintext; only `sanitizeConfig` keeps them out
  of responses.
- `ReviewDecision` changes delete and recreate the row, so it is not an audit trail of reviewer
  changes.
- Two `.env` files exist (repo root and `apps/api/`); the API reads the one in its working
  directory, which makes for confusing config drift.
- OAuth connect state is an in-memory `Map` with a 10-minute TTL — an API restart mid-flow
  invalidates it.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Sync, parse, normalize, or classify | `context/pipeline.md` |
| LLM calls, rate limits, circuit breaker | `context/ai-providers.md` |
| IMAP auth, encryption, Google OAuth | `context/credentials.md` |
| Review queue, TUI, digest, launchd | `context/review-and-digest.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it. Narrate what you load: "Loading architecture context..."
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After meaningful work, run this binary checklist:
   - **Ground:** What changed in reality? Name the changed behavior, system, command, dependency, or workflow.
   - **Record:** If project state changed, update the "Current Project State" section above. If documented facts changed, update the relevant `context/` file surgically.
   - **Orient:** If this task can recur and no pattern exists, create one in `patterns/` using `patterns/README.md`, then add it to `patterns/INDEX.md`. If a pattern exists but you learned a gotcha, update it.
   - **Write:** Bump `last_updated` in every scaffold file you changed. If the why matters, run `mex log --type decision "<what changed and why>"` or `mex log "<note>"`.
