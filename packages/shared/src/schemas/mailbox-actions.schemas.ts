import { z } from "zod";

/**
 * Mailbox actions: the audited IMAP writes (move to Trash, restore).
 * Mirrors the Prisma MailboxActionType / MailboxActionStatus enums.
 */
export const MailboxActionTypeSchema = z.enum(["move_to_trash", "restore"]);
export type MailboxActionType = z.infer<typeof MailboxActionTypeSchema>;

export const MailboxActionStatusSchema = z.enum([
  "pending",
  "succeeded",
  "failed",
  "skipped",
  "undone",
  "unknown",
]);
export type MailboxActionStatus = z.infer<typeof MailboxActionStatusSchema>;

/** GET /mailbox-actions query. */
export const MailboxActionsListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  accountId: z.string().trim().min(1).max(64).optional(),
  status: MailboxActionStatusSchema.optional(),
});
export type MailboxActionsListQuery = z.output<
  typeof MailboxActionsListQuerySchema
>;

/** GET /mailbox-actions/status response. */
export const MailboxWritesStatusSchema = z.object({
  writesEnabled: z.boolean(),
});
export type MailboxWritesStatus = z.infer<typeof MailboxWritesStatusSchema>;

/** Hard ceiling on moves per apply run, whatever `limit` asks for. */
export const SENDER_RULE_APPLY_MAX_LIMIT = 1000;

/**
 * POST /sender-rules/apply query. `dryRun` is on unless it is exactly
 * "false": a typo must never turn a report into a mailbox write.
 */
export const SenderRuleApplyQuerySchema = z.object({
  dryRun: z
    .string()
    .optional()
    .transform((v) => v !== "false"),
  ruleId: z.string().trim().min(1).max(64).optional(),
  accountId: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SENDER_RULE_APPLY_MAX_LIMIT)
    .default(200),
});
export type SenderRuleApplyQuery = z.output<typeof SenderRuleApplyQuerySchema>;

export const SenderRuleApplySampleSchema = z.object({
  rawEmailId: z.string(),
  fromAddress: z.string().nullable(),
  subject: z.string().nullable(),
  /** Dry run: "would_move". Live: the MailboxAction outcome. */
  outcome: z.enum(["would_move", "succeeded", "failed", "skipped", "unknown"]),
  error: z.string().nullable().optional(),
});
export type SenderRuleApplySample = z.infer<typeof SenderRuleApplySampleSchema>;

const ApplyCountsSchema = z.object({
  /** Eligible mail matched by the rule(s), before `limit`. */
  matched: z.number().int(),
  /** Of those, selected for this run (at most `limit` across the run). */
  selected: z.number().int(),
  moved: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
  /** IMAP outcome could not be established; see POST /mailbox-actions/reconcile. */
  unknown: z.number().int(),
});

export const SenderRuleApplyAccountSchema = ApplyCountsSchema.extend({
  accountId: z.string(),
  accountLabel: z.string(),
  /** Account-level refusal (e.g. no MOVE, no \Trash, needs re-auth). */
  error: z.string().nullable().optional(),
  sample: z.array(SenderRuleApplySampleSchema),
});
export type SenderRuleApplyAccount = z.infer<
  typeof SenderRuleApplyAccountSchema
>;

export const SenderRuleApplyRuleSchema = z.object({
  ruleId: z.string(),
  pattern: z.string(),
  matchType: z.string(),
  byAccount: z.array(SenderRuleApplyAccountSchema),
});
export type SenderRuleApplyRule = z.infer<typeof SenderRuleApplyRuleSchema>;

export const SenderRuleApplyResponseSchema = z.object({
  dryRun: z.boolean(),
  writesEnabled: z.boolean(),
  limit: z.number().int(),
  totals: ApplyCountsSchema,
  byRule: z.array(SenderRuleApplyRuleSchema),
});
export type SenderRuleApplyResponse = z.infer<
  typeof SenderRuleApplyResponseSchema
>;

/** POST /mailbox-actions/reconcile query. */
export const MailboxReconcileQuerySchema = z.object({
  accountId: z.string().trim().min(1).max(64).optional(),
});
export type MailboxReconcileQuery = z.output<typeof MailboxReconcileQuerySchema>;

export const MailboxReconcileItemSchema = z.object({
  id: z.string(),
  action: MailboxActionTypeSchema,
  from: MailboxActionStatusSchema,
  /** New status, or null when left unresolved. */
  to: MailboxActionStatusSchema.nullable(),
  detail: z.string(),
});
export type MailboxReconcileItem = z.infer<typeof MailboxReconcileItemSchema>;

export const MailboxReconcileAccountSchema = z.object({
  accountId: z.string(),
  error: z.string().nullable(),
  items: z.array(MailboxReconcileItemSchema),
});

export const MailboxReconcileResponseSchema = z.object({
  examined: z.number().int(),
  resolved: z.number().int(),
  unresolved: z.number().int(),
  accounts: z.array(MailboxReconcileAccountSchema),
});
export type MailboxReconcileResponse = z.infer<typeof MailboxReconcileResponseSchema>;
