import {
  ConfidenceLevel,
  EmailCategory,
  EmailCategorySchema,
  EmailClassificationInput,
  EmailClassificationOutput,
  EmailClassificationOutputSchema,
  RecommendedActionSchema,
  TypeSafeAnswer,
  TypeSafeChoiceAnswer,
  TypeSafeNoulAnswer,
  TypeSafeScoreAnswer,
} from "@email-ai/shared";
import {
  IMPORTANCE_LEVELS,
  QUESTION_IDS,
  URGENCY_LEVELS,
} from "./classification.questions";

// ── Review policy thresholds ─────────────────────────────────────────────

/** Bump when any threshold or trigger below changes; stored for audit. */
export const REVIEW_POLICY_VERSION = "2026-09-22.2";

// TypeSafe confidence is the peakedness of the answer distribution (0..1).
// Confidence reflects the category choice only. Action alternatives are
// often all acceptable (unsubscribe / delete / mark_read for a promo), so
// a spread action distribution is not a reason to distrust the triage.

/** Category confidence at or above this → "high". */
export const HIGH_CONFIDENCE_THRESHOLD = 0.75;
/** Category confidence at or above this → "medium", else "low". */
export const MEDIUM_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Category pairs close enough that a rule-engine disagreement is not worth
 * a human look. The rule engine labels any bulk / mailing-list sender
 * `newsletter`; TypeSafe separates what that bulk mail actually is:
 * promotions (marketing), automated alerts such as GitHub notifications
 * (notification), and social network mail (social).
 */
export const RULE_COMPATIBLE_CATEGORIES: ReadonlyArray<
  readonly [EmailCategory, EmailCategory]
> = [
  ["newsletter", "marketing"],
  ["newsletter", "notification"],
  ["newsletter", "social"],
];

function categoriesCompatible(a: EmailCategory, b: EmailCategory): boolean {
  return (
    a === b ||
    RULE_COMPATIBLE_CATEGORIES.some(
      ([x, y]) => (a === x && b === y) || (a === y && b === x),
    )
  );
}

/** P(sensitive) at or above this → needsReview. */
export const SENSITIVE_REVIEW_THRESHOLD = 0.5;
/** Max length of the stored `reason` (matches EmailClassificationOutputSchema). */
export const MAX_REASON_LENGTH = 500;

export interface JudgmentDiagnostics {
  categoryConfidence: number;
  categoryProbability: number;
  actionConfidence: number;
  actionProbability: number;
  importanceScore: number;
  urgencyScore: number;
  sensitiveProbability: number;
  ruleDisagreement: boolean;
  reviewTriggers: string[];
}

export interface MappedJudgment {
  output: EmailClassificationOutput;
  diagnostics: JudgmentDiagnostics;
}

function getAnswer<T extends TypeSafeAnswer["type"]>(
  answers: Record<string, TypeSafeAnswer>,
  id: string,
  type: T,
): Extract<TypeSafeAnswer, { type: T }> {
  const answer = answers[id];
  if (!answer) {
    throw new Error(`TypeSafe response missing answer "${id}"`);
  }
  if (answer.type !== type) {
    throw new Error(
      `TypeSafe answer "${id}" has type "${answer.type}", expected "${type}"`,
    );
  }
  return answer as Extract<TypeSafeAnswer, { type: T }>;
}

function levelFor<L extends readonly string[]>(
  levels: L,
  score: number,
): L[number] {
  if (!Number.isFinite(score)) {
    throw new Error(`Non-finite score ${score}`);
  }
  // Round from the 2-decimal value that is displayed in `reason`, so the
  // shown score can never disagree with the level (e.g. 2.499 → "2.50" → high).
  const idx = Math.min(
    levels.length - 1,
    Math.max(0, Math.round(roundTo2(score))),
  );
  return levels[idx];
}

function roundTo2(n: number): number {
  return Math.round(n * 100) / 100;
}

function bandConfidence(value: number): ConfidenceLevel {
  if (value >= HIGH_CONFIDENCE_THRESHOLD) return "high";
  if (value >= MEDIUM_CONFIDENCE_THRESHOLD) return "medium";
  return "low";
}

function probabilityOf(answer: TypeSafeChoiceAnswer): number {
  return answer.probabilities[answer.choice] ?? answer.confidence;
}

const fmt = (n: number) => roundTo2(n).toFixed(2);

/**
 * Map validated TypeSafe answers to an `EmailClassificationOutput`.
 *
 * Pure and deterministic. Throws if an answer is missing, has the wrong
 * type, carries a label outside the shared enums, or has a non-finite score.
 * Callers run it inside `AiProviderService.judgeWith`, which turns a throw
 * into `InvalidProviderResponseError` (breaker failure, no row written).
 */
export function mapJudgmentsToOutput(
  answers: Record<string, TypeSafeAnswer>,
  input: Pick<EmailClassificationInput, "ruleCategory" | "ruleConfidence">,
): MappedJudgment {
  const categoryAnswer: TypeSafeChoiceAnswer = getAnswer(
    answers,
    QUESTION_IDS.category,
    "choice",
  );
  const actionAnswer: TypeSafeChoiceAnswer = getAnswer(
    answers,
    QUESTION_IDS.recommendedAction,
    "choice",
  );
  const importanceAnswer: TypeSafeScoreAnswer = getAnswer(
    answers,
    QUESTION_IDS.importance,
    "score",
  );
  const urgencyAnswer: TypeSafeScoreAnswer = getAnswer(
    answers,
    QUESTION_IDS.urgency,
    "score",
  );
  const sensitiveAnswer: TypeSafeNoulAnswer = getAnswer(
    answers,
    QUESTION_IDS.sensitive,
    "noul",
  );

  const categoryResult = EmailCategorySchema.safeParse(categoryAnswer.choice);
  if (!categoryResult.success) {
    throw new Error(
      `TypeSafe chose unknown category "${categoryAnswer.choice}"`,
    );
  }
  const actionResult = RecommendedActionSchema.safeParse(actionAnswer.choice);
  if (!actionResult.success) {
    throw new Error(`TypeSafe chose unknown action "${actionAnswer.choice}"`);
  }
  const category = categoryResult.data;
  const recommendedAction = actionResult.data;
  const importance = levelFor(IMPORTANCE_LEVELS, importanceAnswer.score);
  const urgency = levelFor(URGENCY_LEVELS, urgencyAnswer.score);

  const confidence = bandConfidence(categoryAnswer.confidence);

  const ruleCategory = EmailCategorySchema.safeParse(input.ruleCategory);
  const ruleDisagreement =
    input.ruleConfidence === "high" &&
    ruleCategory.success &&
    !categoriesCompatible(ruleCategory.data, category);

  const reviewTriggers: string[] = [];
  if (category === "unknown") reviewTriggers.push("category unknown");
  if (confidence === "low") reviewTriggers.push("low confidence");
  if (sensitiveAnswer.noul >= SENSITIVE_REVIEW_THRESHOLD) {
    reviewTriggers.push(`sensitive (p=${fmt(sensitiveAnswer.noul)})`);
  }
  if (ruleDisagreement) {
    reviewTriggers.push(
      `rules said ${ruleCategory.data as EmailCategory} (high)`,
    );
  }
  const needsReview = reviewTriggers.length > 0;

  const maxLevel = IMPORTANCE_LEVELS.length - 1;
  let reason =
    `${category} (p=${fmt(probabilityOf(categoryAnswer))}) → ` +
    `${recommendedAction} (p=${fmt(probabilityOf(actionAnswer))}); ` +
    `importance ${importance} (${fmt(importanceAnswer.score)}/${maxLevel}), ` +
    `urgency ${urgency} (${fmt(urgencyAnswer.score)}/${URGENCY_LEVELS.length - 1})`;
  if (needsReview) {
    reason += `; review: ${reviewTriggers.join(", ")}`;
  }
  if (reason.length > MAX_REASON_LENGTH) {
    reason = reason.slice(0, MAX_REASON_LENGTH - 1) + "…";
  }

  const output = EmailClassificationOutputSchema.parse({
    category,
    importance,
    urgency,
    recommendedAction,
    confidence,
    needsReview,
    reason,
  });

  return {
    output,
    diagnostics: {
      categoryConfidence: categoryAnswer.confidence,
      categoryProbability: probabilityOf(categoryAnswer),
      actionConfidence: actionAnswer.confidence,
      actionProbability: probabilityOf(actionAnswer),
      importanceScore: importanceAnswer.score,
      urgencyScore: urgencyAnswer.score,
      sensitiveProbability: sensitiveAnswer.noul,
      ruleDisagreement,
      reviewTriggers,
    },
  };
}
