import { EmailClassificationInput } from "@email-ai/shared";

/**
 * Builds a classification prompt for LLM-based email triage.
 * Uses normalized email content and rule engine output to guide classification.
 */
export function buildClassificationPrompt(
  input: EmailClassificationInput,
): string {
  const sender = input.fromName
    ? `${input.fromName} <${input.fromAddress}>`
    : input.fromAddress || "Unknown sender";

  const ruleContext = input.ruleCategory
    ? `Rule-based pre-classification: ${input.ruleCategory} (confidence: ${input.ruleConfidence})`
    : "No rule-based classification available";

  const ruleReasons =
    input.ruleReasons.length > 0
      ? `Rule reasons: ${input.ruleReasons.join("; ")}`
      : "";

  return `You are an email classification assistant. Analyze this email and classify it according to the schema below.

EMAIL DATA:
- From: ${sender}
- Subject: ${input.subject || "(no subject)"}
- Domain: ${input.senderDomain}
- Newsletter indicators: isNewsletter=${input.isNewsletter}, isBulk=${input.isBulk}

${ruleContext}
${ruleReasons}

EMAIL CONTENT:
---
${input.cleanedText || "(no content)"}
---

CLASSIFICATION SCHEMA:
Return a JSON object with these exact fields:

{
  "category": "<one of: needs_attention, read_later, archive, delete, newsletter, receipt, notification, social, personal, unknown>",
  "importance": "<one of: critical, high, medium, low, none>",
  "urgency": "<one of: immediate, today, this_week, eventually, none>",
  "recommendedAction": "<one of: read_now, reply_needed, schedule_reply, archive, mark_read, delete, unsubscribe, flag_for_followup, delegate, no_action>",
  "confidence": "<one of: high, medium, low>",
  "needsReview": <boolean>,
  "reason": "<brief explanation of classification, max 200 characters>"
}

GUIDELINES:
- category: Choose the best fit based on email content and purpose
- importance: How important is this email to the recipient
- urgency: How quickly does this need attention
- recommendedAction: What should the user do with this email (DO NOT actually perform any action)
- confidence: How confident are you in this classification
- needsReview: Set to true if uncertain, conflicting signals, or potentially sensitive
- reason: Brief explanation referencing key indicators

RULES:
- Receipts/invoices: category="receipt", importance="medium", action="archive"
- Newsletters: category="newsletter", importance="low", action="unsubscribe" or "mark_read"
- Personal emails: category="personal", importance="high", action="read_now" or "reply_needed"
- Security alerts: category="notification", importance="critical", urgency="immediate"
- Marketing: category="delete" or "newsletter", importance="none"
- When in doubt: needsReview=true, confidence="low"

Respond ONLY with valid JSON. No markdown, no explanation, no code blocks.`;
}
