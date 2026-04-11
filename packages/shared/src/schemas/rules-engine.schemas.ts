import { z } from "zod";

/**
 * Rule-based classification categories.
 * These are deterministic pre-classifications before any LLM processing.
 */
export const RuleCategorySchema = z.enum([
  "newsletter",
  "receipt",
  "alert",
  "likely_human",
  "unknown",
]);

export type RuleCategory = z.infer<typeof RuleCategorySchema>;

/**
 * Confidence levels for rule-based classification.
 * High = strong evidence, Low = weak/single indicator.
 */
export const RuleConfidenceSchema = z.enum(["high", "medium", "low"]);

export type RuleConfidence = z.infer<typeof RuleConfidenceSchema>;

/**
 * Input data for rule-based classification.
 * Uses fields from normalized email data.
 */
export const RulesEngineInputSchema = z.object({
  subject: z.string().nullable(),
  fromAddress: z.string().nullable(),
  fromName: z.string().nullable(),
  textBody: z.string().nullable(),
  htmlBody: z.string().nullable(),
  senderDomain: z.string(),
  isNewsletter: z.boolean(),
  isBulk: z.boolean(),
  hasUnsubscribe: z.boolean(),
  unsubscribeLink: z.string().nullable().optional(),
  tags: z.array(z.string()),
});

export type RulesEngineInput = z.infer<typeof RulesEngineInputSchema>;

/**
 * Result of rule-based classification.
 */
export const RulesEngineResultSchema = z.object({
  ruleCategory: RuleCategorySchema,
  ruleConfidence: RuleConfidenceSchema,
  ruleReasons: z.array(z.string()),
  matchedRules: z.array(z.string()),
});

export type RulesEngineResult = z.infer<typeof RulesEngineResultSchema>;

/**
 * Individual rule definition.
 * Each rule has a name, category it maps to, and a matcher function.
 */
export interface ClassificationRule {
  name: string;
  category: RuleCategory;
  confidence: RuleConfidence;
  description: string;
  matcher: (input: RulesEngineInput) => boolean;
}
