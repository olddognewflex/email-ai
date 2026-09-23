import { BadRequestException } from "@nestjs/common";

/**
 * Default received-date window for the review queue and actionable
 * lists. Old mail stays out of both views unless the caller widens the
 * window (?days=N / ?since=YYYY-MM-DD) or disables it (?all=true).
 */
export const DEFAULT_REVIEW_WINDOW_DAYS = 14;

/**
 * Effective received-date window. `since` is the inclusive local-midnight
 * cutoff (null = no filter); `days` is set only when the window came from
 * a day count (default or ?days=N), null for an explicit ?since or ?all.
 */
export interface ReviewWindow {
  since: Date | null;
  days: number | null;
}

export interface ReviewWindowQuery {
  days?: string;
  since?: string;
  all?: string;
}

/** Local midnight `days` calendar days before `now`. */
export function windowStartForDays(days: number, now: Date = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);
  return start;
}

/** The window applied when the caller passes no window params. */
export function defaultReviewWindow(now: Date = new Date()): ReviewWindow {
  return {
    since: windowStartForDays(DEFAULT_REVIEW_WINDOW_DAYS, now),
    days: DEFAULT_REVIEW_WINDOW_DAYS,
  };
}

/**
 * Parse YYYY-MM-DD as a LOCAL date (new Date("YYYY-MM-DD") parses as
 * UTC midnight and shifts the cutoff by a day behind UTC). Rejects
 * malformed and out-of-range dates such as 2026-02-31.
 */
function parseLocalDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : null;
  if (
    !match ||
    !date ||
    isNaN(date.getTime()) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    throw new BadRequestException(
      `Invalid since date: ${value} (expected YYYY-MM-DD)`,
    );
  }
  return date;
}

/**
 * Resolve ?all / ?since / ?days into an effective window.
 * Precedence: all > since > days > default. Invalid values → 400.
 */
export function resolveReviewWindow(
  query: ReviewWindowQuery,
  now: Date = new Date(),
): ReviewWindow {
  if (query.all === "true") {
    return { since: null, days: null };
  }
  if (query.since !== undefined && query.since !== "") {
    return { since: parseLocalDate(query.since), days: null };
  }
  if (query.days !== undefined && query.days !== "") {
    if (!/^\d+$/.test(query.days) || Number(query.days) < 1) {
      throw new BadRequestException(
        `Invalid days: ${query.days} (expected a positive integer)`,
      );
    }
    const days = Number(query.days);
    const since = windowStartForDays(days, now);
    if (isNaN(since.getTime())) {
      throw new BadRequestException(`Invalid days: ${query.days} (too large)`);
    }
    return { since, days };
  }
  return defaultReviewWindow(now);
}

/** Local YYYY-MM-DD for display (the form ?since= accepts). */
export function formatLocalDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
