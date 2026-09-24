/**
 * Pure helpers for MailboxActionsScreen: status colours and labels, the
 * `f` filter cycle, and undo eligibility. No React, no I/O.
 */
import type { MailboxAction, MailboxActionStatus } from "./api.js";

/** `f` cycles through these; undefined = all statuses. */
export const STATUS_FILTERS: readonly (MailboxActionStatus | undefined)[] = [
  undefined,
  "succeeded",
  "unknown",
  "pending",
  "failed",
  "skipped",
  "undone",
];

export function nextStatusFilter(
  current: MailboxActionStatus | undefined,
): MailboxActionStatus | undefined {
  const i = STATUS_FILTERS.indexOf(current);
  return STATUS_FILTERS[(i + 1) % STATUS_FILTERS.length];
}

export function filterLabel(filter: MailboxActionStatus | undefined): string {
  return filter ?? "all";
}

/** Ink colour per status: attention states (unknown/pending/failed) stand out. */
export function statusColor(status: MailboxActionStatus): string {
  switch (status) {
    case "succeeded":
      return "green";
    case "undone":
      return "cyan";
    case "failed":
      return "red";
    case "unknown":
      return "magenta";
    case "pending":
      return "yellow";
    case "skipped":
      return "gray";
  }
}

export function actionLabel(action: MailboxAction["action"]): string {
  return action === "move_to_trash" ? "→ Trash" : "← INBOX";
}

/**
 * Why `u` cannot undo this row, or null when it can. Mirrors the API's own
 * 409 rule (only a succeeded move_to_trash); the API still decides.
 */
export function undoBlockedReason(item: MailboxAction): string | null {
  if (item.action !== "move_to_trash") {
    return "Only a move to Trash can be undone (this is a restore)";
  }
  if (item.status === "undone") return "Already undone";
  if (item.status !== "succeeded") {
    return `Only a succeeded move can be undone (this one is ${item.status})`;
  }
  return null;
}

/** Local "MM-DD HH:MM". */
export function shortTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
