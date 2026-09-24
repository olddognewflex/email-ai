/**
 * Pure helpers for editing a sender rule (`e` on RulesScreen): the form
 * draft, which fields changed (only those are PATCHed), when a preview or
 * the Trash warning applies, and mapping a Zod 400 onto form fields. No
 * React, no I/O.
 */
import { normalizeSenderPattern } from "@email-ai/shared";
import type {
  CreateSenderRuleInput,
  SenderRule,
  SenderRuleAction,
  SenderRuleApplyResponse,
  SenderRuleMatchType,
} from "./api.js";

export const MATCH_TYPES: readonly SenderRuleMatchType[] = [
  "address",
  "domain",
  "domain_suffix",
  "glob",
  "regex",
];

export const RULE_ACTIONS: readonly SenderRuleAction[] = ["classify", "trash"];

/** Form fields, in display order. */
export const EDIT_FIELDS = [
  "pattern",
  "matchType",
  "action",
  "category",
  "enabled",
  "note",
] as const;

export type EditField = (typeof EDIT_FIELDS)[number];

/** Same wording as the API's CreateSenderRuleSchema. */
export const CATEGORY_REQUIRED_MESSAGE = "category is required for classify rules";

export const DUPLICATE_RULE_MESSAGE = "A rule with this pattern already exists (see R)";

export const TRASH_EDIT_WARNING =
  "This rule will move matching mail to Trash when mailbox writes are enabled";

export interface EditDraft {
  pattern: string;
  matchType: SenderRuleMatchType;
  action: SenderRuleAction;
  /** null only for a classify rule whose category has not been picked yet. */
  category: string | null;
  enabled: boolean;
  /** Free text; blank means no note. */
  note: string;
}

export type RulePatch = Partial<
  Pick<CreateSenderRuleInput, "pattern" | "matchType" | "action" | "category" | "enabled" | "note">
>;

export type EditableRule = Pick<
  SenderRule,
  "id" | "pattern" | "matchType" | "action" | "category" | "enabled" | "note"
>;

export function draftFromRule(rule: EditableRule): EditDraft {
  return {
    pattern: rule.pattern,
    matchType: rule.matchType,
    action: rule.action,
    category: rule.category,
    enabled: rule.enabled,
    note: rule.note ?? "",
  };
}

/** The next (dir 1) or previous (dir -1) option, wrapping. */
export function cycle<T>(options: readonly T[], current: T, dir: 1 | -1): T {
  const i = options.indexOf(current);
  return options[(i + dir + options.length) % options.length];
}

/**
 * Switch the draft's action. Trash defaults the category to `delete`, as
 * the API does for a new trash rule (a merged PATCH would otherwise keep
 * the classify category). Classify restores the rule's own classify
 * category, or leaves it unpicked so the user has to choose one.
 */
export function withAction(
  draft: EditDraft,
  action: SenderRuleAction,
  original: EditableRule,
): EditDraft {
  if (action === draft.action) return draft;
  if (action === "trash") {
    return { ...draft, action, category: original.action === "trash" ? original.category : "delete" };
  }
  return { ...draft, action, category: original.action === "classify" ? original.category : null };
}

/** The pattern as the API would store it (trimmed, lowercased unless regex). */
export function storedPattern(pattern: string, matchType: SenderRuleMatchType): string {
  return normalizeSenderPattern(pattern.trim(), matchType);
}

/**
 * Only the fields that differ from the stored rule. The pattern is
 * compared in its stored form, so retyping it in another case is no
 * change; it is sent as typed (trimmed) and the API normalizes it.
 */
export function changedFields(original: EditableRule, draft: EditDraft): RulePatch {
  const patch: RulePatch = {};
  const pattern = draft.pattern.trim();
  if (storedPattern(pattern, draft.matchType) !== original.pattern) patch.pattern = pattern;
  if (draft.matchType !== original.matchType) patch.matchType = draft.matchType;
  if (draft.action !== original.action) patch.action = draft.action;
  if (draft.category !== null && draft.category !== original.category) {
    patch.category = draft.category;
  }
  if (draft.enabled !== original.enabled) patch.enabled = draft.enabled;
  const note = draft.note.trim() === "" ? null : draft.note;
  if (note !== (original.note ?? null)) patch.note = note;
  return patch;
}

export function hasChanges(patch: RulePatch): boolean {
  return Object.keys(patch).length > 0;
}

export type FieldErrors = Partial<Record<EditField, string[]>>;

/**
 * Checks the API would fail anyway, done before any request so the form
 * can say so next to the field. The API stays the authority on patterns.
 */
export function localFieldErrors(draft: EditDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (draft.pattern.trim() === "") errors.pattern = ["pattern is required"];
  if (draft.action === "classify" && !draft.category) {
    errors.category = [CATEGORY_REQUIRED_MESSAGE];
  }
  return errors;
}

/** POST /sender-rules/preview is needed when what the rule matches changed. */
export function needsMatchPreview(patch: RulePatch): boolean {
  return patch.pattern !== undefined || patch.matchType !== undefined;
}

/**
 * The Trash warning applies when the edited rule is a trash rule and the
 * edit makes it move mail it did not before: classify → trash, a changed
 * pattern or matchType (possibly broader), or re-enabling a disabled
 * trash rule.
 */
export function needsTrashWarning(original: EditableRule, draft: EditDraft, patch: RulePatch): boolean {
  if (draft.action !== "trash") return false;
  return (
    original.action !== "trash" ||
    needsMatchPreview(patch) ||
    (patch.enabled === true && !original.enabled)
  );
}

/** Run the preview for a match change, and for any Trash warning. */
export function needsPreview(original: EditableRule, draft: EditDraft, patch: RulePatch): boolean {
  return needsMatchPreview(patch) || needsTrashWarning(original, draft, patch);
}

/**
 * The per-rule dry run (`POST /sender-rules/apply?dryRun=true&ruleId=`)
 * reports on the SAVED rule, and the API refuses it (400) unless that is
 * an enabled trash rule. So it runs only then, and its count is what the
 * rule currently would move, not what the edited rule would.
 */
export function canDryRunSavedRule(original: EditableRule): boolean {
  return original.action === "trash" && original.enabled;
}

export interface DryRunSummary {
  /** What a live run would try to move now (after the per-run limit). */
  wouldMove: number;
  /** All eligible matches, before the limit. */
  matched: number;
  limit: number;
}

export function summarizeDryRun(res: SenderRuleApplyResponse): DryRunSummary {
  return { wouldMove: res.totals.selected, matched: res.totals.matched, limit: res.limit };
}

export function dryRunText(summary: DryRunSummary): string {
  const extra =
    summary.matched > summary.wouldMove
      ? ` (of ${summary.matched} matching; per-run limit ${summary.limit})`
      : "";
  return `Saved rule currently would move ${summary.wouldMove} email${summary.wouldMove === 1 ? "" : "s"}${extra}`;
}

/** Async check state for the confirm step. */
export type Check<T> =
  | { state: "skipped" }
  | { state: "loading" }
  | { state: "done"; value: T }
  | { state: "error"; message: string };

/** `y` is accepted only once every check that runs has settled. */
export function checksSettled(...checks: Check<unknown>[]): boolean {
  return checks.every((c) => c.state !== "loading");
}

export interface MappedErrors {
  fieldErrors: FieldErrors;
  /** Errors for no form field (formErrors, or fields the form lacks). */
  formErrors: string[];
}

function isEditField(key: string): key is EditField {
  return (EDIT_FIELDS as readonly string[]).includes(key);
}

/**
 * Maps a flattened Zod 400 body ({ formErrors, fieldErrors }) onto the
 * form. Returns null for any other body, so the caller shows the plain
 * message instead.
 */
export function mapValidationErrors(body: unknown): MappedErrors | null {
  const b = body as {
    formErrors?: unknown;
    fieldErrors?: Record<string, unknown>;
  } | null;
  if (!b || typeof b !== "object" || (!b.formErrors && !b.fieldErrors)) return null;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
  const fieldErrors: FieldErrors = {};
  const formErrors = strings(b.formErrors);
  for (const [key, errs] of Object.entries(b.fieldErrors ?? {})) {
    const list = strings(errs);
    if (!list.length) continue;
    if (isEditField(key)) fieldErrors[key] = [...(fieldErrors[key] ?? []), ...list];
    else formErrors.push(...list.map((e) => `${key}: ${e}`));
  }
  return { fieldErrors, formErrors };
}

/** A save that changed these reports the linked-classification count. */
export function reportsLinkedClassifications(patch: RulePatch): boolean {
  return patch.pattern !== undefined || patch.matchType !== undefined || patch.category !== undefined;
}

export function linkedClassificationsText(count: number): string {
  return `${count} existing classification${count === 1 ? "" : "s"} stay${count === 1 ? "s" : ""} linked and unchanged`;
}

/** One line per changed field: `pattern: a.com → b.com`. */
export function describeChanges(original: EditableRule, patch: RulePatch): string[] {
  const show = (v: unknown) => (v === null || v === undefined || v === "" ? "(none)" : String(v));
  return (Object.keys(patch) as (keyof RulePatch)[])
    .sort((a, b) => EDIT_FIELDS.indexOf(a) - EDIT_FIELDS.indexOf(b))
    .map((key) => `${key}: ${show(original[key])} → ${show(patch[key])}`);
}

/**
 * A save that changed what the rule matches or what it writes (pattern,
 * matchType, category, a switch to classify, or enabling/disabling it —
 * a disabled rule wins nothing, so its rows become release candidates)
 * can leave existing rows out of date, so the post-save message offers
 * `C` (reclassify).
 */
export function offersReclassify(patch: RulePatch): boolean {
  return (
    patch.pattern !== undefined ||
    patch.matchType !== undefined ||
    patch.category !== undefined ||
    patch.enabled !== undefined ||
    patch.action === "classify"
  );
}

export const RECLASSIFY_HINT = "Press C to reclassify existing mail for this rule";

/** Flash text after a successful save. */
export function saveSummary(
  pattern: string,
  warnings: string[],
  linkedCount: number | null,
  offerReclassify = false,
): string {
  const parts = [`Saved ${pattern}`];
  if (linkedCount !== null) parts.push(linkedClassificationsText(linkedCount));
  if (offerReclassify) parts.push(RECLASSIFY_HINT);
  parts.push(...warnings);
  return parts.join(" · ");
}
