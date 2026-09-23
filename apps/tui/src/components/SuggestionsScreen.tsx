import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  ApiError,
  createRule,
  errorMessage,
  fetchSuggestions,
  previewRule,
  type SenderRulePreview,
  type SuggestionFamily,
} from "../api.js";

export interface SuggestionsScreenProps {
  /** b/esc — back to the list. */
  onBack: () => void;
}

/** A family awaiting y/n, with a preview per proposed glob. */
interface Confirming {
  family: SuggestionFamily;
  /** Glob pattern → preview, or the error text if the preview failed. */
  previews: Record<string, SenderRulePreview | string>;
}

function globsOf(family: SuggestionFamily): string[] {
  return family.proposedRules
    .filter((r) => r.matchType === "glob")
    .map((r) => r.pattern);
}

/** Per-rule results of creating one family's proposed rules. */
interface CreateOutcome {
  created: string[];
  duplicates: string[];
  errors: string[];
}

function summarize(key: string, o: CreateOutcome): string {
  const parts = [`${key}: created ${o.created.length}`];
  if (o.duplicates.length) parts.push(`${o.duplicates.length} already existed`);
  if (o.errors.length) parts.push(`${o.errors.length} failed (${o.errors[0]})`);
  return parts.join(" · ");
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

/**
 * G key: rule suggestions from classification history, one row per
 * look-alike family. `c` creates the family's proposed (classify) rules
 * after a y/n confirm. Fetching suggestions never creates anything.
 */
export function SuggestionsScreen({ onBack }: SuggestionsScreenProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [families, setFamilies] = useState<SuggestionFamily[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (text: string, isError = false) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus({ text, isError });
    statusTimer.current = setTimeout(() => setStatus(null), 6000);
  };

  useEffect(() => {
    let cancelled = false;
    fetchSuggestions()
      .then((res) => {
        if (!cancelled) setFamilies(res.families);
      })
      .catch((err: unknown) => {
        if (!cancelled) setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      if (statusTimer.current) clearTimeout(statusTimer.current);
    };
  }, []);

  const list = families ?? [];
  const safeCursor = Math.min(cursor, Math.max(0, list.length - 1));
  const selected = list[safeCursor];

  /** c: open the confirm panel and preview every proposed glob (read-only). */
  const startConfirm = (family: SuggestionFamily) => {
    setConfirming({ family, previews: {} });
    for (const pattern of globsOf(family)) {
      previewRule(pattern, "glob")
        .then((p): SenderRulePreview | string => p)
        .catch((err: unknown) => `preview failed: ${errorMessage(err)}`)
        .then((result) => {
          setConfirming((c) =>
            c && c.family.key === family.key
              ? { ...c, previews: { ...c.previews, [pattern]: result } }
              : c,
          );
        });
    }
  };

  const previewsReady = (c: Confirming): boolean =>
    globsOf(c.family).every((p) => p in c.previews);

  const createFamily = async (family: SuggestionFamily) => {
    setConfirming(null);
    setBusy(true);
    // Clear any earlier flash so "working…" shows while rules are created.
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus(null);
    const outcome: CreateOutcome = { created: [], duplicates: [], errors: [] };
    // Sequential: one request at a time against the local API.
    for (const rule of family.proposedRules) {
      try {
        await createRule({
          pattern: rule.pattern,
          matchType: rule.matchType,
          action: "classify",
          category: rule.category,
          enabled: true,
          note: `suggestion:${family.key}`,
          source: "suggestion",
        });
        outcome.created.push(rule.pattern);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          outcome.duplicates.push(rule.pattern);
        } else {
          outcome.errors.push(`${rule.pattern}: ${errorMessage(err)}`);
        }
      }
    }
    setDone((d) => new Set(d).add(family.key));
    setBusy(false);
    flash(summarize(family.key, outcome), outcome.errors.length > 0);
  };

  useInput((input, key) => {
    if (confirming) {
      if (input === "y" && previewsReady(confirming)) {
        void createFamily(confirming.family);
      } else if (input === "n" || key.escape) {
        setConfirming(null);
        flash("Nothing created");
      }
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    // Stay put while rules are being created: the result lands here.
    if (busy) return;
    if (input === "b" || key.escape) {
      onBack();
      return;
    }
    if (input === "j" || key.downArrow) {
      setCursor(Math.min(safeCursor + 1, Math.max(0, list.length - 1)));
    } else if (input === "k" || key.upArrow) {
      setCursor(Math.max(safeCursor - 1, 0));
    } else if (input === "c") {
      if (selected && selected.proposedRules.length > 0) startConfirm(selected);
    }
  });

  const rows = stdout?.rows ?? 24;
  const header = (
    <Text bold>
      Rule suggestions{families ? ` — ${families.length} famil${families.length === 1 ? "y" : "ies"}` : ""}
      <Text dimColor> · from TypeSafe classifications · nothing is created without c + y</Text>
    </Text>
  );

  if (loadError) {
    return (
      <Box flexDirection="column" padding={1}>
        {header}
        <Text color="red">{loadError}</Text>
        <Text dimColor>b back · q quit</Text>
      </Box>
    );
  }
  if (!families) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading suggestions…</Text>
      </Box>
    );
  }

  // Family rows on top, details for the selected family below.
  const detailRows = 6;
  const viewportHeight = Math.max(3, rows - 6 - detailRows);
  const start = Math.max(
    0,
    Math.min(safeCursor - Math.floor(viewportHeight / 2), list.length - viewportHeight),
  );
  const visible = list.slice(start, start + viewportHeight);

  if (confirming) {
    const { family, previews } = confirming;
    const ready = previewsReady(confirming);
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold color="yellow">
            Create {family.proposedRules.length} classify rule
            {family.proposedRules.length === 1 ? "" : "s"} for {family.key} (
            {family.proposedRules[0]?.category ?? "—"})?
          </Text>
          <Text wrap="wrap">
            {family.proposedRules.map((r) => `${r.matchType} ${r.pattern}`).join(", ")}
          </Text>
          {globsOf(family).map((pattern) => {
            const p = previews[pattern];
            return (
              <Text
                key={pattern}
                wrap="wrap"
                color={
                  typeof p === "string" || (p && p.protectedHits.length)
                    ? "yellow"
                    : undefined
                }
              >
                glob {pattern}:{" "}
                {p === undefined
                  ? "counting matching mail…"
                  : typeof p === "string"
                    ? p
                    : `matches ${p.matchedEmails} stored emails (${p.unclassifiedMatches} unclassified)` +
                      (p.protectedHits.length
                        ? ` · protected hits: ${p.protectedHits.join(", ")}`
                        : " · no protected hits")}
              </Text>
            );
          })}
          {family.excludedLegit.length ? (
            <Text wrap="wrap" dimColor>
              Excluded look-alikes: {family.excludedLegit.join(", ")}
            </Text>
          ) : null}
        </Box>
        <Text color="yellow">
          {ready ? "y create · n/esc cancel" : "waiting for glob previews… · n/esc cancel"}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      {list.length === 0 ? (
        <Text>No suggestions: no sender family meets the thresholds, or all are already covered.</Text>
      ) : (
        visible.map((f, i) => {
          const isSel = start + i === safeCursor;
          const globs = f.proposedRules.filter((r) => r.matchType === "glob").length;
          return (
            <Text key={f.key} inverse={isSel} wrap="truncate-end">
              {isSel ? "> " : "  "}
              {done.has(f.key) ? "✓ " : ""}
              {f.key}
              <Text dimColor={!isSel}>
                {"  "}
                {f.kind} · {f.totalEmails} emails · {f.domains.length} domain
                {f.domains.length === 1 ? "" : "s"} · {f.proposedRules.length} rule
                {f.proposedRules.length === 1 ? "" : "s"}
                {globs ? ` (${globs} glob)` : ""}
                {f.excludedLegit.length ? ` · ${f.excludedLegit.length} excluded` : ""}
              </Text>
            </Text>
          );
        })
      )}
      {selected ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} height={detailRows}>
          <Text wrap="truncate-end">
            Rules:{" "}
            {selected.proposedRules
              .map((r) => `${r.matchType} ${r.pattern}`)
              .join(", ") || "(none)"}{" "}
            <Text dimColor>→ classify as {selected.proposedRules[0]?.category ?? "—"}</Text>
          </Text>
          <Text wrap="truncate-end" dimColor>
            Domains:{" "}
            {selected.domains
              .map((d) => `${d.domain} ${d.total} (${percent(d.share)})`)
              .join(", ")}
          </Text>
          <Text wrap="truncate-end" color={selected.excludedLegit.length ? "yellow" : undefined} dimColor={!selected.excludedLegit.length}>
            Excluded look-alikes:{" "}
            {selected.excludedLegit.length ? selected.excludedLegit.join(", ") : "none"}
          </Text>
          <Text wrap="truncate-end" dimColor>
            {selected.proposedRules.some((r) => r.matchType === "domain") &&
            selected.excludedLegit.length
              ? "The family glob would also catch the excluded senders, so one domain rule per sender is proposed."
              : " "}
          </Text>
        </Box>
      ) : null}
      <Text dimColor>j/k move · c create family rules · b back · q quit</Text>
      {status ? (
        <Text color={status.isError ? "red" : "green"} wrap="truncate-end">
          {status.text}
        </Text>
      ) : busy ? (
        <Text dimColor>working… creating rules</Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
