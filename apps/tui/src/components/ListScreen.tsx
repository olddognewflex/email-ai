import { useRef, useState } from "react";
import { spawn } from "node:child_process";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  API_BASE,
  approveClassification,
  rejectClassification,
  type QueueItem,
} from "../api.js";
import { CategoryPicker, CATEGORY_PICKER_HEIGHT } from "./CategoryPicker.js";

function openExternal(url: string): void {
  const child = spawn("open", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {
    // Swallow spawn failures; the status line already reported the attempt.
  });
  child.unref();
}

/** Only open http(s) links from untrusted email content. */
function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export interface ListScreenProps {
  items: QueueItem[];
  total: number;
  loading: boolean;
  onSelect: (id: string) => void;
  /** Called after a successful approve/reject so the parent can refresh the queue. */
  onActed: () => void;
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
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clamp against the live list so acting on the last row stays in bounds
  // after the parent removes the acted item and re-renders.
  const safeCursor = Math.min(cursor, Math.max(0, items.length - 1));

  const flash = (text: string, isError = false) => {
    if (statusTimer.current) clearTimeout(statusTimer.current);
    setStatus({ text, isError });
    statusTimer.current = setTimeout(() => setStatus(null), 4000);
  };

  const approve = async (id: string) => {
    setBusy(true);
    try {
      await approveClassification(id);
      flash("Approved");
      onActed();
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
      onActed();
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
      if (loading || items.length === 0 || busy) return;

      const item = items[safeCursor];
      if (input === "j" || key.downArrow) {
        setCursor(() => Math.min(safeCursor + 1, items.length - 1));
      } else if (input === "k" || key.upArrow) {
        setCursor(() => Math.max(safeCursor - 1, 0));
      } else if (key.return) {
        if (item) onSelect(item.classification.id);
      } else if (input === "a") {
        if (item) void approve(item.classification.id);
      } else if (input === "r") {
        if (item) setPickerOpen(true);
      } else if (input === "o") {
        if (item) {
          openExternal(`${API_BASE}/review/${item.classification.id}`);
          flash("Opened web view in browser");
        }
      } else if (input === "u") {
        const link = item?.email.unsubscribeLink;
        if (link && isHttpUrl(link)) {
          openExternal(link);
          flash("Opened unsubscribe link in browser");
        } else {
          flash("No unsubscribe link for this email", true);
        }
      }
    },
    { isActive: !pickerOpen },
  );

  const columns = stdout?.columns ?? 80;
  const accountWidth = 10;
  const confidenceWidth = 8;
  const categoryWidth = 17;
  const fromWidth = 26;
  const subjectWidth = Math.max(
    16,
    columns - accountWidth - confidenceWidth - categoryWidth - fromWidth - 10,
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

  // Keep the cursor row visible inside a fixed-height window. While the picker
  // is open it renders below the list, so reserve its height too — otherwise the
  // combined frame overflows the terminal, scrolls the alt-screen, and leaves a
  // ghosted header several lines down once the picker closes.
  const rows = stdout?.rows ?? 24;
  const reserved = 6 + (pickerOpen ? CATEGORY_PICKER_HEIGHT : 0);
  const viewportHeight = Math.max(3, rows - reserved);
  const start = Math.max(
    0,
    Math.min(safeCursor - Math.floor(viewportHeight / 2), items.length - viewportHeight),
  );
  const visible = items.slice(start, start + viewportHeight);
  const selectedItem = items[safeCursor];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        Review queue — {total} pending{items.length < total ? ` (showing ${items.length})` : ""}
      </Text>
      <Box columnGap={2}>
        <Box width={accountWidth}>
          <Text dimColor underline>
            Account
          </Text>
        </Box>
        <Box width={subjectWidth}>
          <Text dimColor underline>
            Subject
          </Text>
        </Box>
        <Box width={fromWidth}>
          <Text dimColor underline>
            From
          </Text>
        </Box>
        <Box width={categoryWidth}>
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
        const selected = index === safeCursor;
        const subject = truncate(item.email.subject ?? "(no subject)", subjectWidth - 2);
        const from = truncate(
          item.email.fromName || item.email.fromAddress || item.email.senderDomain || "(unknown)",
          fromWidth,
        );
        const account = truncate(item.email.accountLabel ?? "—", accountWidth);
        return (
          <Box key={item.classification.id} columnGap={2}>
            <Box width={accountWidth}>
              <Text inverse={selected} color={selected ? undefined : "blue"} wrap="truncate-end">
                {account}
              </Text>
            </Box>
            <Box width={subjectWidth}>
              <Text inverse={selected} wrap="truncate-end">
                {selected ? "> " : "  "}
                {subject}
              </Text>
            </Box>
            <Box width={fromWidth}>
              <Text inverse={selected} wrap="truncate-end" dimColor={!selected}>
                {from}
              </Text>
            </Box>
            <Box width={categoryWidth}>
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
      {pickerOpen && selectedItem ? (
        <CategoryPicker
          onSelect={(category) => void reject(selectedItem.classification.id, category)}
          onCancel={() => {
            setPickerOpen(false);
            flash("Reject cancelled");
          }}
        />
      ) : (
        <Text dimColor>
          j/k move · enter open · a approve · r reject · o open web
          {selectedItem?.email.unsubscribeLink ? " · u unsubscribe" : ""} · q quit
        </Text>
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
