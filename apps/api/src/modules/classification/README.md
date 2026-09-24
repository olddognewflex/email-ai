# LLM Email Classification Module

This module provides LLM-based email classification using normalized email content and rule engine output.

Enabled **sender rules** are checked first (see [Sender-rule
pre-check](#sender-rule-pre-check)); a match is classified without any AI
call. Otherwise two classification paths share one output schema. The path
is chosen per email from the **active AI provider**:

- **TypeSafe path** (active provider `typesafe`) — structured state + five
  typed questions, answers mapped deterministically. See
  [TypeSafe path](#typesafe-path).
- **LLM path** (any other provider) — free-text prompt → JSON → Zod.

## Overview

The classification pipeline uses an LLM to analyze emails and produce structured classifications with:

- **Category**: High-level classification (receipt, newsletter, personal, etc.)
- **Importance**: Criticality level for triage decisions
- **Urgency**: Time-sensitivity of the email
- **Recommended Action**: Suggested user action (does NOT auto-execute)
- **Confidence**: LLM confidence in the classification
- **Needs Review**: Flag for manual review when uncertain

## Architecture

```
ClassificationService
├── classifyEmail(id) → EmailClassification (sender rules first, then AI)
├── processUnclassified() → Rule pass, then breaker check + AI loop
└── LLM Provider (mock implementation, replaceable)

Prompt Builder
└── buildClassificationPrompt(input) → Formatted prompt string

Zod Schema Validation
└── EmailClassificationOutputSchema → Runtime validation
```

## API Endpoints

| Method | Path                           | Description                          |
| ------ | ------------------------------ | ------------------------------------ |
| POST   | `/classification/run`          | Process all unclassified emails      |
| POST   | `/classification/:id/classify` | Classify a specific normalized email |

## Classification Categories

- `needs_attention` - Requires user action or decision
- `read_later` - Important but not urgent
- `archive` - Safe to archive after reading
- `delete` - Safe to delete
- `newsletter` - Regular subscriptions/digests (intent: inform)
- `marketing` - Promotions and sales blasts (intent: sell)
- `receipt` - Purchase confirmations, invoices
- `notification` - Automated alerts, system messages
- `social` - Social media, networking
- `personal` - Direct human correspondence
- `unknown` - Unable to classify confidently

## Safety Features

1. **No Auto-Actions**: Classifications suggest actions but never execute them
2. **Schema Validation**: All LLM outputs validated with Zod
3. **Fallback Mode**: An unusable LLM response defaults to `needsReview: true` (TypeSafe failures write no row and are retried)
4. **Audit Trail**: Raw LLM responses stored for debugging
5. **Deterministic Prompts**: Same inputs produce consistent requests

## Usage

### Classify a Single Email

```typescript
POST /classification/:normalizedEmailId/classify
```

**Response:**

```json
{
  "id": "cl...",
  "category": "receipt",
  "importance": "medium",
  "urgency": "none",
  "recommendedAction": "archive",
  "confidence": "high",
  "needsReview": false,
  "reason": "Purchase receipt with order confirmation details",
  "createdAt": "2025-01-15T10:30:00.000Z"
}
```

### Process All Unclassified Emails

```typescript
POST / classification / run;
```

**Response:**

```json
{
  "processed": 50,
  "errors": 0,
  "needsReview": 5
}
```

## TypeSafe Path

When the active provider is `typesafe`, `classifyEmail` calls
`AiProviderService.judgeWith()` instead of `complete()`, with the answer
mapping running inside the breaker guard:

1. `classification.questions.ts` builds the request:
   - `buildClassificationState(input)` →
     `{ email: { from, subject, senderDomain, body }, signals: { isNewsletter, isBulk }, ruleEngine: { category, confidence, reasons } }`.
     Every free-text field is capped so no single email can produce an
     oversized request (a 422): body `MAX_BODY_CHARS` (12,000, with a
     truncation note), from `MAX_FROM_CHARS` (320), subject
     `MAX_SUBJECT_CHARS` (500), domain `MAX_DOMAIN_CHARS` (255), and at most
     `MAX_RULE_REASONS` (10) rule reasons of `MAX_RULE_REASON_CHARS` (200)
     each. `truncateText` never splits a UTF-16 surrogate pair (emoji).
   - `buildClassificationQuestions()` asks five questions in one call
     (table below). Instructions reference state paths with backticks and
     treat `ruleEngine` as a hint, not ground truth.
2. `classification.judgments.ts` — `mapJudgmentsToOutput(answers, input)` is a
   pure function producing `{ output, diagnostics }`:
   - `category` / `recommendedAction` = the chosen labels (validated against
     the shared enums).
   - `importance` / `urgency` = `levels[clamp(round(score))]`.
   - `confidence` = band of `category.confidence` only:
     `>= HIGH_CONFIDENCE_THRESHOLD` (0.75) → `high`,
     `>= MEDIUM_CONFIDENCE_THRESHOLD` (0.5) → `medium`, else `low`.
     The action confidence is left out because several actions are often
     equally acceptable (`unsubscribe` / `delete` / `mark_read` for a promo).
     It is still visible as the action `p=` in `reason`.
   - `needsReview` if **any** of: category is `unknown`; confidence is `low`;
     `sensitive.noul >= SENSITIVE_REVIEW_THRESHOLD` (0.5); the rule engine
     said a different valid category with `high` confidence, unless the two
     are a pair in `RULE_COMPATIBLE_CATEGORIES` (currently `newsletter` ↔
     `marketing` / `notification` / `social`: the rule engine labels every
     bulk or mailing-list sender a newsletter, and TypeSafe separates
     promotions, automated alerts and social mail).
   - `reason` is deterministic and ≤ 500 chars, e.g.
     `receipt (p=0.91) → archive (p=0.84); importance medium (2.10/4), urgency none (0.20/4); review: sensitive (p=0.62)`.
     Scores are shown to 2 decimals and the level is rounded from that
     displayed value, so the two never disagree (2.499 → `2.50` → `high`).
   - The result is validated with `EmailClassificationOutputSchema.parse`.
3. The row is stored with `providerUsed: "typesafe"` and an audit envelope in
   `rawResponse`:
   `{ "questionSetVersion": CLASSIFICATION_QUESTION_SET_VERSION, "reviewPolicyVersion": REVIEW_POLICY_VERSION, "model": "<jev-…>", "raw": "<exact response body text>" }`.
   Bump `CLASSIFICATION_QUESTION_SET_VERSION` in `classification.questions.ts`
   whenever the state shape or question wording changes, and
   `REVIEW_POLICY_VERSION` in `classification.judgments.ts` whenever a
   threshold or review trigger changes. Rows written before the policy
   version existed (the first live runs on 2026-09-22) have no
   `reviewPolicyVersion` and used the older min(category, action) rule.

Question set:

| Question id         | Type   | Answers                                                                                                                                                        |
| ------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `category`          | choice | exactly the `EmailCategorySchema` values; criteria `{ what, not_for, examples }` carry the newsletter-vs-marketing, receipt, security-alert and personal rules |
| `recommendedAction` | choice | exactly the `RecommendedActionSchema` values (a recommendation only — nothing is executed)                                                                     |
| `importance`        | score  | 5 levels `none → low → medium → high → critical`, each a concrete situation                                                                                    |
| `urgency`           | score  | 5 levels `none → eventually → this_week → today → immediate`                                                                                                   |
| `sensitive`         | noul   | P(security / credentials / legal / financial dispute / health — a human should double-check)                                                                   |

Failure handling — **the TypeSafe path never writes a fallback row**. Every
failure propagates, no row is written, and the email stays unclassified for
a later run:

- Provider / breaker / rate-limit errors (`AiProviderError`,
  `BreakerOpenError`), as on the LLM path. `processUnclassified` still stops
  the batch on `BreakerOpenError`.
- `InvalidProviderResponseError` `unparseable` — the 2xx body is not JSON
  (wrong endpoint, proxy). Systemic: a breaker failure (short hold), so the
  next email short-circuits and the batch stops.
- Per-email failures, handled identically by `processUnclassified`:
  - `ProviderRequestRejectedError` — a TypeSafe 422 for this one email;
  - `InvalidProviderResponseError` `invalid_shape` — JSON that fails the
    response schema, or answers that cannot be mapped (missing answer, wrong
    type, label outside the enum, non-finite score).

  The breaker is not held. `processUnclassified` counts each under `errors`,
  logs the email id, and moves on; after `MAX_CONSECUTIVE_REJECTIONS` (3) such
  failures in a row (422 and invalid-shape mixed) it stops the batch
  (remaining emails counted as `skipped`) and logs that the question set or
  API contract is probably broken. Because these record a breaker success, a
  systemic 422 / invalid-shape problem does **not** appear in
  `GET /ai-providers/breaker` — watch for that log line and for `errors` in
  the `POST /classification/run` response.

## Sender-rule pre-check

`classifyEmail` checks the enabled `SenderRule` rows (managed at
`/sender-rules`, see `modules/sender-rules/`) right after the "already
classified" early return and **before** the active provider is looked up.
A match writes the row directly:

| Field               | Value                                                              |
| ------------------- | ------------------------------------------------------------------ |
| `category`          | the rule's category                                                |
| `recommendedAction` | `delete`→`delete`, `archive`→`archive`, `marketing`→`unsubscribe`, else (including `newsletter`) `mark_read` |
| `importance` / `urgency` / `confidence` | `low` / `none` / `high`                      |
| `needsReview`       | `false`                                                            |
| `reason`            | `Sender rule <id>: <matchType> "<pattern>"`                        |
| `rawResponse`       | JSON `{ ruleId, matchType, pattern, matchedOn }`                   |
| `providerUsed`      | `sender-rule`                                                      |
| `senderRuleId`      | the rule id (set to null if the rule is later deleted)             |

The output still goes through `EmailClassificationOutputSchema`; a rule
whose stored category fails it is logged and the email falls through to
the AI path (in a batch, it joins the AI loop). Precedence
when several rules match: `address` > `domain` > `domain_suffix` > `glob` >
`regex`, then the longer pattern, then the older rule, then id.

Rules come from `SenderRulesService.getMatcher()`, which caches the
compiled rules until the next write through `/sender-rules` (restart the
API after editing `SenderRule` rows directly). `processUnclassified` loads
the matcher once, so a running batch uses a snapshot of the rules.

`processUnclassified` runs the rule pass over **every** candidate first,
**before the breaker check**, so rule-matched mail is classified even while
the breaker is open. Only the remaining emails go to the breaker check and
the AI loop below. The result adds `ruleClassified` (a subset of
`processed`). `GET /classification/stats` reports `ruleClassified`
separately and excludes `sender-rule` rows from `aiClassified`.

A `trash` rule classifies exactly like a `classify` rule here. Nothing in
this step touches a mailbox; the move-to-Trash path ships separately.

### Reclassifying already-classified mail

The pre-check only runs for mail with no classification. To apply a new
or edited rule to rows that already exist, use
`POST /sender-rules/:id/reclassify` (module `sender-rule-reclassify`; see
the root README, "Reclassifying existing mail"). It builds rule rows with
the same `buildSenderRuleAttempt` as this path, so an updated or claimed
row is identical to what `classifyEmail` would write. It compiles a fresh
matcher from the database per run instead of using `getMatcher()`'s
per-process cache. A released row is deleted and passed back through
`classifyEmail` with that matcher (rules first, then AI). A release that
needs the AI is never stranded without a row:
- While the breaker is open, or after 3 consecutive provider failures in
  the run, the row is not deleted. It is kept, flagged `needsReview`.
- If `classifyEmail` fails after the delete, the previous values are
  restored, flagged `needsReview`.

Both count as `deferred`. Each change is recorded in
`ClassificationRevision` and can be undone per batch. Rows with a
`ReviewDecision` are never changed; the row is locked
(`SELECT … FOR UPDATE`) before that check. Past digest files are not
rewritten.

`processUnclassified` walks unclassified emails in a deterministic order
(`rawEmail.internalDate` descending, then id), newest first. Emails that
keep failing per-email write no row and stay unclassified; newest-first sinks
them to the tail so a consecutive-rejection stop defers only them, not new
mail.

A fallback row would mark the email "done" with a useless classification and
never be retried. The LLM path keeps its fallback-row behavior for
unparseable completions.

Activate it with `POST /ai-providers { "provider": "typesafe", "apiKey": "…", "model": "jev-latest" }`
then `POST /ai-providers/:id/activate`. See the ai-provider README for the
breaker caveat on TypeSafe 422s.

## Prompt Structure (LLM path)

The LLM prompt includes:

1. **Email Metadata**: From, Subject, Domain, Newsletter indicators
2. **Rule Engine Output**: Pre-classification category and confidence
3. **Cleaned Content**: Normalized email body text
4. **Schema Definition**: Exact JSON structure expected
5. **Guidelines**: Category-specific rules and heuristics

## Error Handling

Provider, breaker and rate-limit failures propagate (no row written; retried
next run). On the **LLM path**, a response that arrived but is unusable
(invalid JSON, schema validation failure) produces a fallback row (the
TypeSafe path never does — see [TypeSafe Path](#typesafe-path)):

1. Classification is stored with `needsReview: true`
2. `category` is set to `"unknown"`
3. `confidence` is set to `"low"`
4. `reason` explains the failure
5. `classificationError` stores the technical error

## Implementation Details

### Provider selection

The provider comes from the active `AiProviderConfig` row (see the
ai-provider module). With no active config the LLM path uses
`MockLlmProvider`, which returns keyword-based classifications without a
network call.

### Schema Validation

All LLM outputs are validated against `EmailClassificationOutputSchema`:

```typescript
{
  category: EmailCategorySchema,        // enum validation
  importance: ImportanceLevelSchema,    // enum validation
  urgency: UrgencyLevelSchema,          // enum validation
  recommendedAction: RecommendedActionSchema,  // enum validation
  confidence: ConfidenceLevelSchema,    // enum validation
  needsReview: z.boolean(),
  reason: z.string().min(1).max(500)
}
```

## Database Schema

```prisma
model EmailClassification {
  id                   String    @id @default(cuid())
  normalizedEmailId    String    @unique
  category             String
  importance           String
  urgency              String
  recommendedAction    String
  confidence           String
  needsReview          Boolean   @default(true)
  reason               String
  rawResponse          String?   // Stored for audit/debugging
  classificationError  String?   // Set on failure
  createdAt            DateTime  @default(now())

  normalizedEmail      NormalizedEmail @relation(fields: [normalizedEmailId], references: [id], onDelete: Cascade)

  @@index([category])
  @@index([needsReview])
  @@index([createdAt])
}
```

## Verification Steps

### 1. Test Basic Classification

```bash
# Start the dev server
pnpm --filter @email-ai/api start:dev

# In another terminal, run normalization first (needs normalized emails)
curl -X POST http://localhost:3000/normalization/run

# Get a normalized email ID and classify it
NORMALIZED_ID=$(curl -s http://localhost:3000/email-accounts | jq -r '.[0].id' | head -c 20)
# Actually get from your database or use a known ID

# Classify a specific email
curl -X POST http://localhost:3000/classification/$NORMALIZED_ID/classify
```

### 2. Test Batch Processing

```bash
# Process all unclassified emails
curl -X POST http://localhost:3000/classification/run
```

### 3. Verify Schema Validation

Test that invalid LLM responses are caught:

```typescript
// This should fail validation and fallback to needsReview
const invalidResponse = await classificationService.classifyEmail(id);
console.log(invalidResponse.needsReview); // true
console.log(invalidResponse.classificationError); // Error message
```

### 4. Check Database Storage

```bash
# Connect to database and query classifications
docker compose exec postgres psql -U email_ai -d email_ai -c "
  SELECT category, importance, confidence, needs_review, reason
  FROM email_classification
  LIMIT 5;
"
```

### 5. Test Error Handling

Verify fallback behavior when LLM fails:

```typescript
// Temporarily break the LLM provider to test fallback
// Result should have:
// - category: "unknown"
// - needsReview: true
// - classificationError: "Error message"
```

## Integration with Pipeline

The classification module fits into the email processing pipeline:

```
Raw Email → Parse → Normalize → Rule Classification → LLM Classification
                                            ↓
                                    EmailClassification (stored)
```

Classification depends on:

- **ParsedEmail** - Source of subject, from, etc.
- **NormalizedEmail** - Source of cleanedText, rule output
- **RulesEngine** - Pre-classification input for LLM context

## Future Enhancements

1. **Real LLM Integration**: Replace MockLlmProvider with OpenAI/Anthropic
2. **Prompt Versioning**: Track prompt versions for reproducibility
3. **Confidence Thresholds**: Auto-flag low-confidence classifications
4. **User Feedback Loop**: Learn from manual corrections
5. **Multi-Provider Support**: Compare results across LLM providers

## Constraints

- Never auto-execute actions based on classification
- Always validate LLM output before storing
- Default to `needsReview: true` when uncertain
- Store raw responses for audit and debugging
- Keep prompts deterministic and versioned
