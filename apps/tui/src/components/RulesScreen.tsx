import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  deleteRule,
  errorMessage,
  listRules,
  updateRule,
  type SenderRule,
} from "../api.js";

export interface RulesScreenProps {
  /** b/esc — back to the list. */
  onBack: () => void;
}

function truncate(value: string, width: number): string {
  if (width <= 1) return "";
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

/**
 * R key: every sender rule. space toggles enabled, d deletes after a y/n
 * confirm. Nothing here touches a mailbox; rules only pre-classify until
 * the mailbox-writes kill switch ships.
 */
export function RulesScreen({ onBack }: RulesScreenProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [rules, setRules] = useState<SenderRule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  // Set synchronously so a burst of y (key repeat, paste) before the next
  // render cannot send a second delete.
  const busyRef = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState<SenderRule | null>(null);
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = (text: string, isError = false) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus({ text, isError });
    statusTimer.current = setTimeout(() => setStatus(null), 4000);
  };

  useEffect(() => {
    return () => {
      if (statusTimer.current) clearTimeout(statusTimer.current);
    };
  }, []);

  const load = useCallback(async () => {
    try {
      setRules(await listRules());
      setLoadError(null);
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const list = rules ?? [];
  const safeCursor = Math.min(cursor, Math.max(0, list.length - 1));
  const selected = list[safeCursor];

  const toggle = async (rule: SenderRule) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await updateRule(rule.id, { enabled: !rule.enabled });
      setRules((rs) => (rs ?? []).map((r) => (r.id === rule.id ? res.rule : r)));
      flash(`${res.rule.enabled ? "Enabled" : "Disabled"} ${res.rule.pattern}`);
    } catch (err) {
      flash(errorMessage(err), true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const remove = async (rule: SenderRule) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setConfirmDelete(null);
    setBusy(true);
    try {
      await deleteRule(rule.id);
      setRules((rs) => (rs ?? []).filter((r) => r.id !== rule.id));
      flash(`Deleted ${rule.pattern}`);
    } catch (err) {
      flash(errorMessage(err), true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (confirmDelete) {
      // A repeated y after the first one dispatched must not fire again.
      if (busyRef.current) return;
      if (input === "y") void remove(confirmDelete);
      else if (input === "n" || key.escape) {
        setConfirmDelete(null);
        flash("Delete cancelled");
      }
      return;
    }
    if (input === "q") {
      exit();
      return;
    }
    // Stay put while a toggle or delete is in flight.
    if (busy || busyRef.current) return;
    if (input === "b" || key.escape) {
      onBack();
      return;
    }
    if (input === "j" || key.downArrow) {
      setCursor(Math.min(safeCursor + 1, Math.max(0, list.length - 1)));
    } else if (input === "k" || key.upArrow) {
      setCursor(Math.max(safeCursor - 1, 0));
    } else if (input === " ") {
      if (selected) void toggle(selected);
    } else if (input === "d") {
      if (selected) setConfirmDelete(selected);
    }
  });

  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const typeWidth = 13;
  const actionWidth = 8;
  const categoryWidth = 15;
  const enabledWidth = 3;
  const sourceWidth = 10;
  const patternWidth = Math.max(
    16,
    columns - typeWidth - actionWidth - categoryWidth - enabledWidth - sourceWidth - 16,
  );

  const header = (
    <Text bold>
      Sender rules{rules ? ` — ${rules.length}` : ""}
      <Text dimColor> · rules pre-classify only; trash rules move mail once mailbox writes are enabled</Text>
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
  if (!rules) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading sender rules…</Text>
      </Box>
    );
  }

  const viewportHeight = Math.max(3, rows - 7);
  const start = Math.max(
    0,
    Math.min(safeCursor - Math.floor(viewportHeight / 2), list.length - viewportHeight),
  );
  const visible = list.slice(start, start + viewportHeight);

  return (
    <Box flexDirection="column" paddingX={1}>
      {header}
      {list.length === 0 ? (
        <Text>No sender rules yet. Press x on an email, or G for suggestions.</Text>
      ) : (
        <>
          <Box columnGap={2}>
            <Box width={enabledWidth}>
              <Text dimColor underline>On</Text>
            </Box>
            <Box width={patternWidth}>
              <Text dimColor underline>Pattern</Text>
            </Box>
            <Box width={typeWidth}>
              <Text dimColor underline>Type</Text>
            </Box>
            <Box width={actionWidth}>
              <Text dimColor underline>Action</Text>
            </Box>
            <Box width={categoryWidth}>
              <Text dimColor underline>Category</Text>
            </Box>
            <Box width={sourceWidth}>
              <Text dimColor underline>Source</Text>
            </Box>
          </Box>
          {visible.map((rule, i) => {
            const isSel = start + i === safeCursor;
            return (
              <Box key={rule.id} columnGap={2}>
                <Box width={enabledWidth}>
                  <Text inverse={isSel} color={rule.enabled ? "green" : "gray"}>
                    {rule.enabled ? "on" : "off"}
                  </Text>
                </Box>
                <Box width={patternWidth}>
                  <Text inverse={isSel} wrap="truncate-end" dimColor={!rule.enabled && !isSel}>
                    {isSel ? "> " : "  "}
                    {truncate(rule.pattern, patternWidth - 2)}
                  </Text>
                </Box>
                <Box width={typeWidth}>
                  <Text inverse={isSel}>{rule.matchType}</Text>
                </Box>
                <Box width={actionWidth}>
                  <Text inverse={isSel} color={rule.action === "trash" ? "red" : undefined}>
                    {rule.action}
                  </Text>
                </Box>
                <Box width={categoryWidth}>
                  <Text inverse={isSel} color={isSel ? undefined : "cyan"} wrap="truncate-end">
                    {rule.category}
                  </Text>
                </Box>
                <Box width={sourceWidth}>
                  <Text inverse={isSel} dimColor={!isSel} wrap="truncate-end">
                    {rule.source}
                  </Text>
                </Box>
              </Box>
            );
          })}
        </>
      )}
      {confirmDelete ? (
        <Text color="yellow">
          Delete {confirmDelete.matchType} rule {confirmDelete.pattern}? y delete · n/esc keep
        </Text>
      ) : (
        <Text dimColor>j/k move · space enable/disable · d delete · b back · q quit</Text>
      )}
      {status ? (
        <Text color={status.isError ? "red" : "green"}>{status.text}</Text>
      ) : busy ? (
        <Text dimColor>working…</Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}
