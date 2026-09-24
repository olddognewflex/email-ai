import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import {
  ApiError,
  createRule,
  errorMessage,
  matchSenderRule,
  previewRule,
  type SenderRule,
  type SenderRuleAction,
  type SenderRuleMatchType,
  type SenderRulePreview,
} from "../api.js";
import { CategoryPicker, CATEGORY_PICKER_HEIGHT } from "./CategoryPicker.js";
import {
  TRASH_PENDING_FLASH,
  coveredText,
  normalizeAddress,
  usableSenderDomain,
  type FlashTone,
} from "../sender-block.js";

export { TRASH_PENDING_FLASH, type FlashTone };

/**
 * Rows the prompt can take: the category step renders a CategoryPicker
 * (without its "no correction" row); the other steps a box of at most
 * border 2 + title 1 + 3 option/preview rows + 2 notes + footer 1 (the
 * confirm step: scope, preview, coverage hint, protected hit, trash note).
 * Screens reserve this many lines while the prompt is open.
 */
export const ADD_RULE_PROMPT_HEIGHT = Math.max(CATEGORY_PICKER_HEIGHT - 1, 9);

/** Shown for trash rules until the mailbox-writes kill switch exists. */
export const TRASH_PENDING_NOTE =
  "will move to Trash once mailbox writes are enabled; until then it only pre-classifies as delete";

export interface AddRulePromptProps {
  fromAddress: string | null;
  senderDomain: string | null;
  /** Recorded in the rule's note as `tui:block <sourceId>`. */
  sourceId: string;
  /**
   * Called once the flow ends, with the flash text for the screen and its
   * tone: ok (created), info (nothing changed), error. `rule` is set
   * only when a rule was created (so the screen can offer `z` undo).
   */
  onDone: (message: string, tone: FlashTone, rule?: SenderRule) => void;
  /** esc before anything was created. */
  onCancel: () => void;
}

type Scope = { matchType: SenderRuleMatchType; pattern: string };

type Step =
  | { kind: "scope" }
  | { kind: "action"; scope: Scope }
  | { kind: "category"; scope: Scope }
  | {
      kind: "confirm";
      scope: Scope;
      action: SenderRuleAction;
      category: string;
      preview: SenderRulePreview | null;
      previewError: string | null;
      /** An enabled rule already covering this sender (advisory only). */
      covering: SenderRule | null;
    }
  | { kind: "saving" };

const ACTIONS: { action: SenderRuleAction; label: string }[] = [
  { action: "trash", label: "Trash (category delete) — default" },
  { action: "classify", label: "Classify only — pick a category…" },
];

/**
 * x key: block the current email's sender. Scope (address | domain), then
 * action (trash by default, or classify with a category), then a preview
 * count from stored mail, then y/n. Creates at most one rule.
 */
export function AddRulePrompt({
  fromAddress,
  senderDomain,
  sourceId,
  onDone,
  onCancel,
}: AddRulePromptProps) {
  const address = normalizeAddress(fromAddress);
  const domain = usableSenderDomain(senderDomain);
  const scopes: (Scope & { label: string })[] = [
    ...(address
      ? [{ matchType: "address" as const, pattern: address, label: `This address  ${address}` }]
      : []),
    ...(domain
      ? [{ matchType: "domain" as const, pattern: domain, label: `This domain   ${domain}` }]
      : []),
  ];

  const [step, setStep] = useState<Step>({ kind: "scope" });
  const [cursor, setCursor] = useState(0);

  // Entering confirm: fetch the preview count (read-only).
  const confirmKey =
    step.kind === "confirm" ? `${step.scope.matchType}:${step.scope.pattern}` : null;
  useEffect(() => {
    if (step.kind !== "confirm" || step.preview || step.previewError) return;
    let cancelled = false;
    previewRule(step.scope.pattern, step.scope.matchType)
      .then((preview) => {
        if (!cancelled) {
          setStep((s) => (s.kind === "confirm" ? { ...s, preview } : s));
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStep((s) =>
            s.kind === "confirm" ? { ...s, previewError: errorMessage(err) } : s,
          );
        }
      });
    // Advisory coverage hint: which enabled rule already covers the chosen
    // pattern's sender. Failures (e.g. an older API) just show no hint; a
    // more specific rule is still allowed (exceptions are legitimate).
    const scope = step.scope;
    matchSenderRule(
      scope.matchType === "address"
        ? { address: scope.pattern, domain }
        : { domain: scope.pattern },
    )
      .then((res) => {
        if (!cancelled && res.rule) {
          const covering = res.rule;
          setStep((s) => (s.kind === "confirm" ? { ...s, covering } : s));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // Runs once per confirm step (keyed by scope), not on every re-render.
  }, [confirmKey]);

  const toConfirm = (scope: Scope, action: SenderRuleAction, category: string) => {
    setStep({
      kind: "confirm",
      scope,
      action,
      category,
      preview: null,
      previewError: null,
      covering: null,
    });
  };

  const save = async (scope: Scope, action: SenderRuleAction, category: string) => {
    setStep({ kind: "saving" });
    try {
      const res = await createRule({
        pattern: scope.pattern,
        matchType: scope.matchType,
        action,
        category,
        enabled: true,
        note: `tui:block ${sourceId}`,
        source: "tui",
      });
      const parts = [`Blocked ${res.rule.pattern}`];
      parts.push(
        action === "trash" ? TRASH_PENDING_FLASH : `classifies as ${res.rule.category}`,
      );
      parts.push(...res.warnings);
      onDone(parts.join(" · "), "ok", res.rule);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        onDone(`Rule already exists (see R): ${scope.pattern}`, "info");
      } else {
        onDone(`Block failed: ${errorMessage(err)}`, "error");
      }
    }
  };

  useInput(
    (input, key) => {
      if (step.kind === "saving") return;
      if (key.escape || (step.kind === "confirm" && input === "n")) {
        onCancel();
        return;
      }
      if (step.kind === "confirm") {
        // Only an explicit y creates the rule (never Enter), and only once
        // the preview count (or its error) is on screen.
        if (input === "y" && (step.preview || step.previewError)) {
          void save(step.scope, step.action, step.category);
        }
        return;
      }
      const count = step.kind === "scope" ? scopes.length + 1 : ACTIONS.length;
      if (input === "j" || key.downArrow) {
        setCursor((c) => Math.min(c + 1, count - 1));
      } else if (input === "k" || key.upArrow) {
        setCursor((c) => Math.max(c - 1, 0));
      } else if (key.return) {
        if (step.kind === "scope") {
          const scope = scopes[cursor];
          if (!scope) {
            onCancel();
            return;
          }
          setCursor(0);
          setStep({ kind: "action", scope });
        } else if (step.kind === "action") {
          if (ACTIONS[cursor].action === "trash") {
            toConfirm(step.scope, "trash", "delete");
          } else {
            setStep({ kind: "category", scope: step.scope });
          }
        }
      }
    },
    { isActive: step.kind !== "category" },
  );

  if (step.kind === "category") {
    return (
      <CategoryPicker
        title={`Classify ${step.scope.pattern} as…`}
        allowNone={false}
        cancelLabel="cancel"
        onSelect={(category) => {
          if (category) toConfirm(step.scope, "classify", category);
        }}
        onCancel={onCancel}
      />
    );
  }

  const box = (children: ReactNode, footer: string) => (
    <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
      <Text bold color="red">
        Block sender
      </Text>
      {children}
      <Text dimColor>{footer}</Text>
    </Box>
  );

  if (step.kind === "saving") {
    return box(<Text>Creating rule…</Text>, " ");
  }

  if (step.kind === "confirm") {
    const { scope, action, category, preview, previewError, covering } = step;
    return box(
      <>
        <Text wrap="truncate-end">
          {scope.matchType} <Text color="cyan">{scope.pattern}</Text> → {action}
          {action === "classify" ? ` as ${category}` : " (category delete)"}
        </Text>
        {previewError ? (
          <Text color="yellow" wrap="truncate-end">
            Preview unavailable: {previewError}
          </Text>
        ) : preview ? (
          <Text wrap="truncate-end">
            <Text bold color={action === "trash" ? "red" : undefined}>
              Matches {preview.matchedEmails} stored email
              {preview.matchedEmails === 1 ? "" : "s"}
            </Text>
            {` · ${preview.unclassifiedMatches} unclassified (only these get classified)`}
          </Text>
        ) : (
          <Text dimColor>Counting matching mail…</Text>
        )}
        {covering ? (
          <Text color="yellow" wrap="truncate-end">
            {coveredText(covering, true)}
          </Text>
        ) : null}
        {preview && preview.protectedHits.length > 0 ? (
          <Text color="yellow" wrap="truncate-end">
            Protected look-alike: {preview.protectedHits.join(", ")}
          </Text>
        ) : null}
        {action === "trash" ? (
          <Text dimColor wrap="truncate-end">
            Matching mail {TRASH_PENDING_NOTE}
          </Text>
        ) : null}
      </>,
      preview || previewError
        ? "y create rule · n/esc cancel"
        : "waiting for preview… · n/esc cancel",
    );
  }

  if (step.kind === "action") {
    return box(
      <>
        <Text wrap="truncate-end" dimColor>
          {step.scope.matchType} {step.scope.pattern}
        </Text>
        {ACTIONS.map((a, i) => (
          <Text key={a.action} color={i === cursor ? "cyan" : undefined} inverse={i === cursor}>
            {i === cursor ? "> " : "  "}
            {a.label}
          </Text>
        ))}
      </>,
      "j/k move · enter select · esc cancel",
    );
  }

  const options = [...scopes.map((s) => s.label), "Cancel"];
  return box(
    <>
      {scopes.length === 0 ? (
        <Text color="yellow">No sender address or domain on this email</Text>
      ) : null}
      {options.map((label, i) => (
        <Text key={label} color={i === cursor ? "cyan" : undefined} inverse={i === cursor}>
          {i === cursor ? "> " : "  "}
          {label}
        </Text>
      ))}
    </>,
    "j/k move · enter select · esc cancel",
  );
}
