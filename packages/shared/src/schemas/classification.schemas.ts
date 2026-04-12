import { z } from "zod";

/**
 * Email category classification from LLM.
 * Broad categories that map to actionable workflows.
 */
export const EmailCategorySchema = z.enum([
  "needs_attention", // Requires user action or decision
  "read_later", // Important but not urgent
  "archive", // Safe to archive after reading
  "delete", // Safe to delete
  "newsletter", // Regular subscriptions/digests
  "receipt", // Purchase confirmations, invoices
  "notification", // Automated alerts, system messages
  "social", // Social media, networking
  "personal", // Direct human correspondence
  "unknown", // Unable to classify confidently
]);

export type EmailCategory = z.infer<typeof EmailCategorySchema>;

/**
 * Importance level for triage decisions.
 */
export const ImportanceLevelSchema = z.enum([
  "critical", // Must review immediately
  "high", // Should review today
  "medium", // Review within a few days
  "low", // Review when convenient
  "none", // No action needed
]);

export type ImportanceLevel = z.infer<typeof ImportanceLevelSchema>;

/**
 * Urgency level for time-sensitive decisions.
 */
export const UrgencyLevelSchema = z.enum([
  "immediate", // Act now (hours)
  "today", // Act today
  "this_week", // Act this week
  "eventually", // No time pressure
  "none", // Not time-sensitive
]);

export type UrgencyLevel = z.infer<typeof UrgencyLevelSchema>;

/**
 * Recommended action based on classification.
 */
export const RecommendedActionSchema = z.enum([
  "read_now", // Open and read immediately
  "reply_needed", // Requires a response
  "schedule_reply", // Plan to respond later
  "archive", // Move to archive
  "mark_read", // Mark as read, no action
  "delete", // Safe to delete
  "unsubscribe", // Consider unsubscribing
  "flag_for_followup", // Set reminder/follow-up
  "delegate", // Forward to someone else
  "no_action", // Nothing needed
]);

export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

/**
 * Confidence level for LLM classification.
 */
export const ConfidenceLevelSchema = z.enum([
  "high", // Very confident
  "medium", // Reasonably confident
  "low", // Uncertain
]);

export type ConfidenceLevel = z.infer<typeof ConfidenceLevelSchema>;

/**
 * LLM classification output schema.
 * This is the expected JSON structure from the LLM.
 */
export const EmailClassificationOutputSchema = z.object({
  category: EmailCategorySchema,
  importance: ImportanceLevelSchema,
  urgency: UrgencyLevelSchema,
  recommendedAction: RecommendedActionSchema,
  confidence: ConfidenceLevelSchema,
  needsReview: z.boolean(),
  reason: z.string().min(1).max(500),
});

export type EmailClassificationOutput = z.infer<
  typeof EmailClassificationOutputSchema
>;

/**
 * Input data for LLM classification.
 * Combines normalized email data with rule engine output.
 */
export const EmailClassificationInputSchema = z.object({
  subject: z.string().nullable(),
  fromAddress: z.string().nullable(),
  fromName: z.string().nullable(),
  cleanedText: z.string().nullable(),
  ruleCategory: z.string().nullable(),
  ruleConfidence: z.string().nullable(),
  ruleReasons: z.array(z.string()),
  isNewsletter: z.boolean(),
  isBulk: z.boolean(),
  senderDomain: z.string(),
});

export type EmailClassificationInput = z.infer<
  typeof EmailClassificationInputSchema
>;

/**
 * Classification result stored in database.
 * Extends the LLM output with metadata.
 */
export const EmailClassificationResultSchema = z.object({
  id: z.string(),
  normalizedEmailId: z.string(),
  category: EmailCategorySchema,
  importance: ImportanceLevelSchema,
  urgency: UrgencyLevelSchema,
  recommendedAction: RecommendedActionSchema,
  confidence: ConfidenceLevelSchema,
  needsReview: z.boolean(),
  reason: z.string(),
  rawResponse: z.string().nullable(), // Store raw LLM response for audit
  classificationError: z.string().nullable(), // Error message if classification failed
  createdAt: z.date(),
});

export type EmailClassificationResult = z.infer<
  typeof EmailClassificationResultSchema
>;
