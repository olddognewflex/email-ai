# AGENTS.md

## Project
Email AI Cleanup System

## Purpose
Build a self-hosted-friendly AI email triage and cleanup system for IMAP mailboxes.

Primary goals:
- ingest emails safely from IMAP accounts
- normalize and classify messages
- suggest or apply safe cleanup actions
- generate digests for Obsidian
- expose future MCP tools

Secondary goals:
- build a maintainable NestJS modular monolith
- keep AI behavior explainable and auditable

## Tech Stack
- NestJS
- TypeScript
- Prisma
- PostgreSQL
- imapflow
- Zod
- pnpm workspace

## Architecture Style
Use a modular monolith.
Do not introduce microservices unless explicitly requested.
Do not split into multiple deployable services during MVP.

## Repo Structure
- apps/api = main NestJS application
- apps/mcp-server = MCP tool server
- packages/shared = shared types, schemas, constants, utils
- packages/prompts = LLM prompt builders
- packages/mail-client = IMAP abstractions
- prisma = database schema and migrations

## Required Design Principles
- Rules before LLM when possible
- Strong typing everywhere
- Validate all LLM outputs with Zod
- Prefer simple, boring implementations over clever abstractions
- Keep modules cohesive and small
- Every mailbox-changing action must be auditable
- Default to dry-run mode unless explicitly changed
- Prefer review queue over automatic mailbox mutation when uncertain

## Safety Rules
- Never auto-delete emails
- Never implement reply sending unless explicitly requested
- Never silently mutate mailbox state
- Never bypass audit logging for mailbox actions
- Never store raw secrets in code or committed files
- Do not assume an AI classification is safe to act on without thresholds and review logic

## NestJS Guidance
- Use modules only where they represent real domain boundaries
- Avoid excessive boilerplate and fake abstraction
- Use providers/services for real reusable behavior
- Do not add controllers for things not exposed as endpoints
- Keep cron/scheduler logic in dedicated services
- Keep IMAP access isolated behind mail client abstractions

## Initial Domain Modules
- config
- database
- health
- email-accounts
- email-sync
- email-parser
- normalization
- rules-engine
- classification
- review-queue
- actions
- digest
- obsidian-export
- audit

## Build Order
1. Workspace and NestJS app scaffolding
2. Prisma schema and database integration
3. Email account configuration
4. IMAP sync and message persistence
5. Parsing and normalization
6. Rules engine
7. LLM classification with strict validation
8. Review queue endpoints
9. Safe action executor
10. Digest generation
11. Obsidian export
12. MCP server

## Definition of Done
A task is only complete if it includes:
- implementation
- any needed types/schemas
- minimal tests where logic is non-trivial
- docs or README updates if setup/use changed
- verification steps or commands

## Code Quality Rules
- No dead scaffolding
- No speculative abstractions
- No massive service files
- No magic constants without names
- No hidden side effects
- Prefer explicit naming over clever naming

## Expected Agent Behavior
Before implementing:
- read AGENTS.md
- inspect current repo structure
- explain intended file changes
- keep scope tight

When implementing:
- change only what is necessary
- explain tradeoffs
- call out risks and unknowns
- prefer incremental delivery

When reviewing:
- look for overengineering
- look for unsafe mailbox mutation
- look for unvalidated AI output
- look for excessive NestJS ceremony
