import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  ApiError,
  applyReclassify,
  errorMessage,
  reclassifyRule,
  undoReclassifyBatch,
  type SenderRule,
  type SenderRuleReclassifyResponse,
  type SenderRuleReclassifyUndoResponse,
} from "../api.js";
import {
  DEFAULT_RECLASSIFY_OPTIONS,
  aiLine,
  aiUnavailableNotice,
  applyGate,
  changeCount,
  countsLine,
  failureText,
  moreLine,
  panelTextWidth,
  releaseLine,
  sampleRow,
  toggleRelease,
  toggleScope,
  undoSummary,
  type PreviewState,
  type ReclassifyOptions,
} from "../reclassify-view.js";

export interface ReclassifyScreenProps {
  rule: SenderRule;
  /** b/esc — back to the rules list (ignored while a call is in flight). */
  onBack: () => void;
}

type Confirm =
  | { kind: "cost"; options: ReclassifyOptions; message: string }
  | { kind: "undo"; batchId: string };

const WORKING_APPLY = "reclassifying, this can take a while";

function status(err: unknown): number {
  return err instanceof ApiError ? err.status : 0;
}

/**
 * C key on RulesScreen: re-run one rule over mail that is already
 * classified. Opens with a DRY RUN (scope linked); `s` and `m` toggle
 * scope and release mode and run a new dry run. Only `y` applies (never
 * Enter), only once the dry run for the current options has loaded, and a
 * second `y` is needed when it expects AI calls. `U` undoes the batch this
 * screen applied, after y/n. Classification rows only: never the mailbox.
 */
export function ReclassifyScreen({ rule, onBack }: ReclassifyScreenProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [options, setOptionsState] = useState<ReclassifyOptions>(DEFAULT_RECLASSIFY_OPTIONS);
  const [preview, setPreviewState] = useState<PreviewState>({ state: "none" });
  // Refs mirror options and preview synchronously, so a y arriving before
  // the next render (after an apply marked the dry run stale) is judged on
  // the current state, never on a stale closure.
  const optionsRef = useRef<ReclassifyOptions>(DEFAULT_RECLASSIFY_OPTIONS);
  const previewRef = useRef<PreviewState>({ state: "none" });
  const [applied, setApplied] = useState<SenderRuleReclassifyResponse | null>(null);
  const [undone, setUndone] = useState<SenderRuleReclassifyUndoResponse | null>(null);
  const [lastBatchId, setLastBatchId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Set synchronously so a burst of keys (key repeat, paste) arriving before
  // the next render cannot start a second call.
  const busyRef = useRef(false);
  // Mirrors `confirm` synchronously for the same reason: the first y of a
  // burst opens the cost confirm, and only a later y may accept it.
  const confirmRef = useRef<Confirm | null>(null);
  const [confirm, setConfirmState] = useState<Confirm | null>(null);
  const [flashMsg, setFlashMsg] = useState<{ text: string; isError: boolean } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const setOptions = (o: ReclassifyOptions) => {
    optionsRef.current = o;
    setOptionsState(o);
  };
  const setPreview = (p: PreviewState) => {
    previewRef.current = p;
    setPreviewState(p);
  };

  const setConfirm = (c: Confirm | null) => {
    confirmRef.current = c;
    setConfirmState(c);
  };

  const flash = (text: string, isError = false) => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashMsg({ text, isError });
    flashTimer.current = setTimeout(() => setFlashMsg(null), isError ? 12000 : 5000);
  };

  useEffect(() => {
    return () => {
      mounted.current = false;
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, []);

  /** One API call with the busy flag set; every other key waits. */
  const run = async (label: string, fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (flashTimer.current) clearTimeout(flashTimer.current);
    setFlashMsg(null);
    setBusy(label);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const dryRun = (next: ReclassifyOptions) =>
    run("dry run", async () => {
      setOptions(next);
      setPreview({ state: "loading", options: next });
      try {
        // Always dryRun=true: reclassifyRule has no way to send false.
        const value = await reclassifyRule(rule.id, next);
        if (mounted.current) setPreview({ state: "done", options: next, value });
      } catch (err) {
        if (!mounted.current) return;
        setPreview({
          state: "error",
          options: next,
          message: failureText("Dry run", status(err), errorMessage(err)),
        });
      }
    });

  const apply = (opts: ReclassifyOptions) =>
    run(WORKING_APPLY, async () => {
      try {
        const res = await applyReclassify(rule.id, opts);
        if (!mounted.current) return;
        // The rows changed: the dry run on screen no longer describes them.
        setPreview({ state: "stale" });
        setApplied(res);
        setUndone(null);
        if (res.batchId && changeCount(res) > 0) setLastBatchId(res.batchId);
      } catch (err) {
        if (!mounted.current) return;
        setPreview({ state: "stale" });
        flash(failureText("Apply", status(err), errorMessage(err)), true);
      }
    });

  const undo = (batchId: string) =>
    run("undoing the batch", async () => {
      try {
        const res = await undoReclassifyBatch(batchId);
        if (!mounted.current) return;
        setUndone(res);
        setApplied(null);
        setLastBatchId(null);
        setPreview({ state: "stale" });
      } catch (err) {
        if (!mounted.current) return;
        flash(failureText("Undo", status(err), errorMessage(err)), true);
      }
    });

  // Open with a dry run for the default scope.
  useEffect(() => {
    void dryRun(DEFAULT_RECLASSIFY_OPTIONS);
    // Once, on open.
  }, []);

  useInput((input, key) => {
    // Nothing while a call is in flight: its result lands here.
    if (busyRef.current) return;
    const c = confirmRef.current;
    if (c) {
      // Only y accepts (never Enter).
      if (input === "y") {
        setConfirm(null);
        if (c.kind === "cost") void apply(c.options);
        else void undo(c.batchId);
      } else if (input === "n" || key.escape) {
        setConfirm(null);
        flash(c.kind === "cost" ? "Apply cancelled" : "Undo cancelled");
      }
      return;
    }
    if (input === "b" || key.escape) {
      onBack();
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    const opts = optionsRef.current;
    if (input === "s") {
      void dryRun({ ...opts, scope: toggleScope(opts.scope) });
    } else if (input === "m") {
      void dryRun({ ...opts, release: toggleRelease(opts.release) });
    } else if (input === "r") {
      void dryRun(opts);
    } else if (input === "y") {
      // Only y applies (Enter does nothing here).
      const gate = applyGate(previewRef.current, opts);
      if (gate.kind === "wait") flash(gate.message, true);
      else if (gate.kind === "nothing") flash(gate.message);
      else if (gate.kind === "confirmCost") {
        setConfirm({ kind: "cost", options: opts, message: gate.message });
      } else void apply(opts);
    } else if (input === "U") {
      if (lastBatchId) setConfirm({ kind: "undo", batchId: lastBatchId });
      else flash("No batch applied in this screen to undo", true);
    }
  });

  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const textWidth = panelTextWidth(columns);

  const result = (res: SenderRuleReclassifyResponse, title: string, color: string): ReactNode => {
    const info = [releaseLine(res), aiLine(res), moreLine(res)].filter(
      (l): l is string => l !== null,
    );
    const notice = aiUnavailableNotice(res);
    // Header, options, border and footer lines take ~10 rows; the rest
    // goes to sample rows.
    const sampleRoom = Math.max(1, rows - 12 - info.length - (notice ? 1 : 0));
    const shown = res.sample.slice(0, sampleRoom);
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Text bold color={color} wrap="truncate-end">
          {title}
        </Text>
        <Text wrap="wrap">{countsLine(res)}</Text>
        {info.map((line) => (
          <Text key={line} dimColor wrap="wrap">
            {line}
          </Text>
        ))}
        {notice ? (
          <Text color="yellow" wrap="wrap">
            {notice}
          </Text>
        ) : null}
        {shown.length > 0 ? (
          <>
            <Text dimColor underline wrap="truncate-end">
              Sample{res.sample.length > shown.length ? ` (${shown.length} of ${res.sample.length})` : ""}
            </Text>
            {shown.map((s) => (
              <Text key={s.normalizedEmailId} wrap="truncate-end">
                {sampleRow(s, res.release, textWidth)}
              </Text>
            ))}
          </>
        ) : null}
      </Box>
    );
  };

  let body: ReactNode;
  if (applied) {
    body = result(
      applied,
      `APPLIED (${applied.scope}, ${applied.release}) · batch ${applied.batchId ?? "—"}`,
      "green",
    );
  } else if (preview.state === "done") {
    body = result(
      preview.value,
      `DRY RUN — nothing changed yet (${preview.value.scope}, ${preview.value.release})`,
      "cyan",
    );
  } else if (preview.state === "error") {
    body = (
      <Text color="red" wrap="wrap">
        {preview.message}
      </Text>
    );
  } else if (preview.state === "stale") {
    body = <Text dimColor>Press r for a fresh dry run.</Text>;
  } else {
    body = <Text dimColor>Dry run…</Text>;
  }

  let footer: ReactNode;
  if (confirm?.kind === "cost") {
    footer = (
      <Text color="yellow" wrap="wrap">
        {confirm.message}. Apply? y apply · n/esc cancel
      </Text>
    );
  } else if (confirm?.kind === "undo") {
    footer = (
      <Text color="yellow" wrap="wrap">
        Undo batch {confirm.batchId}? Restores the previous values; rows changed or reviewed
        since are left as they are. y undo · n/esc cancel
      </Text>
    );
  } else {
    footer = (
      <Text dimColor wrap="wrap">
        s scope · m release · r re-run · y apply
        {lastBatchId ? " · U undo batch" : ""} · b back · q quit
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold wrap="truncate-end">
        Reclassify existing mail: {rule.matchType} {rule.pattern}
        <Text dimColor>
          {" "}
          ({rule.action} {rule.category}
          {rule.enabled ? "" : ", disabled"})
        </Text>
      </Text>
      <Text wrap="truncate-end">
        scope <Text color="cyan">{options.scope}</Text>
        <Text dimColor> (s)</Text> · release <Text color="cyan">{options.release}</Text>
        <Text dimColor> (m)</Text> · limit {options.limit}
        <Text dimColor> · no mailbox changes</Text>
      </Text>
      {body}
      {undone ? (
        <Text color="green" wrap="wrap">
          {undoSummary(undone)}
        </Text>
      ) : null}
      {footer}
      {flashMsg ? (
        <Text color={flashMsg.isError ? "red" : "green"} wrap="wrap">
          {flashMsg.text}
        </Text>
      ) : busy ? (
        <Text dimColor>working… ({busy})</Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
