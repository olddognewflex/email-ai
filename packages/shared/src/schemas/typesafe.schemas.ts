import { z } from "zod";

/**
 * TypeSafe "System One" judgment API (model family: Jev).
 *
 * Unlike an LLM completion, a TypeSafe call sends application `state` plus
 * a map of typed questions and gets typed answers with probabilities back —
 * no free text. See https://docs.typesafe.ai.
 *
 *   POST {baseURL}/v1/systemone
 *   { state, model, questions: { <id>: Question } }
 *   → { model, answers: { <id>: Answer }, usage }
 *
 * Question ids are never shown to the model; instructions must carry the
 * full meaning and may reference nested state with backticked paths such as
 * `email.subject`.
 */

// ── JSON-ish values used for state, instructions and criteria ─────────────

export type TypeSafeJson =
  | string
  | number
  | boolean
  | null
  | TypeSafeJson[]
  | { [key: string]: TypeSafeJson };

export const TypeSafeJsonSchema: z.ZodType<TypeSafeJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(TypeSafeJsonSchema),
    z.record(z.string(), TypeSafeJsonSchema),
  ]),
);

/** An instruction or criterion: string | object | array | null. */
export const TypeSafeEntrySchema = TypeSafeJsonSchema;

export type TypeSafeEntry = TypeSafeJson;

// ── Questions (request side) ──────────────────────────────────────────────

/** Pick exactly one label from ≤255 options. */
export const TypeSafeChoiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: TypeSafeEntrySchema,
  criteria: z.record(z.string(), TypeSafeEntrySchema),
});

export type TypeSafeChoiceQuestion = z.infer<
  typeof TypeSafeChoiceQuestionSchema
>;

/** 2–10 ordered levels; index 0 is the lowest. */
export const TypeSafeScoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: TypeSafeEntrySchema,
  criteria: z.array(TypeSafeEntrySchema).min(2).max(10),
});

export type TypeSafeScoreQuestion = z.infer<typeof TypeSafeScoreQuestionSchema>;

/** Yes/no question answered as a probability of "true". */
export const TypeSafeNoulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: TypeSafeEntrySchema,
  criteria: z
    .object({ true: TypeSafeEntrySchema, false: TypeSafeEntrySchema })
    .optional(),
});

export type TypeSafeNoulQuestion = z.infer<typeof TypeSafeNoulQuestionSchema>;

export const TypeSafeQuestionSchema = z.discriminatedUnion("type", [
  TypeSafeChoiceQuestionSchema,
  TypeSafeScoreQuestionSchema,
  TypeSafeNoulQuestionSchema,
]);

export type TypeSafeQuestion = z.infer<typeof TypeSafeQuestionSchema>;

/** What callers hand to `TypeSafeClient.judge()`; the client adds `model`. */
export const TypeSafeJudgeRequestSchema = z.object({
  state: TypeSafeJsonSchema,
  questions: z.record(z.string(), TypeSafeQuestionSchema),
});

export type TypeSafeJudgeRequest = z.infer<typeof TypeSafeJudgeRequestSchema>;

// ── Answers (response side) — always Zod-validated before use ─────────────

const Probability = z.number().min(0).max(1);

export const TypeSafeChoiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  confidence: Probability,
  probabilities: z.record(z.string(), Probability),
});

export type TypeSafeChoiceAnswer = z.infer<typeof TypeSafeChoiceAnswerSchema>;

export const TypeSafeScoreAnswerSchema = z.object({
  type: z.literal("score"),
  /** Fractional expected level: Σ index × p. */
  score: z.number(),
  confidence: Probability,
  legend: z.record(z.string(), TypeSafeJsonSchema).optional(),
  /** Keyed by level index as a string ("0", "1", …). */
  probabilities: z.record(z.string(), Probability),
});

export type TypeSafeScoreAnswer = z.infer<typeof TypeSafeScoreAnswerSchema>;

export const TypeSafeNoulAnswerSchema = z.object({
  type: z.literal("noul"),
  /** Probability that the answer is true. */
  noul: Probability,
});

export type TypeSafeNoulAnswer = z.infer<typeof TypeSafeNoulAnswerSchema>;

export const TypeSafeAnswerSchema = z.discriminatedUnion("type", [
  TypeSafeChoiceAnswerSchema,
  TypeSafeScoreAnswerSchema,
  TypeSafeNoulAnswerSchema,
]);

export type TypeSafeAnswer = z.infer<typeof TypeSafeAnswerSchema>;

export const TypeSafeUsageSchema = z.object({
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
});

export type TypeSafeUsage = z.infer<typeof TypeSafeUsageSchema>;

export const TypeSafeResponseSchema = z.object({
  model: z.string(),
  answers: z.record(z.string(), TypeSafeAnswerSchema),
  usage: TypeSafeUsageSchema.optional(),
});

export type TypeSafeResponse = z.infer<typeof TypeSafeResponseSchema>;
