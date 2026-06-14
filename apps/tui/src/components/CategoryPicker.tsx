import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { EmailCategorySchema } from "@email-ai/shared";

const NO_CORRECTION = "(no correction — plain reject)";

/**
 * Rendered line count: round border (2) + title (1) + footer (1) + one row per
 * option (NO_CORRECTION + every category). The list screen reserves this many
 * lines so the picker never overflows the terminal and scrolls the frame.
 */
export const CATEGORY_PICKER_HEIGHT = EmailCategorySchema.options.length + 1 + 4;

export interface CategoryPickerProps {
  /** category string for a corrected reject, or null for a plain reject */
  onSelect: (category: string | null) => void;
  /** esc — abort the reject entirely, no API call */
  onCancel: () => void;
}

export function CategoryPicker({ onSelect, onCancel }: CategoryPickerProps) {
  const options = [NO_CORRECTION, ...EmailCategorySchema.options];
  const [cursor, setCursor] = useState(0);

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      onSelect(cursor === 0 ? null : options[cursor]);
      return;
    }
    if (input === "j" || key.downArrow) {
      setCursor((c) => Math.min(c + 1, options.length - 1));
    } else if (input === "k" || key.upArrow) {
      setCursor((c) => Math.max(c - 1, 0));
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Reject — what should it have been?
      </Text>
      {options.map((option, i) => (
        <Text key={option} color={i === cursor ? "cyan" : undefined} inverse={i === cursor}>
          {i === cursor ? "> " : "  "}
          {option}
        </Text>
      ))}
      <Text dimColor>j/k move · enter select · esc cancel reject</Text>
    </Box>
  );
}
