import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  ApiError,
  applyRulesDryRun,
  errorMessage,
  fetchMailboxActions,
  fetchWriteStatus,
  listRules,
  MAILBOX_ACTIONS_UNSUPPORTED_MESSAGE,
  reconcileMailboxActions,
  undoMailboxAction,
  type MailboxAction,
  type MailboxActionStatus,
  type MailboxReconcileResponse,
  type SenderRuleApplyResponse,
} from "../api.js";
import {
  actionLabel,
  filterLabel,
  nextStatusFilter,
  shortTimestamp,
  statusColor,
  undoBlockedReason,
} from "../mailbox-actions-view.js";

export interface MailboxActionsScreenProps {
  /** b/esc — back to the list. */
  onBack: () => void;
}

const LIMIT = 100;

function truncate(value: string, width: number): string {
  if (width <= 1) return "";
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

type Confirm = { kind: "undo"; item: MailboxAction } | { kind: "reconcile" };

interface PanelLine {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

/** A read-only result panel (apply preview, reconcile report); esc closes. */
interface Panel {
  title: string;
  lines: PanelLine[];
}

function previewPanel(res: SenderRuleApplyResponse): Panel {
  const t = res.totals;
  const lines: PanelLine[] = [
    {
      text: `DRY RUN — nothing was moved. Would move ${t.selected} of ${t.matched} matching INBOX emails (limit ${res.limit}).`,
      bold: true,
    },
    {
      text: res.writesEnabled
        ? "Writes are ENABLED: the hourly job will move these on its next run."
        : "Writes are disabled: the hourly job only logs this preview.",
      color: res.writesEnabled ? "red" : "green",
    },
  ];
  if (res.byRule.length === 0) {
    lines.push({ text: "No enabled trash rules configured.", dim: true });
  } else if (t.matched === 0) {
    lines.push({ text: "Enabled trash rules match no INBOX mail.", dim: true });
  }
  for (const rule of res.byRule) {
    const matched = rule.byAccount.reduce((n, a) => n + a.matched, 0);
    const selected = rule.byAccount.reduce((n, a) => n + a.selected, 0);
    lines.push({
      text: `${rule.matchType} ${rule.pattern}: would move ${selected} (matched ${matched})`,
      color: "cyan",
    });
    for (const acct of rule.byAccount) {
      lines.push({
        text: `  ${acct.accountLabel}: would move ${acct.selected} (matched ${acct.matched})${acct.error ? ` · ${acct.error}` : ""}`,
        color: acct.error ? "yellow" : undefined,
      });
    }
  }
  return { title: "Apply preview (dry run)", lines };
}

function reconcilePanel(res: MailboxReconcileResponse): Panel {
  const lines: PanelLine[] = [
    {
      text: `Examined ${res.examined} · resolved ${res.resolved} · unresolved ${res.unresolved}`,
      bold: true,
    },
  ];
  if (res.examined === 0) {
    lines.push({
      text: "Nothing to do: no pending/unknown rows older than 10 minutes.",
      dim: true,
    });
  }
  for (const acct of res.accounts) {
    if (acct.error) lines.push({ text: `Account ${acct.accountId}: ${acct.error}`, color: "red" });
    for (const item of acct.items) {
      lines.push({
        text: `  ${item.id} ${item.action}: ${item.from} → ${item.to ?? "unresolved"} · ${item.detail}`,
        color: item.to ? undefined : "yellow",
      });
    }
  }
  if (res.unresolved > 0) {
    lines.push({ text: "Unresolved rows need a look in the mailbox by hand.", dim: true });
  }
  return { title: "Reconcile result", lines };
}

/**
 * M key: the MailboxAction audit log, newest first. `u` undoes a succeeded
 * move to Trash, `p` previews an apply run (always a dry run), `c` runs
 * reconcile. Undo and reconcile each need a y/n confirm, and the API
 * refuses both while mailbox writes are disabled.
 */
export function MailboxActionsScreen({ onBack }: MailboxActionsScreenProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [writesEnabled, setWritesEnabled] = useState<boolean | null>(null);
  const [actions, setActions] = useState<MailboxAction[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [rulePatterns, setRulePatterns] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<MailboxActionStatus | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  // Set synchronously so a burst of keys (key repeat, paste) arriving before
  // the next render cannot start a second undo or reconcile.
  const busyRef = useRef(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [panelScroll, setPanelScroll] = useState(0);
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (text: string, isError = false) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus({ text, isError });
    statusTimer.current = setTimeout(() => setStatus(null), isError ? 10000 : 5000);
  };

  useEffect(() => {
    return () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    };
  }, []);

  const load = useCallback(async (f: MailboxActionStatus | undefined) => {
    try {
      const [s, list] = await Promise.all([
        fetchWriteStatus(),
        fetchMailboxActions({ limit: LIMIT, status: f }),
      ]);
      setWritesEnabled(s.writesEnabled);
      setActions(list);
      setLoadError(null);
    } catch (err) {
      if (err instanceof ApiError && err.message === MAILBOX_ACTIONS_UNSUPPORTED_MESSAGE) {
        setUnsupported(true);
      }
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load(undefined);
    // Rule patterns for the "Rule" column. Best effort: rows show "—" without them.
    listRules()
      .then((rules) => setRulePatterns(Object.fromEntries(rules.map((r) => [r.id, r.pattern]))))
      .catch(() => {});
  }, [load]);

  const list = actions ?? [];
  const safeCursor = Math.min(cursor, Math.max(0, list.length - 1));
  const selected = list[safeCursor];

  /** Run one API call with the busy flag set; b/esc are ignored meanwhile. */
  const run = async (label: string, fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus(null);
    setBusy(label);
    try {
      await fn();
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  const refresh = (f = filter) =>
    run("refreshing", async () => {
      await load(f);
    });

  const undo = (item: MailboxAction) =>
    run("moving back to INBOX", async () => {
      try {
        await undoMailboxAction(item.id);
        flash(`Moved back to INBOX: ${item.subject ?? "(no subject)"}`);
      } catch (err) {
        flash(`Undo failed${err instanceof ApiError && err.status ? ` (${err.status})` : ""}: ${errorMessage(err)}`, true);
      }
      await load(filter);
    });

  const preview = () =>
    run("previewing apply (dry run)", async () => {
      try {
        const res = await applyRulesDryRun();
        setPanelScroll(0);
        setPanel(previewPanel(res));
      } catch (err) {
        flash(`Preview failed: ${errorMessage(err)}`, true);
      }
    });

  const reconcile = () =>
    run("reconciling", async () => {
      try {
        const res = await reconcileMailboxActions();
        setPanelScroll(0);
        setPanel(reconcilePanel(res));
      } catch (err) {
        flash(`Reconcile failed${err instanceof ApiError && err.status ? ` (${err.status})` : ""}: ${errorMessage(err)}`, true);
      }
      await load(filter);
    });

  useInput((input, key) => {
    if (confirm) {
      // A repeated y after the first one dispatched must not fire again.
      if (busyRef.current) return;
      if (input === "y") {
        setConfirm(null);
        if (confirm.kind === "undo") void undo(confirm.item);
        else void reconcile();
      } else if (input === "n" || key.escape) {
        setConfirm(null);
        flash(confirm.kind === "undo" ? "Undo cancelled" : "Reconcile cancelled");
      }
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    // Stay put while a call is in flight: its result lands here.
    if (busy || busyRef.current) return;
    if (panel) {
      if (key.escape || input === "b") setPanel(null);
      else if (input === "j" || key.downArrow) setPanelScroll((s) => s + 1);
      else if (input === "k" || key.upArrow) setPanelScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (input === "b" || key.escape) {
      onBack();
      return;
    }
    if (unsupported) return;
    if (input === "r") {
      void refresh();
    } else if (input === "f") {
      const next = nextStatusFilter(filter);
      setFilter(next);
      setCursor(0);
      void refresh(next);
    } else if (input === "p") {
      void preview();
    } else if (input === "c") {
      setConfirm({ kind: "reconcile" });
    } else if (input === "j" || key.downArrow) {
      setCursor(Math.min(safeCursor + 1, Math.max(0, list.length - 1)));
    } else if (input === "k" || key.upArrow) {
      setCursor(Math.max(safeCursor - 1, 0));
    } else if (input === "u") {
      if (!selected) return;
      const blocked = undoBlockedReason(selected);
      if (blocked) flash(blocked, true);
      else setConfirm({ kind: "undo", item: selected });
    }
  });

  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  const header = (
    <Text bold>
      Mailbox actions{actions ? ` — ${actions.length}${actions.length >= LIMIT ? "+" : ""}` : ""}
      <Text dimColor> · filter: {filterLabel(filter)} · </Text>
      {writesEnabled === null ? (
        <Text dimColor>writes: ?</Text>
      ) : writesEnabled ? (
        <Text color="red" inverse>
          {" WRITES ENABLED "}
        </Text>
      ) : (
        <Text color="green" inverse>
          {" writes disabled (read-only) "}
        </Text>
      )}
    </Text>
  );

  const footerStatus = status ? (
    <Text color={status.isError ? "red" : "green"} wrap="wrap">
      {status.text}
    </Text>
  ) : busy ? (
    <Text dimColor>working… {busy}</Text>
  ) : (
    <Text> </Text>
  );

  if (unsupported) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Mailbox actions</Text>
        <Text color="yellow">{MAILBOX_ACTIONS_UNSUPPORTED_MESSAGE}</Text>
        <Text dimColor>b back · q quit</Text>
      </Box>
    );
  }
  if (loadError && !actions) {
    return (
      <Box flexDirection="column" padding={1}>
        {header}
        <Text color="red">{loadError}</Text>
        <Text dimColor>r retry · b back · q quit</Text>
        {footerStatus}
      </Box>
    );
  }
  if (!actions) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading mailbox actions…</Text>
      </Box>
    );
  }

  if (panel) {
    const panelHeight = Math.max(3, rows - 6);
    const maxScroll = Math.max(0, panel.lines.length - panelHeight);
    const scroll = Math.min(panelScroll, maxScroll);
    const shown = panel.lines.slice(scroll, scroll + panelHeight);
    return (
      <Box flexDirection="column" paddingX={1}>
        {header}
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{panel.title}</Text>
          {shown.map((line, i) => (
            <Text
              key={scroll + i}
              wrap="truncate-end"
              color={line.color}
              dimColor={line.dim}
              bold={line.bold}
            >
              {line.text}
            </Text>
          ))}
        </Box>
        <Text dimColor>
          {maxScroll > 0 ? `j/k scroll (${scroll + 1}-${scroll + shown.length} of ${panel.lines.length}) · ` : ""}
          esc/b close · q quit
        </Text>
      </Box>
    );
  }

  // Six columns: 5 gaps of 2 plus paddingX 1 on each side = 12, and one
  // spare column so a full-width row never wraps. Fixed columns take 27, so
  // at 80 columns from/note/subject share 40 (15/15/10); wider terminals
  // grow from/note to 24 and give the rest to subject.
  const statusWidth = 9;
  const typeWidth = 7;
  const whenWidth = 11;
  const flexible = Math.max(
    30,
    columns - 13 - statusWidth - typeWidth - whenWidth,
  );
  const subjectMin = 10;
  const fromWidth = Math.min(24, Math.max(10, Math.floor((flexible - subjectMin) / 2)));
  const noteWidth = Math.min(24, Math.max(8, flexible - subjectMin - fromWidth));
  const subjectWidth = Math.max(subjectMin, flexible - fromWidth - noteWidth);

  const detailRows = 5;
  const viewportHeight = Math.max(3, rows - 7 - detailRows);
  const start = Math.max(
    0,
    Math.min(safeCursor - Math.floor(viewportHeight / 2), list.length - viewportHeight),
  );
  const visible = list.slice(start, start + viewportHeight);
  const ruleOf = (a: MailboxAction): string | null =>
    a.senderRuleId ? (rulePatterns[a.senderRuleId] ?? null) : null;

  let confirmLine: ReactNode = null;
  if (confirm?.kind === "undo") {
    confirmLine = (
      <Text color="yellow" wrap="wrap">
        Move back to INBOX? “{truncate(confirm.item.subject ?? "(no subject)", 60)}” from{" "}
        {confirm.item.fromAddress ?? "(unknown)"} · y undo · n/esc cancel
      </Text>
    );
  } else if (confirm?.kind === "reconcile") {
    confirmLine = (
      <Text color="yellow" wrap="wrap">
        Run reconcile? It only resolves pending/unknown rows older than 10 minutes, by
        looking each message up in INBOX and Trash (read-only on the mailbox; it never
        moves mail). Don't run it while an undo is in progress. y run · n/esc cancel
      </Text>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      {list.length === 0 ? (
        <Text>
          {filter
            ? `No ${filter} mailbox actions.`
            : "No mailbox actions yet. Moves are recorded here when the hourly job applies trash rules with writes enabled."}
        </Text>
      ) : (
        <>
          <Box columnGap={2}>
            <Box width={statusWidth}>
              <Text dimColor underline>Status</Text>
            </Box>
            <Box width={typeWidth}>
              <Text dimColor underline>Action</Text>
            </Box>
            <Box width={whenWidth}>
              <Text dimColor underline>When</Text>
            </Box>
            <Box width={fromWidth}>
              <Text dimColor underline>From</Text>
            </Box>
            <Box width={subjectWidth}>
              <Text dimColor underline>Subject</Text>
            </Box>
            <Box width={noteWidth}>
              <Text dimColor underline>Rule / reason</Text>
            </Box>
          </Box>
          {visible.map((a, i) => {
            const isSel = start + i === safeCursor;
            const note = a.error ?? ruleOf(a) ?? "—";
            return (
              <Box key={a.id} columnGap={2}>
                <Box width={statusWidth}>
                  <Text inverse={isSel} color={statusColor(a.status)}>
                    {a.status}
                  </Text>
                </Box>
                <Box width={typeWidth}>
                  <Text inverse={isSel}>{actionLabel(a.action)}</Text>
                </Box>
                <Box width={whenWidth}>
                  <Text inverse={isSel} dimColor={!isSel}>
                    {shortTimestamp(a.createdAt)}
                  </Text>
                </Box>
                <Box width={fromWidth}>
                  <Text inverse={isSel} wrap="truncate-end">
                    {truncate(a.fromAddress ?? "(unknown)", fromWidth)}
                  </Text>
                </Box>
                <Box width={subjectWidth}>
                  <Text inverse={isSel} wrap="truncate-end">
                    {isSel ? "> " : "  "}
                    {truncate(a.subject ?? "(no subject)", subjectWidth - 2)}
                  </Text>
                </Box>
                <Box width={noteWidth}>
                  <Text
                    inverse={isSel}
                    wrap="truncate-end"
                    color={a.error && !isSel ? statusColor(a.status) : undefined}
                    dimColor={!a.error && !isSel}
                  >
                    {truncate(note, noteWidth)}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </>
      )}
      {selected ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1} height={detailRows}>
          <Text wrap="truncate-end">
            {selected.account.label} · {selected.sourceMailbox} uid {selected.sourceUid} →{" "}
            {selected.destMailbox ?? "?"}
            {selected.destUid !== null ? ` uid ${selected.destUid}` : ""}
            {selected.undoneAt ? ` · undone ${shortTimestamp(selected.undoneAt)}` : ""}
            <Text dimColor> · {selected.id}</Text>
          </Text>
          <Text wrap="truncate-end" dimColor={!ruleOf(selected)}>
            Rule: {ruleOf(selected) ?? (selected.senderRuleId ? `${selected.senderRuleId} (deleted?)` : "—")}
          </Text>
          <Text wrap="truncate-end" color={selected.error ? statusColor(selected.status) : undefined} dimColor={!selected.error}>
            Reason: {selected.error ?? "—"}
          </Text>
        </Box>
      ) : null}
      {loadError ? <Text color="red">Refresh failed: {loadError}</Text> : null}
      {confirmLine ?? (
        <Text dimColor>
          j/k move · u undo · f filter ({filterLabel(filter)}) · p preview apply (dry run) · c reconcile · r refresh · b back · q quit
        </Text>
      )}
      {footerStatus}
    </Box>
  );
}
