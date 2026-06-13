import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { fetchQueue, type QueueItem } from "../api.js";
import { ListScreen } from "./ListScreen.js";
import { DetailScreen } from "./DetailScreen.js";

type Mode =
  | { type: "list" }
  | { type: "detail"; id: string }
  | { type: "done" };

export interface AppProps {
  /** When set, jump straight to the detail screen for this classification id. */
  initialId?: string;
}

export function App({ initialId }: AppProps) {
  const [mode, setMode] = useState<Mode>(
    initialId ? { type: "detail", id: initialId } : { type: "list" },
  );
  const [items, setItems] = useState<QueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(!initialId);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const reviewedCount = useRef(0);

  const refresh = useCallback(async (): Promise<QueueItem[]> => {
    const res = await fetchQueue(1, 50);
    setItems(res.data);
    setTotal(res.pagination.total);
    return res.data;
  }, []);

  // Initial queue load when starting on the list screen.
  useEffect(() => {
    if (initialId) return;
    let cancelled = false;
    refresh()
      .catch((err: unknown) => {
        if (!cancelled) {
          setFatalError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [initialId, refresh]);

  /** After approve/reject: refetch the queue and advance to the next pending item. */
  const handleActed = useCallback(
    (actedId: string) => {
      reviewedCount.current += 1;
      void refresh()
        .then((fresh) => {
          const next = fresh.find((i) => i.classification.id !== actedId);
          if (next) {
            setMode({ type: "detail", id: next.classification.id });
          } else {
            setMode({ type: "done" });
          }
        })
        .catch((err: unknown) => {
          setFatalError(err instanceof Error ? err.message : String(err));
        });
    },
    [refresh],
  );

  /** n key — next pending without acting. Returns false when there is nothing further. */
  const handleNext = useCallback(
    async (currentId: string): Promise<boolean> => {
      const idx = items.findIndex((i) => i.classification.id === currentId);
      if (idx >= 0 && idx + 1 < items.length) {
        const nextItem = items[idx + 1];
        setMode({ type: "detail", id: nextItem.classification.id });
        return true;
      }
      // Launched with an explicit id (or stale cache): fetch the list for the next item.
      const fresh = await refresh();
      const next = fresh.find((i) => i.classification.id !== currentId);
      if (next) {
        setMode({ type: "detail", id: next.classification.id });
        return true;
      }
      return false;
    },
    [items, refresh],
  );

  if (fatalError) {
    return <ErrorScreen message={fatalError} />;
  }

  if (mode.type === "done") {
    return <DoneScreen reviewed={reviewedCount.current} />;
  }

  if (mode.type === "detail") {
    return <DetailScreen id={mode.id} onActed={handleActed} onNext={handleNext} />;
  }

  return (
    <ListScreen
      items={items}
      total={total}
      loading={loading}
      onSelect={(id) => setMode({ type: "detail", id })}
    />
  );
}

function ErrorScreen({ message }: { message: string }) {
  const { exit } = useApp();
  useEffect(() => {
    process.exitCode = 1;
  }, []);
  useInput((input) => {
    if (input === "q") exit();
  });
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red">{message}</Text>
      <Text dimColor>q quit</Text>
    </Box>
  );
}

function DoneScreen({ reviewed }: { reviewed: number }) {
  const { exit } = useApp();
  useInput((input) => {
    if (input === "q") exit();
  });
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="green">
        All done — no more items pending review.
      </Text>
      <Text>
        {reviewed} item{reviewed === 1 ? "" : "s"} reviewed this session.
      </Text>
      <Text dimColor>q quit</Text>
    </Box>
  );
}
