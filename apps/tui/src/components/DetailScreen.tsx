import { useEffect, useRef, useState } from "react";
import { spawn } from "node:child_process";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import {
  API_BASE,
  approveClassification,
  fetchDetail,
  rejectClassification,
  type ClassificationDetail,
} from "../api.js";
import { CategoryPicker } from "./CategoryPicker.js";

export interface DetailScreenProps {
  id: string;
  /** Called after a successful approve/reject so the parent can advance. */
  onActed: (actedId: string) => void;
  /** n key — move to the next pending item without acting. Resolves false if none. */
  onNext: (currentId: string) => Promise<boolean>;
}

interface Status {
  text: string;
  isError: boolean;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "(unknown date)";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Pre-wrap text into at most maxRows fixed-width lines so the layout
 * height is known exactly — ink's own word wrapping can use more rows
 * than a character count predicts, which would push the screen past
 * the terminal height.
 */
function chunkText(text: string, width: number, maxRows: number): string[] {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return [""];
  const chunks: string[] = [];
  for (let i = 0; i < flat.length && chunks.length < maxRows; i += width) {
    chunks.push(flat.slice(i, i + width));
  }
  if (flat.length > width * maxRows) {
    const last = chunks[chunks.length - 1] ?? "";
    chunks[chunks.length - 1] = `${last.slice(0, Math.max(0, width - 1))}…`;
  }
  return chunks;
}

// Fixed row costs of everything around the body viewport, so the whole
// screen always fits the terminal and only the body scrolls inside its box.
const HEADER_ROWS = 5; // border 2 + subject/from/date
const RULE_ROWS = 5; // border 2 + title + category line + reasons line
const BODY_CHROME_ROWS = 3; // border 2 + title
const STATUS_ROWS = 1; // always reserved so the layout never shifts

function openWebView(id: string): void {
  const child = spawn("open", [`${API_BASE}/review/${id}`], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    // Swallow spawn failures; the status line already reported the attempt.
  });
  child.unref();
}

export function DetailScreen({ id, onActed, onNext }: DetailScreenProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [detail, setDetail] = useState<ClassificationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scroll, setScroll] = useState(0);
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

  const [, setResizeTick] = useState(0);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setResizeTick((t) => t + 1);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoadError(null);
    setScroll(0);
    setPickerOpen(false);
    fetchDetail(id)
      .then((res) => {
        if (!cancelled) setDetail(res.data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const bodyText = detail?.body?.text ?? "";
  const bodyLines = bodyText.length > 0 ? bodyText.split("\n") : ["(no text body)"];
  const rows = stdout?.rows ?? 24;
  const columns = stdout?.columns ?? 80;
  const usableWidth = Math.max(20, columns - 4); // border + paddingX

  const reasonChunks = chunkText(detail?.reason ?? "", usableWidth, 3);
  const classificationRows = 4 + reasonChunks.length; // border 2 + title + meta + reason
  const chromeRows =
    HEADER_ROWS +
    classificationRows +
    RULE_ROWS +
    BODY_CHROME_ROWS +
    1 + // help footer
    STATUS_ROWS;
  // rows - 1 leaves the cursor line free so ink never spills past the screen
  const viewportHeight = Math.max(3, rows - 1 - chromeRows);
  const maxScroll = Math.max(0, bodyLines.length - viewportHeight);
  const effectiveScroll = Math.min(scroll, maxScroll);

  const approve = async () => {
    setBusy(true);
    try {
      await approveClassification(id);
      flash("Approved");
      onActed(id);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const reject = async (correctedCategory: string | null) => {
    setPickerOpen(false);
    setBusy(true);
    try {
      await rejectClassification(id, correctedCategory ?? undefined);
      flash(correctedCategory ? `Rejected -> ${correctedCategory}` : "Rejected");
      onActed(id);
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err), true);
    } finally {
      setBusy(false);
    }
  };

  const next = async () => {
    setBusy(true);
    try {
      const moved = await onNext(id);
      if (!moved) flash("No more pending items");
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
      if (busy) return;

      if (input === "j" || key.downArrow) {
        setScroll((s) => Math.min(s + 1, maxScroll));
      } else if (input === "k" || key.upArrow) {
        setScroll((s) => Math.max(s - 1, 0));
      } else if (input === "a") {
        void approve();
      } else if (input === "r") {
        setPickerOpen(true);
      } else if (input === "n") {
        void next();
      } else if (input === "o") {
        openWebView(id);
        flash("Opened web view in browser");
      }
    },
    { isActive: !pickerOpen },
  );

  if (loadError) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">{loadError}</Text>
        <Text dimColor>n next · q quit</Text>
      </Box>
    );
  }

  if (!detail) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>Loading classification {id}…</Text>
      </Box>
    );
  }

  const { email, rule } = detail;
  const fromLine = email.fromName
    ? `${email.fromName} <${email.fromAddress ?? "?"}>`
    : (email.fromAddress ?? "(unknown sender)");
  const visibleBody = bodyLines.slice(
    effectiveScroll,
    effectiveScroll + viewportHeight,
  );

  return (
    <Box flexDirection="column" paddingX={1} height={rows - 1} overflow="hidden">
      <Box flexShrink={0} flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
        <Text bold wrap="truncate-end">
          {email.subject ?? "(no subject)"}
        </Text>
        <Text wrap="truncate-end">From: {fromLine}</Text>
        <Text wrap="truncate-end" dimColor>
          Date: {formatDate(email.date)}
        </Text>
      </Box>

      <Box flexShrink={0} flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
        <Text bold color="magenta">
          Classification
        </Text>
        <Text wrap="truncate-end">
          <Text color="cyan">{detail.category}</Text>
          {"  importance: "}
          {detail.importance}
          {"  urgency: "}
          {detail.urgency}
          {"  action: "}
          {detail.recommendedAction}
          {"  confidence: "}
          {detail.confidence}
        </Text>
        {reasonChunks.map((line, i) => (
          <Text key={i} wrap="truncate-end" dimColor>
            {line || " "}
          </Text>
        ))}
      </Box>

      {/* The picker takes the place of the rule + body boxes so the
          screen height never exceeds the terminal while it is open. */}
      {!pickerOpen && (
        <>
          <Box flexShrink={0} flexDirection="column" borderStyle="round" borderColor="green" paddingX={1}>
            <Text bold color="green">
              Rule engine
            </Text>
            {rule ? (
              <>
                <Text wrap="truncate-end">
                  {rule.category ?? "(none)"}
                  {"  confidence: "}
                  {rule.confidence ?? "(none)"}
                </Text>
                <Text wrap="truncate-end" dimColor>
                  {rule.reasons.length > 0 ? rule.reasons.join("; ") : "(no reasons)"}
                </Text>
              </>
            ) : (
              <Text dimColor>(no rule result)</Text>
            )}
          </Box>

          <Box flexGrow={1} flexShrink={1} flexDirection="column" borderStyle="round" paddingX={1} overflow="hidden">
            <Text bold>
              Body{" "}
              <Text dimColor>
                (lines {Math.min(effectiveScroll + 1, bodyLines.length)}-
                {Math.min(effectiveScroll + viewportHeight, bodyLines.length)} of{" "}
                {bodyLines.length})
              </Text>
            </Text>
            {visibleBody.map((line, i) => (
              <Text key={effectiveScroll + i} wrap="truncate-end">
                {line || " "}
              </Text>
            ))}
          </Box>
        </>
      )}

      {pickerOpen ? (
        <CategoryPicker onSelect={(category) => void reject(category)} onCancel={() => {
          setPickerOpen(false);
          flash("Reject cancelled");
        }} />
      ) : (
        <Text dimColor>
          a approve · r reject · n next · o open web · j/k scroll · q quit
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
