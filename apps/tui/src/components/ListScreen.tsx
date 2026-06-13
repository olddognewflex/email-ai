import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  approveClassification,
  rejectClassification,
  type QueueItem,
} from "../api.js";
import { CategoryPicker } from "./CategoryPicker.js";

export interface ListScreenProps {
  items: QueueItem[];
  total: number;
  loading: boolean;
  onSelect: (id: string) => void;
  /** Called after a successful approve/reject so the parent can refresh. */
  onActed: () => Promise<void>;
}

interface Status {
  text: string;
  isError: boolean;
}

function truncate(value: string, width: number): string {
  if (width <= 1) return "";
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

export function ListScreen({ items, total, loading, onSelect, onActed }: ListScreenProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cursor, setCursor] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
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

  // Items shrink as they are acted on; keep the cursor within bounds.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, items.length - 1)));
  }, [items.length]);

  const approve = async (id: string) => {
    setBusy(true);
    try {
      await approveClassification(id);
      flash("Approved");
      await onActed();
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const reject = async (id: string, correctedCategory: string | null) => {
    setPickerOpen(false);
    setBusy(true);
    try {
      await rejectClassification(id, correctedCategory ?? undefined);
      flash(correctedCategory ? `Rejected -> ${correctedCategory}` : "Rejected");
      await onActed();
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  useInput(
    (input, key) => {
      if (input === "q") {
        exit();
        return;
      }
      if (loading || busy || items.length === 0) return;

      if (input === "j" || key.downArrow) {
        setCursor((c) => Math.min(c + 1, items.length - 1));
      } else if (input === "k" || key.upArrow) {
        setCursor((c) => Math.max(c - 1, 0));
      } else if (key.return) {
        const item = items[cursor];
        if (item) onSelect(item.classification.id);
      } else if (input === "a") {
        const item = items[cursor];
        if (item) void approve(item.classification.id);
      } else if (input === "r") {
        if (items[cursor]) setPickerOpen(true);
      }
    },
    { isActive: !pickerOpen },
  );

  const columns = stdout?.columns ?? 80;
  const confidenceWidth = 8;
  const categoryWidth = 17;
  const fromWidth = 26;
  const subjectWidth = Math.max(
    16,
    columns - confidenceWidth - categoryWidth - fromWidth - 8,
  );

  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading review queue…</Text>
      </Box>
    );
  }

  if (items.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Review queue</Text>
        <Text>Nothing pending review. All caught up.</Text>
        <Text dimColor>q quit</Text>
      </Box>
    );
  }

  // Keep the cursor row visible inside a fixed-height window. The picker
  // appends ~12 rows below the list, so shrink the window while it is open
  // to keep the whole screen within the terminal height.
  const rows = stdout?.rows ?? 24;
  const pickerReserve = pickerOpen ? 12 : 0;
  const viewportHeight = Math.max(3, rows - 6 - pickerReserve);
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(viewportHeight / 2), items.length - viewportHeight),
  );
  const visible = items.slice(start, start + viewportHeight);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        Review queue — {total} pending{items.length < total ? ` (showing ${items.length})` : ""}
      </Text>
      <Box>
        <Box width={subjectWidth + 2}>
          <Text dimColor underline>
            Subject
          </Text>
        </Box>
        <Box width={fromWidth + 2}>
          <Text dimColor underline>
            From
          </Text>
        </Box>
        <Box width={categoryWidth + 2}>
          <Text dimColor underline>
            Category
          </Text>
        </Box>
        <Box width={confidenceWidth}>
          <Text dimColor underline>
            Conf
          </Text>
        </Box>
      </Box>
      {visible.map((item, i) => {
        const index = start + i;
        const selected = index === cursor;
        const subject = truncate(item.email.subject ?? "(no subject)", subjectWidth);
        const from = truncate(
          item.email.fromName || item.email.fromAddress || item.email.senderDomain || "(unknown)",
          fromWidth,
        );
        return (
          <Box key={item.classification.id}>
            <Box width={subjectWidth + 2}>
              <Text inverse={selected} wrap="truncate-end">
                {selected ? "> " : "  "}
                {subject}
              </Text>
            </Box>
            <Box width={fromWidth + 2}>
              <Text inverse={selected} wrap="truncate-end" dimColor={!selected}>
                {from}
              </Text>
            </Box>
            <Box width={categoryWidth + 2}>
              <Text inverse={selected} color={selected ? undefined : "cyan"} wrap="truncate-end">
                {truncate(item.classification.category, categoryWidth)}
              </Text>
            </Box>
            <Box width={confidenceWidth}>
              <Text inverse={selected} color={selected ? undefined : confidenceColor(item.classification.confidence)}>
                {item.classification.confidence}
              </Text>
            </Box>
          </Box>
        );
      })}
      {pickerOpen && items[cursor] ? (
        <CategoryPicker
          onSelect={(category) => void reject(items[cursor].classification.id, category)}
          onCancel={() => {
            setPickerOpen(false);
            flash("Reject cancelled");
          }}
        />
      ) : (
        <Text dimColor>j/k move · enter open · a approve · r reject · q quit</Text>
      )}
      {status ? (
        <Text color={status.isError ? "red" : "green"}>{status.text}</Text>
      ) : busy ? (
        <Text dimColor>Working…</Text>
      ) : (
        <Text> </Text>
      )}
    </Box>
  );
}

function confidenceColor(confidence: string): string | undefined {
  switch (confidence) {
    case "high":
      return "green";
    case "medium":
      return "yellow";
    case "low":
      return "red";
    default:
      return undefined;
  }
}
