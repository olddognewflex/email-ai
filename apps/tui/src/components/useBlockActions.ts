import { useRef, useState } from "react";
import {
  ApiError,
  createRule,
  deleteRule,
  errorMessage,
  matchSenderRule,
  type SenderRule,
} from "../api.js";
import { isHttpUrl, openExternal, openExternalChecked } from "../open-external.js";
import {
  UNSUBSCRIBE_OPENED,
  blockAfterUnsubscribe,
  blockOnUnsubscribeEnabled,
  toRecentRule,
  undoOutcome,
  undoPromptText,
  type BlockDeps,
  type FlashTone,
  type RecentRule,
} from "../sender-block.js";

/** Props the list and detail screens take for session-level undo. */
export interface UndoBlockProps {
  /** Most recent rule created in this TUI session (x or u), for `z`. */
  recentRule: RecentRule | null;
  onRuleCreated: (rule: RecentRule) => void;
  onRuleUndone: () => void;
}

const deps: BlockDeps = {
  matchSenderRule,
  createRule,
  statusOf: (err) => (err instanceof ApiError ? err.status : undefined),
  errorMessage,
};

interface Options extends UndoBlockProps {
  flash: (text: string, tone: FlashTone) => void;
  setBusy: (busy: boolean) => void;
}

/**
 * `u` (open unsubscribe link, then auto-block the sender address) and `z`
 * (y/n, then delete the rule this session created last), shared by the
 * list and detail screens. A ref guards against double-firing while a
 * request is in flight.
 */
export function useBlockActions({
  recentRule,
  onRuleCreated,
  onRuleUndone,
  flash,
  setBusy,
}: Options) {
  const busyRef = useRef(false);
  const [undoConfirm, setUndoConfirm] = useState<RecentRule | null>(null);

  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** Created by the x picker: remember it for `z`. */
  const rememberRule = (rule: SenderRule | undefined) => {
    if (rule) onRuleCreated(toRecentRule(rule));
  };

  const unsubscribe = (email: {
    unsubscribeLink: string | null | undefined;
    fromAddress: string | null | undefined;
    senderDomain: string | null | undefined;
    classificationId: string;
  }) => {
    if (busyRef.current) return;
    const link = email.unsubscribeLink;
    if (!link || !isHttpUrl(link)) {
      flash("No unsubscribe link for this email", "error");
      return;
    }
    if (!blockOnUnsubscribeEnabled()) {
      // Auto-block off: exactly the old behaviour.
      openExternal(link);
      flash("Opened unsubscribe link in browser", "ok");
      return;
    }
    void run(async () => {
      try {
        await openExternalChecked(link);
      } catch (err) {
        flash(`Could not open unsubscribe link: ${errorMessage(err)}`, "error");
        return;
      }
      flash(`${UNSUBSCRIBE_OPENED} · blocking sender…`, "info");
      const outcome = await blockAfterUnsubscribe(email, deps);
      if (outcome.rule) onRuleCreated(toRecentRule(outcome.rule));
      flash(outcome.message, outcome.tone);
    });
  };

  /** z: ask before undoing, or say there is nothing to undo. */
  const requestUndo = () => {
    if (busyRef.current) return;
    if (!recentRule) {
      flash("Nothing to undo", "info");
      return;
    }
    setUndoConfirm(recentRule);
  };

  /**
   * Keys while the undo prompt is open. Returns true when the key was
   * consumed (the prompt swallows every key until y, n or esc).
   */
  const handleUndoKey = (input: string, key: { escape: boolean }): boolean => {
    if (!undoConfirm) return false;
    const rule = undoConfirm;
    if (input === "y") {
      setUndoConfirm(null);
      void run(async () => {
        let failure: { err: unknown } | null = null;
        try {
          await deleteRule(rule.id);
        } catch (err) {
          failure = { err };
        }
        const outcome = undoOutcome(rule, failure, deps);
        if (outcome.forget) onRuleUndone();
        flash(outcome.message, outcome.tone);
      });
    } else if (input === "n" || key.escape) {
      setUndoConfirm(null);
      flash("Undo cancelled", "info");
    }
    return true;
  };

  return {
    unsubscribe,
    requestUndo,
    handleUndoKey,
    rememberRule,
    /** Prompt text while the undo confirm is open, else null. */
    undoPrompt: undoConfirm ? undoPromptText(undoConfirm.pattern) : null,
    busyRef,
  };
}
