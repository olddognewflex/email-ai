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
| POST   | /email-sync/:id/run?dryRun=true | Sync one account from IMAP (default dry-run)    |
| POST   | /email-sync/run-all?dryRun=true | Sync all active accounts (default dry-run)      |
| GET    | /email-sync/:id/states          | Sync state per mailbox                         |
| POST   | /email-parser/run               | Parse all unprocessed raw emails               |
| POST   | /email-parser/:id/parse         | Parse a single raw email                       |
| POST   | /normalization/run              | Normalize all unparsed emails                  |
| POST   | /normalization/:id/normalize    | Normalize (or reprocess) a single parsed email |
| POST   | /normalization/reprocess        | Reprocess all already-normalized emails        |
| POST   | /classification/run             | Classify today's unclassified emails (default) |
|        |                                 | `?since=YYYY-MM-DD` cutoff, `?all=true` backfill |
| POST   | /classification/:id/classify    | Classify a single normalized email             |
| GET    | /classification/stats           | Get classification statistics                  |
| GET    | /ai-providers                   | List AI provider configurations                |
| GET    | /ai-providers/available         | List available AI provider types               |
| POST   | /ai-providers                   | Create AI provider configuration               |
| PUT    | /ai-providers/:id               | Update AI provider configuration               |
| POST   | /ai-providers/:id/activate      | Set active AI provider                         |
| DELETE | /ai-providers/:id               | Delete AI provider configuration               |
| GET    | /review-queue                   | List classifications pending review (last 14 days) |
|        |                                 | `?days=N`, `?since=YYYY-MM-DD`, `?all=true`    |
| GET    | /review-queue/actionable        | List actionable emails (last 14 days)          |
|        |                                 | same `days` / `since` / `all` params           |
| POST   | /review-queue/:id/approve       | Approve a classification                       |
| POST   | /review-queue/:id/reject        | Reject a classification                        |
| GET    | /sender-rules                   | List sender rules                              |
| GET    | /sender-rules/:id               | Get one sender rule (404 if missing)           |
| POST   | /sender-rules                   | Create a rule → `{ rule, warnings }` (409 dup) |
| PATCH  | /sender-rules/:id               | Update a rule (re-validated) → `{ rule, warnings }` |
| DELETE | /sender-rules/:id               | Delete a rule (204)                            |
| POST   | /sender-rules/preview           | Count stored mail a pattern would match (DB only) |
| GET    | /sender-rules/suggestions       | Suggest rules for look-alike promo families (read-only) |
|        |                                 | `?minEmails=20&minShare=0.9&provider=typesafe` |
| GET    | /digest                         | Get daily digest as JSON                       |
| POST   | /digest/generate                | Generate and save digest to file system        |

`dryRun=true` (default) connects to IMAP and counts new messages without writing to the database.
Pass `dryRun=false` to persist raw emails.

## Daily Digest & Obsidian Export

Generate daily email digests grouped by actionability and export to Obsidian-compatible markdown.
A digest for a date covers emails **received** that day (local time), regardless of when they
were classified.

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

Configure AI providers for email classification. Supports TypeSafe (Jev), OpenAI, Anthropic (Claude), Mistral, Google (Gemini), Kimi, and DeepSeek.

### Supported Providers

| Provider  | Type        | Default Model        | Notes                                       |
| --------- | ----------- | -------------------- | ------------------------------------------- |
| TypeSafe  | `typesafe`  | jev-latest           | Typed judgments, not a prompt; see below    |
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

### TypeSafe (Jev)

With `typesafe` active, classification makes one TypeSafe System One call per
email instead of sending a free-text prompt. The call asks five typed
questions:

| Question            | Type   | Answer                                          |
| ------------------- | ------ | ----------------------------------------------- |
| `category`          | choice | one of the 11 categories (`unknown` = no match) |
| `recommendedAction` | choice | one of the 10 actions (a recommendation only)   |
| `importance`        | score  | 5 levels, `none` → `critical`                   |
| `urgency`           | score  | 5 levels, `none` → `immediate`                  |
| `sensitive`         | noul   | probability a human should double-check         |

Code maps the answers to the stored fields. `confidence` comes from the
category confidence alone, because several actions are often equally
reasonable. `needsReview` is set when the category is `unknown`, confidence
is low, the email looks sensitive, or TypeSafe disagrees with a
high-confidence rule-engine result. The rule engine labels every bulk sender
a newsletter, so it doesn't count as a disagreement when TypeSafe picks
`marketing`, `notification` or `social` instead.
`reason` is a fixed-format summary of the probabilities. `rawResponse` stores
the question-set version, the review-policy version, the model and the exact
response body for audit.

TypeSafe charges for input tokens only, and output tokens are free. A typical
email is about 4–5k input tokens.

```bash
curl -X POST http://localhost:3000/ai-providers \
  -H "Content-Type: application/json" \
  -d '{ "provider": "typesafe", "apiKey": "<TYPESAFE_API_KEY>", "model": "jev-latest" }'

curl -X POST http://localhost:3000/ai-providers/{id}/activate
```

`apiEndpoint` is optional and defaults to `https://api.typesafe.ai`.
`temperature` and `maxTokens` are ignored. On the TypeSafe path a bad
response never writes a fallback row: the email stays unclassified and is
retried on the next run. See the
[classification README](apps/api/src/modules/classification/README.md) for the
question wording, review thresholds and failure handling.

> The dev API and the launchd API share one database, so activating a
> provider in one also activates it in the other. Both must run a build that
> includes TypeSafe support before you activate `typesafe`.

### Rate Limiting

The AI provider service includes automatic rate limiting and exponential backoff to prevent 429 errors from API providers. By default, it limits requests to 20 per minute with 3 retries and exponential backoff.

See the [AI Provider README](apps/api/src/modules/ai-provider/README.md) for details on configuring rate limits for your specific provider.

### Sender rules

Sender rules classify mail from known bulk senders **before any AI call**
(no cost, not affected by the circuit breaker). Each rule has a `pattern`, a
`matchType`, an `action` (`classify` or `trash`), a `category`, and an
`enabled` flag:

| `matchType`     | Matches                                                            |
| --------------- | ------------------------------------------------------------------ |
| `address`       | exact from-address, case-insensitive                               |
| `domain`        | exact sender domain                                                |
| `domain_suffix` | the domain and its subdomains (`kick.com` does not match `songkick.com`) |
| `glob`          | anchored. Without `@` it matches the domain and `*`/`?` stay within one label (`news.*.com` matches `news.foo.com`, not `news.a.b.com`). With `@` it matches the full address: before `@`, `*`/`?` also match dots (`*@kickstargo.com` matches `first.last@kickstargo.com`); after `@` they stay within one label |
| `regex`         | case-insensitive and **unanchored**: `backer` matches anywhere in the domain, so write `^backer[a-z]+\.com$` for a whole domain. ≤200 chars, must compile, no nested, optional or ambiguous repetition (`(a+)+`, `(a\|b)*`, `(x+)?`), at most 3 unbounded quantifiers (`*`, `+`, `{n,}`). Case is folded outside `[...]`; character classes are stored as written. An `@` in the pattern targets the full address |

When several rules match, `address` > `domain` > `domain_suffix` > `glob` >
`regex` wins, then the longer pattern, then the older rule. Matched mail is
stored with `providerUsed: "sender-rule"` and `needsReview: false`. Rules
only classify mail that has no classification yet; they never reclassify.

Patterns are stored lowercased (for a regex, escapes such as `\S` are kept
as written), so rules that differ only in case are duplicates (409).

```bash
# Preview what a pattern would catch in stored mail (read-only)
curl -X POST localhost:3000/sender-rules/preview \
  -H 'content-type: application/json' \
  -d '{"pattern":"news.*.com","matchType":"glob"}'

curl -X POST localhost:3000/sender-rules \
  -H 'content-type: application/json' \
  -d '{"pattern":"news.*.com","matchType":"glob","category":"marketing"}'
```

Invalid or too-broad patterns return 400: a regex that does not compile or
could backtrack catastrophically, a glob or regex that matches ordinary
senders such as `gmail.com` or `noreply@outlook.com` (`.*`, `com`, `*.com`,
`*@*.com`, local-part-only rules like `^noreply@`), a glob whose domain is only a public suffix (`*.co.uk`), or a
`domain_suffix` that is a public suffix (`com`, `co.uk`, `com.au`). A single
provider belongs in an `address`, `domain` or `domain_suffix` rule. A rule
that would also match a known legitimate
look-alike (`kickstarter.com`, `*.backerkit.com`, `pledgebox.com`,
`songkick.com`) is saved, and the response lists a warning.

Preview returns `matchedEmails` (all stored mail the pattern matches),
`unclassifiedMatches` (the part a new rule would actually classify), the
top 25 domains, and any protected hits.

The API caches the compiled rules and refreshes the cache only when a rule
is written through `/sender-rules`. After editing `SenderRule` rows
directly in the database, restart the API. A classification run uses the
rules as they were when it started.

#### Rule suggestions

`GET /sender-rules/suggestions` looks at classification history and
proposes rules. It is read-only: it never creates a rule. For each sender
domain it counts the mail classified by `provider` (default `typesafe`)
and the share of it that was `marketing` or `newsletter`. Domains with at
least `minShare` (default 0.9) qualify, unless they are protected
look-alikes or an enabled rule already covers them. Qualifying domains are
grouped into families, and families with fewer than `minEmails` (default
20) emails in total are dropped:

| `kind`           | Grouping                                                    |
| ---------------- | ----------------------------------------------------------- |
| `news-subdomain` | two or more `news.<name>.<tld>` domains (a `news.*.<tld>` glob needs three or more) |
| `prefix`         | three or more second-level labels sharing a leading token of 5+ characters (`kickstar*`, `backer*`) |
| `single`         | one registrable domain and any of its qualifying subdomains |

The registrable domain in `single` comes from a simple heuristic: a small
public-suffix denylist, not the full Public Suffix List. So hosts under a
shared suffix it doesn't know, such as `com.tr` or `blogspot.com`, can end
up in one family even when they are unrelated senders. The proposals are
still exact `domain` rules, one per host, so nothing broader is created.
Punycode (`xn--`) labels are never grouped by prefix.

Each family proposes `classify` rules with the family's majority category.
A family glob (`news.*.com`, `promozone*.net`) is proposed only when it
passes the same validation as `POST /sender-rules` and would not match a
protected sender (probed with common subdomains such as
`news.kickstarter.com`) or an observed domain below the share threshold.
Otherwise every member gets its own `domain` rule and the senders the glob
would have caught are listed in `excludedLegit`. In practice `kickstar*.com`
(hits `kickstarter.com`), `backer*.com` (`backerkit.com`) and `news.*.com`
(`news.kickstarter.com`) all fall back to domain rules. Subdomains
(`mail.x.com`) always get `domain` rules, never a wildcard.

```bash
curl 'localhost:3000/sender-rules/suggestions?minEmails=20&minShare=0.9'
# { "families": [ { "key": "kickstar*.com", "kind": "prefix", "totalEmails": 329,
#     "domains": [{ "domain": "kickstargo.com", "total": 41, "share": 1 }, ...],
#     "proposedRules": [{ "pattern": "kickstargo.com", "matchType": "domain",
#                         "action": "classify", "category": "marketing" }, ...],
#     "excludedLegit": ["kickstarter.com"] }, ... ] }
```

#### TUI keys

In `eai`, `x` (list and detail) blocks the current sender: pick **this
address** or **this domain**, then `trash` (default, category `delete`) or
`classify` with a category. The prompt shows how much stored mail the rule
matches before you confirm, and only `y` creates the rule (Enter does not),
once that count has loaded. The rule is saved with `source: "tui"` and note
`tui:block <classificationId>`. A duplicate reports "Rule already exists
(see R)". `R` lists rules (space enables/disables a rule, `d` deletes it
after y/n). `G` shows suggestions. `c` opens a confirm panel for the
selected family. The panel lists every rule to be created and, for each
glob, the preview count and protected hits. `y` then creates the rules.

`action: "trash"` rules (category defaults to `delete`) currently only
classify. Moving mail to Trash, the `MAILBOX_WRITES_ENABLED` kill switch,
the audit log and undo come in a later change; **no mailbox is modified by
sender rules today**.

### Classification Statistics

Track how many emails have been classified and which path was used (AI provider vs fallback; TypeSafe rows show as `typesafe`, sender-rule rows as `sender-rule` and count under `ruleClassified`, not `aiClassified`):

```bash
curl http://localhost:3000/classification/stats
```

Response:

```json
{
  "total": 150,
  "byProvider": {
    "openai": 120,
    "fallback": 30
  },
  "aiClassified": 120,
  "ruleClassified": 0,
  "fallbackClassified": 30,
  "needsReview": 15,
  "byCategory": {
    "receipt": 45,
    "newsletter": 35,
    "personal": 20,
    "notification": 15,
    "unknown": 35
  }
}
```

### Fallback Behavior

If no AI provider is active, classification uses the Mock provider, which returns keyword-based classifications without making external API calls. If the active provider fails (network error, quota, auth), the error propagates and the email stays unclassified for a later run; the circuit breaker pauses AI calls where appropriate. Only an unparseable response on the LLM prompt path writes a `fallback` row (`unknown`, needs review).

## Workspace structure

```
apps/api                          NestJS application
apps/api/prisma/                  Database schema and migrations
apps/api/src/modules/ai-provider/ AI provider configuration and adapters
packages/shared                   Shared Zod schemas and TypeScript types
```
