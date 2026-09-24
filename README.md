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

Every non-GET request needs an `X-Email-AI-Client` header (any value), and the `Host` header must be the API's own local address. See *Network exposure* under [Moving mail to Trash](#moving-mail-to-trash-trash-rules).

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
| GET    | /sender-rules/:id               | Get one sender rule with `_count.classifications` (404 if missing) |
| POST   | /sender-rules                   | Create a rule → `{ rule, warnings }` (409 dup) |
| PATCH  | /sender-rules/:id               | Update a rule (re-validated) → `{ rule, warnings }` |
| DELETE | /sender-rules/:id               | Delete a rule (204)                            |
| POST   | /sender-rules/preview           | Count stored mail a pattern would match (DB only) |
| GET    | /sender-rules/suggestions       | Suggest rules for look-alike promo families (read-only) |
| GET    | /sender-rules/match             | Which enabled rule covers `?address=`/`?domain=` (read-only) |
|        |                                 | `?minEmails=20&minShare=0.9&provider=typesafe` |
| POST   | /sender-rules/apply             | Apply enabled `trash` rules to INBOX. **Dry run unless `dryRun=false`** |
|        |                                 | `?dryRun=true&ruleId=&accountId=&limit=200`; `dryRun=false` needs the kill switch (else 403) |
| POST   | /sender-rules/:id/reclassify    | Re-run a rule over already-classified mail (DB only). **Dry run unless `dryRun=false`** |
|        |                                 | `?dryRun=true&scope=linked\|matching&release=reclassify\|mark_review&limit=500` (max 5000); 404 unknown rule |
| POST   | /sender-rules/reclassify-batches/:batchId/undo | Restore a reclassify batch → `{ batchId, counts: { restored, conflicts, skippedReviewed, alreadyUndone } }`; 404 unknown batch |
| GET    | /mailbox-actions                | Mailbox-write audit log, newest first (`?limit=50&accountId=&status=`) |
| GET    | /mailbox-actions/status         | `{ writesEnabled }` — kill-switch state (no IMAP)  |
| POST   | /mailbox-actions/:id/undo       | Move a trashed message back to INBOX → `{ original, restore }` |
|        |                                 | 403 writes disabled · 404 unknown · 409 not a succeeded move / already undone · 502 not found in Trash |
| POST   | /mailbox-actions/reconcile      | Resolve `pending`/`unknown` actions: exact-UID check, then Message-ID (read-only on IMAP) |
|        |                                 | `?accountId=`; kill switch required                |
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

#### Reclassifying existing mail

A rule only classifies mail that has no classification yet, so creating
or editing a rule leaves existing rows as they were.
`POST /sender-rules/:id/reclassify` re-runs one rule over mail that is
already classified. It changes classification rows only and never
touches the mailbox. It is a dry run unless you pass `dryRun=false`: the
dry run writes nothing and returns the counts and a sample (up to 20
rows, each with the old and new category).

It uses the same matcher and precedence as classification, over enabled
rules only. The rules are read fresh from the database on every run, so
an edit made through the other API process (dev or launchd) is seen too.
A disabled rule never wins, so all its linked rows are released and
`scope=matching` claims nothing.

- `scope=linked` (default) looks at the rows this rule wrote
  (`senderRuleId = id`):
  - **update**: the rule still wins for the sender and its output changed
    (for example a new category). The row is rewritten with the rule's
    current output. If nothing differs, the row is counted as `unchanged`.
    The output includes `reason` and `rawResponse`, which name the
    pattern, so an edit that only changes the pattern still counts
    every row it still matches as `update`, with the category unchanged.
  - **release**: the rule no longer matches, or another rule now wins.
- `scope=matching` also **claims** already-classified mail from any
  provider, TypeSafe included, whose sender this rule now wins. It never
  claims rows another rule wins. A claimed row becomes a rule
  classification (`providerUsed: "sender-rule"`, `senderRuleId`,
  `needsReview: false`).

What happens to released rows depends on `release`:

- `release=reclassify` (default): the row is deleted and the email is
  classified again in the same request, through the normal path (rules
  first, then the active AI provider). `aiCalls` counts the AI
  classifications, and `estimatedAiCostUsd` is about $0.0002 per email
  on TypeSafe (`null` for a provider with no estimate). A dry run reports
  the expected AI calls: released rows no other rule covers. A released
  email is never left without a classification row:
  - A release that another rule covers is reclassified by that rule
    even while the AI breaker is open.
  - A release that needs the AI is not deleted while the breaker is open,
    or once three AI calls in a row have failed in this run. The row is
    kept with its previous values and `needsReview: true`, with the reason
    `Sender rule <id> no longer matches; AI unavailable, flagged for review
    (reclassify <batchId>)`.
  - If the AI call fails after the row was deleted, the previous values
    are put back straight away (same id) with that same reason.

  All three flagged cases count as `deferred`, and the response sets
  `aiUnavailable: true`. The rows stay linked to the rule, so running the
  reclassify again once the AI is back retries them. They also appear in
  the review queue.
- `release=mark_review`: the row is kept, with `needsReview: true` and
  the reason `Sender rule <id> no longer matches (reclassify <batchId>)`.
  No AI call is made.

Rows with a `ReviewDecision` (approved, rejected or recategorized) are
never changed and are counted as `skippedReviewed`. `limit` (default
500, max 5000) caps the number of changes in one run, and `more: true`
means some remain. Run it again to continue.

```bash
# Dry run: what would change for this rule?
curl -X POST -H 'X-Email-AI-Client: me' \
  'http://127.0.0.1:3000/sender-rules/<ruleId>/reclassify?scope=matching'
# Apply it
curl -X POST -H 'X-Email-AI-Client: me' \
  'http://127.0.0.1:3000/sender-rules/<ruleId>/reclassify?scope=matching&dryRun=false'
# Undo that run
curl -X POST -H 'X-Email-AI-Client: me' \
  'http://127.0.0.1:3000/sender-rules/reclassify-batches/<batchId>/undo'
```

**Audit and undo.** Each change in a live run writes one
`ClassificationRevision` row (action `update`, `claim` or `release`),
holding the previous values and the new ones. The revision is written
in the same transaction as the change. All rows from one run share the
`batchId` returned in the response.
`POST /sender-rules/reclassify-batches/:batchId/undo` restores the
previous values. It restores a row only if it is still exactly as the
batch left it (or still unclassified, for a deferred release). Rows
changed again since then count as `conflicts`, and rows that have
gained a `ReviewDecision` count as `skippedReviewed`. Both are left as
they are.

The review queue and the actionable views read live rows, so changes
show up there straight away. **Past digest files are not rewritten.**
The hourly digest regenerates only today's and yesterday's files, so an
older digest keeps the categories it was written with.

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
(see R)". If an enabled rule already covers the sender, the confirm step
says so ("Already covered by domain "x.com"") but still lets you create
the more specific rule, for example as an exception.

`u` (list and detail) opens the email's unsubscribe link and, once `open`
succeeds, also blocks the sender's **address** (never the domain): a
`trash` rule with note `tui:unsubscribe <classificationId>`. Unsubscribing
can take days to take effect, and blocking catches the mail that keeps
arriving. It checks `GET /sender-rules/match` first and creates nothing
when an enabled rule already covers the sender. If there is no link, the
open fails, or the API returns an error, no rule is created. Set
`EAI_BLOCK_ON_UNSUBSCRIBE=0` (or `false`/`no`/`off`) to only open the link.

`z` (list and detail) undoes the most recent rule created in this TUI
session by `x` or `u`: it asks "Remove rule <pattern>? y/n" and deletes
it. Rules created in earlier sessions are removed from `R` instead.

`R` lists rules (space enables/disables a rule, `e` edits it, `C`
reclassifies existing mail for it, `d` deletes it after y/n).

`e` opens an edit form pre-filled with the selected rule: pattern and
note are text fields, match type and action are pickers (left/right),
category opens the category picker (required for `classify`; switching
to `trash` defaults it to `delete`, as the API does), and space toggles
enabled. Move with up/down or tab; "Review changes" shows what changed.
Only the changed fields are sent (`PATCH /sender-rules/:id`), so the
rule keeps its id, source and creation date. When the pattern or match
type changed, the review shows the preview count, top domains and
protected hits. When the edit makes the rule move mail (classify to
trash, a trash rule's new pattern or match type, or re-enabling a trash
rule), it also warns "This rule will move matching mail to Trash when
mailbox writes are enabled" and shows what the saved rule currently
would move (a dry run of `/sender-rules/apply` scoped to that rule; the
preview count is the edited rule's). Only `y` saves, once those counts
have loaded; Enter never saves and `n`/esc go back to the form. A
validation error appears under its field with your input kept; a
duplicate says "A rule with this pattern already exists (see R)". Edits
never reclassify mail by themselves: after a change to pattern, match
type or category the TUI says how many existing classifications stay
linked and unchanged (`GET /sender-rules/:id` includes
`_count.classifications`). After a change to pattern, match type,
category, or a switch to `classify`, it also says "Press C to reclassify
existing mail for this rule"; the edited rule stays selected.

`C` on a rule opens the reclassify screen (see "Reclassifying existing
mail" above). It starts with a **dry run** for `scope=linked` and shows
the counts (update, claim, release, skipped because reviewed, unchanged,
and deferred), the expected AI calls and estimated cost, the
`aiUnavailable` notice, whether more remain beyond the limit (200 in the TUI, smaller than the
API default of 500 so a run that calls the AI finishes within the HTTP
client's timeout; run again to continue), and
a sample of old → new categories with sender and subject. `s` toggles
the scope (linked/matching) and `m` the release mode
(reclassify/mark_review); each runs a new dry run, and `r` re-runs it.
Only `y` applies (Enter never does), and only once the dry run for the
current scope and release mode has loaded. If that dry run expects AI
calls, the first `y` shows "N emails will be re-classified by
<provider> (~$X)" and a second `y` applies; `n`/esc cancels. With
nothing to change, `y` just says so. The live run can take a while when
it calls the AI; keys wait until it finishes. The result shows the live
counts, the batch id and, when the AI was unavailable, how many emails
kept their classification and were flagged for review. `U` undoes that
batch after y/n and shows restored, conflicts, skipped (reviewed) and
already-undone counts. After an apply or undo, press `r` for a fresh dry
run before applying again. Against an older API the screen says "This
API version doesn't support reclassify yet".

`G` shows suggestions. `c` opens a confirm panel for the
selected family. The panel lists every rule to be created and, for each
glob, the preview count and protected hits. `y` then creates the rules.

`M` (list) opens **mailbox actions**: the `MailboxAction` audit log,
newest first, with the kill switch shown in the header (writes enabled or
disabled). Each row shows the status (colour-coded), the action, when,
the sender, the subject, and the matching rule or the error/skip reason.
`j`/`k` move, `f` cycles a status filter (all, succeeded, unknown,
pending, failed, skipped, undone), and `r` refreshes.

- `u` on a succeeded move to Trash asks "Move back to INBOX?" and, on `y`,
  calls undo. API refusals are shown as returned: 403 writes disabled,
  404 unknown action, 409 not a succeeded move or already undone, 502
  not found in Trash.
- `p` previews an apply run: totals plus a would-move count per rule and
  account. It is **always a dry run**. The TUI has no way to send
  `dryRun=false`; live moves come only from the hourly job.
- `c` runs reconcile after a y/n confirm and shows the counts it returns.
  Reconcile resolves only `pending`/`unknown` rows older than 10 minutes.
  Undo and reconcile both need the kill switch on.

Against an API that predates these endpoints, the screen says the API
version doesn't support mailbox actions yet.

#### Moving mail to Trash (`trash` rules)

**Network exposure.** The API has no authentication. Three layers keep it
local:

- **Bind address.** It listens on **127.0.0.1 only**. Set `EMAIL_AI_HOST`
  to change it; a non-loopback value logs a warning at startup.
- **Host header check (DNS rebinding).** Every request whose `Host`
  header is not exactly `127.0.0.1:<PORT>` or `localhost:<PORT>` gets a
  403. `[::1]:<PORT>` is also accepted when bound to `::1`, and
  `<EMAIL_AI_HOST>:<PORT>` when that is a non-loopback address. A page
  on another site that re-points its own hostname at 127.0.0.1 therefore
  gets a 403 for GETs and POSTs alike.
- **`X-Email-AI-Client` header (cross-site requests).** Every request
  except GET/HEAD/OPTIONS must carry this header with any non-empty value,
  or it gets a 403. A browser cannot add a custom header to a cross-site
  request without a CORS preflight, and the API enables no CORS. So a
  page on another origin cannot send the API state-changing requests:
  moves, undo, reconcile, rule edits, sync, review decisions made by
  POST, and so on.

The `eai` TUI and `scripts/daily-digest.sh` send the header on every
request. With curl, add `-H 'X-Email-AI-Client: me'`, including for
`POST /email-accounts/...` and `POST /email-sync/...`.

What this does **not** protect:
- **Local processes.** Any program running as you on this machine can
  call the API, header included.
- **GET routes that change state.** The HTML review UI's approve/reject
  links (`GET /review/:id/approve`, `GET /review/:id/reject`) are not
  header-checked. That is a known residual. They record review decisions
  only, never touch a mailbox, and a rejection only *prevents* trashing.
  A cross-site page can still trigger them blind (for example as an
  image URL), because only the Host check applies to them.

`action: "trash"` rules (category defaults to `delete`) classify like any
other rule. They can also move matching INBOX mail to the account's Trash
folder. This is the **only** way the system changes a mailbox, and it is
off by default:

- **Kill switch.** Moves and undo happen only when the API was started
  with `MAILBOX_WRITES_ENABLED=true`, the exact lowercase string. Any other
  value, or unset, keeps the system read-only. The value is read at startup,
  so restart the API after changing it:
  `launchctl kickstart -k gui/$(id -u)/com.odnf.email-ai.api`.
  Check the live state with `GET /mailbox-actions/status`.
- **Dry run first.** `POST /sender-rules/apply` is a dry run unless you pass
  `dryRun=false`. A dry run reads the database only (no IMAP connection)
  and writes no audit rows. It reports, per rule and account, how much
  INBOX mail matches, how much this run would move (`selected`, capped by
  `limit`, default 200, max 1000, across the whole run), and up to 10
  samples. `dryRun=false` while the kill switch is off returns 403. It is
  never silently turned into a dry run.
- **Scope.** The whole INBOX backlog whose sender's *winning* rule is an
  enabled `trash` rule. Precedence is the same as classification, so an
  `address` classify rule for `friend@promo.example` protects that sender
  from a `domain` trash rule for `promo.example`. Mail is left alone when:
  - you rejected or recategorized its classification in review;
  - it already has a pending, succeeded, skipped or unknown move;
  - it was **ever trashed before**, matched by Message-ID. That covers
    mail restored with undo, and mail you dragged back to the inbox in your
    mail client, which comes back under a new UID. The system never re-trashes
    what you rescued.
- **What a move is.** An IMAP `UID MOVE` into the folder the server
  advertises as `\Trash` (SPECIAL-USE), so Gmail's `[Gmail]/Trash` is
  found by flag, not by name. A server without the `MOVE` extension, or
  without an advertised `\Trash`, is refused. The code never flags
  `\Deleted`, never expunges, and never deletes permanently. Before moving,
  each message's identity is re-checked on the server (UIDVALIDITY and
  Message-ID). Anything that cannot be confirmed is skipped, not moved.
- **Audit.** Every attempt is recorded in `MailboxAction`: a `pending` row
  is written before the MOVE and updated to `succeeded` / `failed` after it.
  Skipped messages get a `skipped` row with the reason. List them with
  `GET /mailbox-actions`.
  - **One active move per message** is enforced by the database: partial
    unique indexes on (account, UIDVALIDITY, UID) and on the RawEmail. Two
    API processes (dev :3000 and launchd :3100 share the database) can
    never both move the same message; the loser records `already_in_progress`.
  - If the server's reply to a MOVE is lost and the follow-up check cannot
    tell whether the message moved, the row is marked `unknown`. Such rows
    are never retried. `POST /mailbox-actions/reconcile` resolves them, and
    any row stuck `pending`, by looking each message up by Message-ID in
    INBOX and Trash. It only reads the mailbox; it never moves anything.
    Rows younger than 10 minutes are left alone, since they may still be in
    flight. Found in Trash → `succeeded`, which makes the move undoable.
    Still in INBOX → `failed`. Stuck undos are resolved the same way.
  - The audit trail is kept: an email account that has mailbox actions
    cannot be deleted (409).
- **Undo.** `POST /mailbox-actions/:id/undo` moves the message from Trash
  back to **INBOX** (the kill switch must be on). Gmail labels are recorded
  on the audit row but **not re-applied** on undo. An undone message is
  never moved again by the rules.
- **Trash is purged by the server.** Gmail empties Trash after 30 days;
  other providers may purge it sooner, or on a schedule you set. After
  that, undo returns 502 (not found in Trash) and the message is gone.

The hourly `scripts/daily-digest.sh sync` job runs the apply step after
classification. It moves mail only when `/mailbox-actions/status` reports
`writesEnabled: true`; otherwise it runs a dry run and logs the would-move
totals.

```bash
# What would move (safe; the default). Every POST needs the header.
curl -X POST -H 'X-Email-AI-Client: me' 'http://127.0.0.1:3000/sender-rules/apply'
# Recent mailbox actions, and undo one
curl 'http://127.0.0.1:3000/mailbox-actions?limit=20'
curl -X POST -H 'X-Email-AI-Client: me' http://127.0.0.1:3000/mailbox-actions/<id>/undo
# Resolve pending/unknown actions (read-only on IMAP)
curl -X POST -H 'X-Email-AI-Client: me' 'http://127.0.0.1:3000/mailbox-actions/reconcile'
```

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
