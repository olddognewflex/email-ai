import { useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { QueueItem } from "../api.js";

export interface ListScreenProps {
  items: QueueItem[];
  total: number;
  loading: boolean;
  onSelect: (id: string) => void;
}

function truncate(value: string, width: number): string {
  if (width <= 1) return "";
  return value.length > width ? `${value.slice(0, width - 1)}…` : value;
}

export function ListScreen({ items, total, loading, onSelect }: ListScreenProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (input === "q") {
      exit();
      return;
    }
    if (loading || items.length === 0) return;

    if (input === "j" || key.downArrow) {
      setCursor((c) => Math.min(c + 1, items.length - 1));
    } else if (input === "k" || key.upArrow) {
      setCursor((c) => Math.max(c - 1, 0));
    } else if (key.return) {
      const item = items[cursor];
      if (item) onSelect(item.classification.id);
    }
  });

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

  // Keep the cursor row visible inside a fixed-height window.
  const rows = stdout?.rows ?? 24;
  const viewportHeight = Math.max(5, rows - 6);
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
      <Text dimColor>j/k move · enter open · q quit</Text>
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
