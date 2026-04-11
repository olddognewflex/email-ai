# Email Normalization Pipeline

This module provides email content normalization to extract clean, usable text from email messages.

## Overview

The normalization pipeline processes email content through several stages:

1. **Extract Text** - Prefer text body, fallback to HTML stripping
2. **Remove Quoted Replies** - Strip quoted email threads using common patterns
3. **Trim Signatures** - Remove email signatures using heuristic patterns
4. **Normalize Whitespace** - Collapse multiple spaces and newlines
5. **Extract Links** - Identify URLs and unsubscribe links

## Output Fields

- `cleanedText` - The normalized email body text
- `detectedLinks` - Array of detected URLs with metadata
- `unsubscribeLink` - Specific unsubscribe URL if detected

## Example Transformations

### Example 1: Simple Reply

**Before:**

```
Hi Alice,

Thanks for the update. Let's discuss this tomorrow.

Best,
Bob

On Mon, Jan 15, 2024 at 9:00 AM Alice <alice@example.com> wrote:
> Hi Bob,
>
> Here's the latest version of the document.
>
> - Alice
```

**After:**

```
Hi Alice,

Thanks for the update. Let's discuss this tomorrow.
```

**Links detected:** None

---

### Example 2: HTML Newsletter

**Before:**

```html
<html>
  <body>
    <h1>Weekly Newsletter</h1>
    <p>Check out our latest updates!</p>
    <p><a href="https://company.com/blog">Read our blog</a></p>
    <p><a href="https://company.com/unsubscribe">Unsubscribe</a></p>
    <script>
      alert("xss");
    </script>
  </body>
</html>
```

**After:**

```
Weekly Newsletter

Check out our latest updates!

Read our blog

Unsubscribe
```

**Links detected:**

- `https://company.com/blog` (general)
- `https://company.com/unsubscribe` (unsubscribe)

**Unsubscribe link:** `https://company.com/unsubscribe`

---

### Example 3: Mobile Email with Signature

**Before:**

```
Sure, I can help with that. Let's sync up at 3pm.

Sent from my iPhone

--
John Doe
Senior Developer
john@example.com
```

**After:**

```
Sure, I can help with that. Let's sync up at 3pm.
```

---

### Example 4: Forwarded Message

**Before:**

```
FYI - see below

-----Original Message-----
From: someone@example.com
Sent: Monday, January 1, 2024
Subject: Important update

The original message content here...
```

**After:**

```
FYI - see below
```

## Heuristics Used

### Quoted Reply Detection

The following patterns trigger quote removal:

- Lines starting with `>`
- "On ... wrote:" headers
- "From:", "Sent:", "To:", "Cc:", "Subject:" headers
- Separator lines (---Original Message---, etc.)
- "Begin forwarded message:"

### Signature Detection

The following patterns trigger signature trimming:

- Classic delimiter `-- `
- "Sent from my iPhone/Android/mobile"
- Common closings: "Best regards,", "Sincerely,", "Thanks,", etc.

### Link Extraction

Links are extracted from:

- HTML anchor tags (`<a href="...">`)
- Plain text URLs (http/https)
- Unsubscribe links are detected by URL pattern or link text

## Idempotency

The normalization is **idempotent** - running it multiple times on the same input produces the same output. This allows safe re-processing of emails without accumulating artifacts.

## API Usage

### Normalize a Single Email

```typescript
POST /normalization/:parsedEmailId/normalize
```

**Note**: This endpoint uses `upsert`, so it will:

- Create a new NormalizedEmail if it doesn't exist
- **Update** the existing NormalizedEmail if it already exists (reprocess)

### Process All Unnormalized Emails

```typescript
POST / normalization / run;
```

Processes only emails that haven't been normalized yet.

### Reprocess All Normalized Emails

```typescript
POST / normalization / reprocess;
```

**Use case**: After updating classification rules, reprocess all existing normalized emails to apply new rules.

**Warning**: This can be slow for large datasets. Consider running during off-peak hours.

Example response:

```json
{
  "processed": 150,
  "errors": 0
}
```

### Service Usage

```typescript
import { EmailNormalizer } from "./normalization/email-normalizer.service";

const normalizer = new EmailNormalizer();
const result = normalizer.normalize(textBody, htmlBody);

console.log(result.cleanedText);
console.log(result.detectedLinks);
console.log(result.unsubscribeLink);
```

## Database Schema

Normalized content is stored in the `NormalizedEmail` table:

```prisma
model NormalizedEmail {
  id              String   @id @default(cuid())
  parsedEmailId   String   @unique
  senderDomain    String
  isNewsletter    Boolean  @default(false)
  isBulk          Boolean  @default(false)
  tags            String[]
  cleanedText     String?
  detectedLinks   Json     @default("[]")
  unsubscribeLink String?
  normalizedAt    DateTime @default(now())

  // Rule-based classification
  ruleCategory   String?   // newsletter | receipt | alert | likely_human | unknown
  ruleConfidence String?   // high | medium | low
  ruleReasons    String[]  // Explanation strings
}
```

## Reprocessing

### Why Reprocess?

You may want to reprocess normalized emails when:

- **Classification rules updated** - New rules added or existing rules modified
- **Bug fixes** - Issues fixed in normalizer or rules engine
- **Retrospective analysis** - Apply new categorization to historical data

### How Reprocessing Works

1. The `normalizeEmail()` method uses Prisma `upsert`:
   - **Create**: If no NormalizedEmail exists for the parsedEmailId
   - **Update**: If NormalizedEmail already exists (reprocess)

2. All fields are recalculated:
   - `cleanedText` - Re-normalized
   - `senderDomain` - Re-extracted
   - `ruleCategory` - Re-classified with current rules
   - `ruleConfidence` - Re-calculated
   - `ruleReasons` - Updated with current matched rules

3. Idempotent by design - running multiple times produces same result

### Reprocessing Options

| Endpoint                            | Use Case                                 |
| ----------------------------------- | ---------------------------------------- |
| `POST /normalization/:id/normalize` | Reprocess specific email                 |
| `POST /normalization/run`           | Process only new (unnormalized) emails   |
| `POST /normalization/reprocess`     | Reprocess all existing normalized emails |

## Testing

Run the normalization tests:

```bash
pnpm --filter @email-ai/api test -- --testPathPattern="email-normalizer"
```

## Constraints

- Original raw content is never modified (stored separately)
- Heuristics are intentionally simple (no ML/NLP)
- Processing is deterministic and explainable
- HTML stripping uses regex (not a full parser) for simplicity
