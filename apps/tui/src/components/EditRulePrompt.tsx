import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import {
  ApiError,
  applyRulesDryRun,
  errorMessage,
  getRule,
  previewRule,
  updateRule,
  type SenderRule,
  type SenderRulePreview,
} from "../api.js";
import { CategoryPicker } from "./CategoryPicker.js";
import {
  DUPLICATE_RULE_MESSAGE,
  EDIT_FIELDS,
  MATCH_TYPES,
  RULE_ACTIONS,
  TRASH_EDIT_WARNING,
  canDryRunSavedRule,
  changedFields,
  checksSettled,
  cycle,
  describeChanges,
  draftFromRule,
  dryRunText,
  hasChanges,
  localFieldErrors,
  mapValidationErrors,
  needsPreview,
  needsTrashWarning,
  reportsLinkedClassifications,
  saveSummary,
  summarizeDryRun,
  withAction,
  type Check,
  type DryRunSummary,
  type EditDraft,
  type EditField,
  type FieldErrors,
  type RulePatch,
} from "../rule-edit.js";

export interface EditRulePromptProps {
  rule: SenderRule;
  /** After a successful PATCH: the updated rule and the flash text. */
  onSaved: (rule: SenderRule, message: string) => void;
  /** esc from the form: nothing was saved. */
  onCancel: () => void;
}

/** Focusable rows: the fields, then the review button. */
type Row = EditField | "review";
const ROWS: readonly Row[] = [...EDIT_FIELDS, "review"];

const LABELS: Record<EditField, string> = {
  pattern: "Pattern",
  matchType: "Match type",
  action: "Action",
  category: "Category",
  enabled: "Enabled",
  note: "Note",
};

type Step =
  | { kind: "form" }
  | { kind: "category" }
  | {
      kind: "confirm";
      patch: RulePatch;
      trashWarning: boolean;
      preview: Check<SenderRulePreview>;
      dryRun: Check<DryRunSummary>;
    }
  | { kind: "saving"; patch: RulePatch };

/**
 * e key on RulesScreen: edit one rule. A form pre-filled from the rule;
 * enter on "Review changes" (never a save) shows what changed, the match
 * preview when pattern/matchType changed, and the Trash warning when the
 * edit makes the rule move mail. Only y saves, once those have loaded,
 * and only the changed fields are sent.
 */
export function EditRulePrompt({ rule, onSaved, onCancel }: EditRulePromptProps) {
  const [draft, setDraft] = useState<EditDraft>(() => draftFromRule(rule));
  const [row, setRow] = useState<Row>("pattern");
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formErrors, setFormErrors] = useState<string[]>([]);
  // Set synchronously so a burst of y (key repeat, paste) before the next
  // render cannot send a second PATCH.
  const busyRef = useRef(false);

  const backToForm = (fields: FieldErrors, form: string[]) => {
    setFieldErrors(fields);
    setFormErrors(form);
    const first = EDIT_FIELDS.find((f) => fields[f]?.length);
    if (first) setRow(first);
    setStep({ kind: "form" });
  };

  // Entering confirm: run the read-only checks once.
  const confirmPatch = step.kind === "confirm" ? step.patch : null;
  useEffect(() => {
    if (step.kind !== "confirm") return;
    let cancelled = false;
    if (step.preview.state === "loading") {
      previewRule(draft.pattern.trim(), draft.matchType)
        .then((value) => {
          if (cancelled) return;
          setStep((s) => (s.kind === "confirm" ? { ...s, preview: { state: "done", value } } : s));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          const mapped =
            err instanceof ApiError && err.status === 400 ? mapValidationErrors(err.body) : null;
          if (mapped) {
            // The pattern itself is invalid: fix it in the form.
            backToForm(mapped.fieldErrors, mapped.formErrors);
            return;
          }
          setStep((s) =>
            s.kind === "confirm"
              ? { ...s, preview: { state: "error", message: errorMessage(err) } }
              : s,
          );
        });
    }
    if (step.dryRun.state === "loading") {
      // Always a dry run (applyRulesDryRun cannot send dryRun=false),
      // scoped to the SAVED rule.
      applyRulesDryRun({ ruleId: rule.id })
        .then((res) => {
          if (cancelled) return;
          const value = summarizeDryRun(res);
          setStep((s) => (s.kind === "confirm" ? { ...s, dryRun: { state: "done", value } } : s));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setStep((s) =>
            s.kind === "confirm"
              ? { ...s, dryRun: { state: "error", message: errorMessage(err) } }
              : s,
          );
        });
    }
    return () => {
      cancelled = true;
    };
    // Once per confirm step, not on every re-render.
  }, [confirmPatch]);

  const review = () => {
    const local = localFieldErrors(draft);
    if (Object.keys(local).length) {
      backToForm(local, []);
      return;
    }
    const patch = changedFields(rule, draft);
    if (!hasChanges(patch)) {
      setFieldErrors({});
      setFormErrors(["Nothing changed"]);
      return;
    }
    const trashWarning = needsTrashWarning(rule, draft, patch);
    setFieldErrors({});
    setFormErrors([]);
    setStep({
      kind: "confirm",
      patch,
      trashWarning,
      preview: needsPreview(rule, draft, patch) ? { state: "loading" } : { state: "skipped" },
      dryRun:
        trashWarning && canDryRunSavedRule(rule) ? { state: "loading" } : { state: "skipped" },
    });
  };

  const save = async (patch: RulePatch) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setStep({ kind: "saving", patch });
    try {
      const res = await updateRule(rule.id, patch);
      let linked: number | null = null;
      if (reportsLinkedClassifications(patch)) {
        try {
          linked = (await getRule(rule.id))._count?.classifications ?? null;
        } catch {
          // Count unavailable (older API): the save itself succeeded.
        }
      }
      onSaved(res.rule, saveSummary(res.rule.pattern, res.warnings, linked));
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        backToForm({}, [DUPLICATE_RULE_MESSAGE]);
      } else {
        const mapped =
          err instanceof ApiError && err.status === 400 ? mapValidationErrors(err.body) : null;
        if (mapped) backToForm(mapped.fieldErrors, mapped.formErrors);
        else backToForm({}, [`Save failed: ${errorMessage(err)}`]);
      }
    } finally {
      busyRef.current = false;
    }
  };

  const moveRow = (dir: 1 | -1) => {
    const i = ROWS.indexOf(row);
    setRow(ROWS[Math.min(Math.max(i + dir, 0), ROWS.length - 1)]);
  };

  const change = (dir: 1 | -1) => {
    if (row === "matchType") {
      setDraft((d) => ({ ...d, matchType: cycle(MATCH_TYPES, d.matchType, dir) }));
    } else if (row === "action") {
      setDraft((d) => withAction(d, cycle(RULE_ACTIONS, d.action, dir), rule));
    } else if (row === "enabled") {
      setDraft((d) => ({ ...d, enabled: !d.enabled }));
    }
  };

  useInput(
    (input, key) => {
      if (step.kind === "saving") return;
      if (step.kind === "confirm") {
        // A repeated y after the first one dispatched must not fire again.
        if (busyRef.current) return;
        if (input === "n" || key.escape) {
          // Back to the form with the input intact; nothing was saved.
          setStep({ kind: "form" });
          return;
        }
        // Only an explicit y saves (never Enter), and only once the
        // preview and dry run (or their errors) are on screen.
        if (input === "y" && checksSettled(step.preview, step.dryRun)) {
          void save(step.patch);
        }
        return;
      }
      // Form. Text fields get printable keys via TextInput.
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow || (key.tab && key.shift)) {
        moveRow(-1);
      } else if (key.downArrow || key.tab) {
        moveRow(1);
      } else if (key.leftArrow && row !== "pattern" && row !== "note") {
        change(-1);
      } else if (key.rightArrow && row !== "pattern" && row !== "note") {
        change(1);
      } else if (input === " " && row === "enabled") {
        change(1);
      } else if (key.return) {
        if (row === "review") review();
        else if (row === "category") setStep({ kind: "category" });
        else moveRow(1);
      }
    },
    { isActive: step.kind !== "category" },
  );

  if (step.kind === "category") {
    return (
      <CategoryPicker
        title={`Category for ${draft.pattern.trim() || rule.pattern}`}
        allowNone={false}
        cancelLabel="back to the form"
        onSelect={(category) => {
          if (category) {
            setDraft((d) => ({ ...d, category }));
            setFieldErrors((e) => ({ ...e, category: undefined }));
          }
          setStep({ kind: "form" });
        }}
        onCancel={() => setStep({ kind: "form" })}
      />
    );
  }

  const box = (children: ReactNode, footer: string) => (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan" wrap="truncate-end">
        Edit rule {rule.matchType} {rule.pattern}
      </Text>
      {children}
      <Text dimColor>{footer}</Text>
    </Box>
  );

  if (step.kind === "saving") {
    return box(<Text>Saving…</Text>, " ");
  }

  if (step.kind === "confirm") {
    const { patch, trashWarning, preview, dryRun } = step;
    const settled = checksSettled(preview, dryRun);
    return box(
      <>
        {describeChanges(rule, patch).map((line) => (
          <Text key={line} wrap="truncate-end">
            {line}
          </Text>
        ))}
        {preview.state === "loading" ? (
          <Text dimColor>Counting matching mail…</Text>
        ) : preview.state === "error" ? (
          <Text color="yellow" wrap="truncate-end">
            Preview unavailable: {preview.message}
          </Text>
        ) : preview.state === "done" ? (
          <>
            <Text wrap="truncate-end">
              <Text bold color={trashWarning ? "red" : undefined}>
                Edited rule matches {preview.value.matchedEmails} stored email
                {preview.value.matchedEmails === 1 ? "" : "s"}
              </Text>
              {` · ${preview.value.unclassifiedMatches} unclassified (only these get classified)`}
            </Text>
            {preview.value.domains.length > 0 ? (
              <Text dimColor wrap="truncate-end">
                Top domains:{" "}
                {preview.value.domains
                  .slice(0, 3)
                  .map((d) => `${d.domain} (${d.count})`)
                  .join(", ")}
              </Text>
            ) : null}
            {preview.value.protectedHits.length > 0 ? (
              <Text color="yellow" wrap="truncate-end">
                Protected look-alike: {preview.value.protectedHits.join(", ")}
              </Text>
            ) : null}
          </>
        ) : null}
        {trashWarning ? (
          <>
            <Text bold color="red" wrap="truncate-end">
              {TRASH_EDIT_WARNING}
              {draft.enabled ? "" : " (once the rule is enabled)"}
            </Text>
            {dryRun.state === "skipped" ? (
              <Text dimColor wrap="truncate-end">
                Saved rule is not an enabled trash rule, so it currently moves nothing
              </Text>
            ) : dryRun.state === "loading" ? (
              <Text dimColor>Dry run of the saved rule…</Text>
            ) : dryRun.state === "error" ? (
              <Text color="yellow" wrap="truncate-end">
                Dry run unavailable: {dryRun.message}
              </Text>
            ) : (
              <Text color="red" wrap="truncate-end">
                {dryRunText(dryRun.value)}
              </Text>
            )}
          </>
        ) : null}
      </>,
      settled ? "y save · n/esc back to the form" : "waiting for preview… · n/esc back to the form",
    );
  }

  const errorLines = (field: EditField) =>
    (fieldErrors[field] ?? []).map((e) => (
      <Text key={`${field}:${e}`} color="red" wrap="wrap">
        {"             "}
        {e}
      </Text>
    ));

  const label = (field: Row, text: string) => (
    <Text color={row === field ? "cyan" : undefined}>
      {row === field ? "> " : "  "}
      {text.padEnd(11)}
    </Text>
  );

  const picker = (value: string) => <Text>‹ {value} ›</Text>;

  return box(
    <>
      {EDIT_FIELDS.map((field) => (
        <Box key={field} flexDirection="column">
          <Box>
            {label(field, LABELS[field])}
            {field === "pattern" ? (
              <TextInput
                value={draft.pattern}
                focus={row === "pattern"}
                onChange={(pattern) => setDraft((d) => ({ ...d, pattern }))}
              />
            ) : field === "note" ? (
              <TextInput
                value={draft.note}
                placeholder="(none)"
                focus={row === "note"}
                onChange={(note) => setDraft((d) => ({ ...d, note }))}
              />
            ) : field === "matchType" ? (
              picker(draft.matchType)
            ) : field === "action" ? (
              <Text color={draft.action === "trash" ? "red" : undefined}>‹ {draft.action} ›</Text>
            ) : field === "category" ? (
              <Text>
                {draft.category ?? <Text color="yellow">(pick one)</Text>}
                <Text dimColor>{row === "category" ? "  enter to pick" : ""}</Text>
              </Text>
            ) : (
              <Text color={draft.enabled ? "green" : "gray"}>
                [{draft.enabled ? "x" : " "}] {draft.enabled ? "on" : "off"}
              </Text>
            )}
          </Box>
          {errorLines(field)}
        </Box>
      ))}
      <Text color={row === "review" ? "cyan" : undefined} inverse={row === "review"}>
        {row === "review" ? "> " : "  "}Review changes
      </Text>
      {formErrors.map((e) => (
        <Text key={e} color="red" wrap="wrap">
          {e}
        </Text>
      ))}
    </>,
    "↑/↓ tab move · ←/→ change · space toggle · enter next/pick/review · esc cancel",
  );
}
