# LLM Email Classification Module

This module provides LLM-based email classification using normalized email content and rule engine output.

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
├── classifyEmail(id) → EmailClassification
├── processUnclassified() → Batch process all unclassified emails
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
- `newsletter` - Regular subscriptions/digests
- `receipt` - Purchase confirmations, invoices
- `notification` - Automated alerts, system messages
- `social` - Social media, networking
- `personal` - Direct human correspondence
- `unknown` - Unable to classify confidently

## Safety Features

1. **No Auto-Actions**: Classifications suggest actions but never execute them
2. **Schema Validation**: All LLM outputs validated with Zod
3. **Fallback Mode**: On any error, defaults to `needsReview: true`
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

## Prompt Structure

The LLM prompt includes:

1. **Email Metadata**: From, Subject, Domain, Newsletter indicators
2. **Rule Engine Output**: Pre-classification category and confidence
3. **Cleaned Content**: Normalized email body text
4. **Schema Definition**: Exact JSON structure expected
5. **Guidelines**: Category-specific rules and heuristics

## Error Handling

On any failure (LLM error, invalid JSON, schema validation failure):

1. Classification is stored with `needsReview: true`
2. `category` is set to `"unknown"`
3. `confidence` is set to `"low"`
4. `reason` explains the failure
5. `classificationError` stores the technical error

## Implementation Details

### Mock LLM Provider

The current implementation uses `MockLlmProvider` which simulates LLM responses based on keyword matching. This allows testing without API keys or external dependencies.

To use a real LLM (OpenAI, Anthropic, etc.):

1. Create a new provider implementing `LlmProvider` interface
2. Replace `MockLlmProvider` in `ClassificationService`
3. Add API key configuration to env schema

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
