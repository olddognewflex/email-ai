# Rules Engine Module

Deterministic rule-based email classification for pre-classifying emails before LLM processing.

## Overview

The rules engine uses deterministic heuristics to classify emails into categories:

- **newsletter** - Marketing emails, mailing lists, bulk content
- **receipt** - Purchase confirmations, invoices, payment receipts
- **alert** - Security alerts, system notifications, automated warnings
- **likely_human** - Personal correspondence, conversational emails
- **unknown** - No clear classification indicators

## Design Principles

1. **Deterministic** - Same input always produces same output
2. **Explainable** - Every classification includes reasons
3. **Extensible** - New rules can be added easily
4. **Conservative** - When uncertain, defaults to 'unknown'
5. **No LLM** - Pure rule-based, no AI model required

## Classification Rules

### Newsletter Rules

| Rule                           | Confidence | Description                              |
| ------------------------------ | ---------- | ---------------------------------------- |
| has_unsubscribe_link           | high       | Email contains unsubscribe link          |
| list_id_header_indicator       | high       | Has mailing list indicators in tags      |
| bulk_sender_domain             | medium     | Sender domain is known bulk mail service |
| newsletter_keywords_in_subject | medium     | Subject contains newsletter keywords     |
| is_newsletter_flag_set         | high       | Normalization marked as newsletter       |
| is_bulk_flag_set               | medium     | Normalization marked as bulk             |

### Receipt Rules

| Rule                          | Confidence | Description                               |
| ----------------------------- | ---------- | ----------------------------------------- |
| receipt_keywords_in_subject   | high       | Subject contains receipt/invoice keywords |
| receipt_keywords_in_body      | high       | Body contains strong receipt indicators   |
| receipt_sender_domain         | medium     | Sender domain suggests e-commerce         |
| subscription_receipt_keywords | medium     | Subject suggests subscription receipt     |

### Alert Rules

| Rule                            | Confidence | Description                                    |
| ------------------------------- | ---------- | ---------------------------------------------- |
| security_alert_keywords         | high       | Subject contains security alert keywords       |
| system_alert_keywords           | high       | Subject contains system alert keywords         |
| notification_automated_patterns | medium     | Subject matches automated notification pattern |
| alert_sender_patterns           | medium     | Sender name suggests automated alerts          |
| no_reply_sender                 | low        | Sender address is noreply or similar           |

### Likely Human Rules

| Rule                        | Confidence | Description                                  |
| --------------------------- | ---------- | -------------------------------------------- |
| personal_greeting_patterns  | medium     | Body contains personal greeting patterns     |
| conversational_punctuation  | low        | Contains conversational punctuation patterns |
| short_personal_subject      | low        | Subject is short and conversational          |
| question_mark_in_subject    | low        | Subject is a question                        |
| personal_signature_detected | medium     | Body contains personal signature patterns    |

## Usage

```typescript
import { RulesEngineService } from "./rules-engine/rules-engine.service";
import { RulesEngineInput } from "@email-ai/shared";

const service = new RulesEngineService();

const input: RulesEngineInput = {
  subject: "Your order has been confirmed",
  fromAddress: "orders@shop.com",
  fromName: "Shop Orders",
  textBody: "Order #12345 confirmed. Total: $49.99",
  htmlBody: null,
  senderDomain: "shop.com",
  isNewsletter: false,
  isBulk: false,
  hasUnsubscribe: false,
  tags: [],
};

const result = service.classify(input);
// {
//   ruleCategory: "receipt",
//   ruleConfidence: "high",
//   ruleReasons: ["Subject contains receipt/invoice keywords (receipt_keywords_in_subject)"],
//   matchedRules: ["receipt_keywords_in_subject"]
// }
```

## Output Format

```typescript
interface RulesEngineResult {
  ruleCategory: "newsletter" | "receipt" | "alert" | "likely_human" | "unknown";
  ruleConfidence: "high" | "medium" | "low";
  ruleReasons: string[]; // Human-readable explanations
  matchedRules: string[]; // Names of rules that matched
}
```

## Confidence Scoring

Rules are weighted by confidence:

- **high** = 3 points
- **medium** = 2 points
- **low** = 1 point

The category with the highest total score wins. Ties go to the first category with that score.

## Extending the Rules Engine

To add a new rule:

1. Add a new rule object to the appropriate category method in `rules-engine.service.ts`:

```typescript
{
  name: "my_new_rule",
  category: "newsletter",
  confidence: "medium",
  description: "Description of what this rule checks",
  matcher: (input) => {
    // Return true if the email matches this rule
    return input.subject?.includes("specific keyword") ?? false;
  },
}
```

2. The rule will automatically be evaluated on the next classification.

## Verification

Run the example classifications to verify the rules engine:

```bash
# Build the project
pnpm build

# Run a test script (see rules-engine.examples.ts)
npx tsx -e "
import { RulesEngineService } from './apps/api/src/modules/rules-engine/rules-engine.service';
import { exampleEmails, expectedClassifications } from './apps/api/src/modules/rules-engine/rules-engine.examples';

const service = new RulesEngineService();

console.log('Rules Engine Verification\n');
console.log('=' .repeat(60));

for (const { name, input } of exampleEmails) {
  const result = service.classify(input);
  const expected = expectedClassifications[name];
  const match = expected?.ruleCategory === result.ruleCategory;
  const status = match ? '✓' : '✗';

  console.log(\`\n\${status} \${name}\`);
  console.log(\`  Category: \${result.ruleCategory} (expected: \${expected?.ruleCategory})\`);
  console.log(\`  Confidence: \${result.ruleConfidence}\`);
  console.log(\`  Reasons: \${result.ruleReasons.join(', ')}\`);
}
"
```

## Example Classifications

See `rules-engine.examples.ts` for 10 example emails with expected classifications:

1. Newsletter with unsubscribe → newsletter (high)
2. Purchase receipt → receipt (high)
3. Security alert → alert (high)
4. Personal email with greeting → likely_human (medium)
5. Marketing email from bulk sender → newsletter (high)
6. Unknown - no clear indicators → newsletter (medium) - "Update" keyword matches
7. Invoice email → receipt (high)
8. System maintenance notice → alert (high)
9. Reply with Re: prefix → likely_human (medium)
10. Subscription confirmation → receipt (medium)

## Testing

```bash
# Run API tests
pnpm --filter @email-ai/api test

# Run specific test file
pnpm --filter @email-ai/api test -- rules-engine
```

## Architecture

```
RulesEngineService
├── classify(input) → RulesEngineResult
├── buildRules() → ClassificationRule[]
│   ├── buildNewsletterRules()
│   ├── buildReceiptRules()
│   ├── buildAlertRules()
│   └── buildLikelyHumanRules()
├── calculateCategoryScores() → Map<Category, Score>
├── selectBestCategory() → Category
└── aggregateConfidence() → Confidence
```

## Constraints

- No external AI/LLM calls
- Deterministic output for same input
- Explainable results (every classification has reasons)
- Fast execution (all regex, no I/O)
- Extensible without code changes to core logic
