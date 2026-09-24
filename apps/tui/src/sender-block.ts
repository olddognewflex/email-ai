/**
 * Pure helpers for blocking senders from the list/detail screens: the
 * EAI_BLOCK_ON_UNSUBSCRIBE toggle, the `u` auto-block flow (API calls
 * injected), and the flash/prompt text. No React, no direct I/O.
 */
import type {
  CreateSenderRuleInput,
  SenderRule,
  SenderRuleMatchResult,
  SenderRuleWriteResult,
} from "./api.js";

/** Short form for the one-line flash after creating a trash rule. */
export const TRASH_PENDING_FLASH = "will move to Trash once mailbox writes are enabled";

export const UNSUBSCRIBE_OPENED = "Opened unsubscribe link";

const OFF_VALUES = new Set(["0", "false", "no", "off"]);

/**
 * Whether `u` also blocks the sender's address. On unless
 * EAI_BLOCK_ON_UNSUBSCRIBE is 0/false/no/off (case-insensitive, trimmed).
 */
export function blockOnUnsubscribeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.EAI_BLOCK_ON_UNSUBSCRIBE;
  if (raw === undefined) return true;
  return !OFF_VALUES.has(raw.trim().toLowerCase());
}

/** A sender domain worth matching on, or null ("unknown", no dot, empty). */
export function usableSenderDomain(domain: string | null | undefined): string | null {
  const d = domain?.trim().toLowerCase();
  return d && d !== "unknown" && d.includes(".") ? d : null;
}

export function normalizeAddress(address: string | null | undefined): string | null {
  return address?.trim().toLowerCase() || null;
}

/** `Already covered by domain "x.com"` (capitalised) or lower-case for joins. */
export function coveredText(
  rule: Pick<SenderRule, "matchType" | "pattern">,
  capitalise = false,
): string {
  const text = `already covered by ${rule.matchType} "${rule.pattern}"`;
  return capitalise ? `A${text.slice(1)}` : text;
}

export function undoPromptText(pattern: string): string {
  return `Remove rule ${pattern}? y/n`;
}

/** The rule this TUI session created most recently (for `z`). */
export interface RecentRule {
  id: string;
  pattern: string;
  matchType: string;
}

export function toRecentRule(rule: SenderRule): RecentRule {
  return { id: rule.id, pattern: rule.pattern, matchType: rule.matchType };
}

export type FlashTone = "ok" | "info" | "error";

export interface BlockOutcome {
  message: string;
  tone: FlashTone;
  /** Set only when a rule was created. */
  rule?: SenderRule;
}

export interface BlockDeps {
  matchSenderRule: (sender: {
    address?: string | null;
    domain?: string | null;
  }) => Promise<SenderRuleMatchResult>;
  createRule: (input: CreateSenderRuleInput) => Promise<SenderRuleWriteResult>;
  /** HTTP status of an API error, if any (409 = duplicate). */
  statusOf: (err: unknown) => number | undefined;
  errorMessage: (err: unknown) => string;
}

/**
 * The block step of `u`, run only after the unsubscribe link opened.
 * Blocks the exact ADDRESS (never the domain): skipped when no address,
 * or when an enabled rule already covers the sender. Any API failure
 * (including an API too old to have /sender-rules/match) creates nothing.
 */
export async function blockAfterUnsubscribe(
  sender: {
    fromAddress: string | null | undefined;
    senderDomain: string | null | undefined;
    classificationId: string;
  },
  deps: BlockDeps,
): Promise<BlockOutcome> {
  const address = normalizeAddress(sender.fromAddress);
  if (!address) {
    return {
      message: `${UNSUBSCRIBE_OPENED} · no sender address, nothing blocked`,
      tone: "info",
    };
  }

  let covering: SenderRule | null;
  try {
    const res = await deps.matchSenderRule({
      address,
      domain: usableSenderDomain(sender.senderDomain),
    });
    covering = res.rule;
  } catch (err) {
    return {
      message: `${UNSUBSCRIBE_OPENED} · block failed: ${deps.errorMessage(err)}`,
      tone: "error",
    };
  }
  if (covering) {
    return {
      message: `${UNSUBSCRIBE_OPENED} · ${coveredText(covering)}`,
      tone: "info",
    };
  }

  try {
    const res = await deps.createRule({
      pattern: address,
      matchType: "address",
      action: "trash",
      category: "delete",
      enabled: true,
      note: `tui:unsubscribe ${sender.classificationId}`,
      source: "tui",
    });
    return {
      message: [
        `${UNSUBSCRIBE_OPENED} · blocked ${res.rule.pattern} (${TRASH_PENDING_FLASH})`,
        ...res.warnings,
      ].join(" · "),
      tone: "ok",
      rule: res.rule,
    };
  } catch (err) {
    if (deps.statusOf(err) === 409) {
      // A disabled rule with the same pattern (match ignores disabled rules).
      return {
        message: `${UNSUBSCRIBE_OPENED} · a rule for ${address} already exists (see R)`,
        tone: "info",
      };
    }
    return {
      message: `${UNSUBSCRIBE_OPENED} · block failed: ${deps.errorMessage(err)}`,
      tone: "error",
    };
  }
}

/** Result text for `z` once DELETE /sender-rules/:id settles. */
export function undoOutcome(
  rule: RecentRule,
  failure: { err: unknown } | null,
  deps: Pick<BlockDeps, "statusOf" | "errorMessage">,
): { message: string; tone: FlashTone; forget: boolean } {
  if (!failure) {
    return { message: `Removed rule ${rule.pattern}`, tone: "ok", forget: true };
  }
  const { err } = failure;
  if (deps.statusOf(err) === 404) {
    return {
      message: `Rule ${rule.pattern} was already removed`,
      tone: "info",
      forget: true,
    };
  }
  return {
    message: `Undo failed: ${deps.errorMessage(err)}`,
    tone: "error",
    forget: false,
  };
}
