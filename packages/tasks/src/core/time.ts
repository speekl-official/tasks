import { TaskError } from "../errors.js";

/**
 * Timestamps in the tree are ISO 8601 UTC at second precision with a `Z`
 * suffix, kept as strings end to end: one spelling per instant, so files stay
 * diff-stable and strings of this shape compare correctly as text.
 */
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DURATION_PATTERN = /^(\d+)([mhdw])$/;

const MINUTE_MS = 60_000;

const UNIT_MS: Record<string, number> = {
  m: MINUTE_MS,
  h: 60 * MINUTE_MS,
  d: 24 * 60 * MINUTE_MS,
  w: 7 * 24 * 60 * MINUTE_MS,
};

/** The canonical spelling of an instant. */
export function formatIso(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export function nowIso(): string {
  return formatIso(new Date());
}

/**
 * True for the canonical form of a real instant; the round trip through
 * `Date` rejects calendar overflow such as February 30 or hour 24.
 */
export function isIsoTimestamp(value: string): boolean {
  if (!ISO_PATTERN.test(value)) return false;
  const time = Date.parse(value);
  return !Number.isNaN(time) && formatIso(new Date(time)) === value;
}

export function parseIso(value: string): Date {
  if (!isIsoTimestamp(value)) {
    throw TaskError.usage(
      `"${value}" is not an ISO 8601 UTC timestamp such as 2026-09-21T09:14:00Z.`,
      { value },
    );
  }
  return new Date(value);
}

/**
 * The lower bound of a `--since` argument (or of `flag`) as a canonical timestamp: an ISO
 * timestamp, a UTC date (`2026-09-21`, midnight), or a duration back from
 * `now` — `<n>m`, `<n>h`, `<n>d` or `<n>w`.
 */
export function parseSince(
  arg: string,
  now: Date = new Date(),
  flag = "--since",
): string {
  if (isIsoTimestamp(arg)) return arg;

  if (DATE_PATTERN.test(arg)) {
    const midnight = `${arg}T00:00:00Z`;
    if (isIsoTimestamp(midnight)) return midnight;
  }

  const duration = DURATION_PATTERN.exec(arg);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = UNIT_MS[duration[2]!]!;
    return formatIso(new Date(now.getTime() - amount * unit));
  }

  throw TaskError.usage(
    `Invalid ${flag} "${arg}": expected a timestamp such as 2026-09-21T09:14:00Z, a date such as 2026-09-21, or a duration such as 30m, 12h, 7d or 2w.`,
    flag === "--since" ? { since: arg } : { option: flag, value: arg },
  );
}

/** The canonical timestamp `days` days before `now`. */
export function daysBefore(days: number, now: Date = new Date()): string {
  return formatIso(new Date(now.getTime() - days * UNIT_MS["d"]!));
}

/** Fractional minutes elapsed since `date`; negative when it lies ahead. */
export function minutesSince(date: Date, now: Date = new Date()): number {
  return (now.getTime() - date.getTime()) / MINUTE_MS;
}

const DAY_MINUTES = 24 * 60;
const MONTH_DAYS = 30;
const YEAR_DAYS = 365;

/**
 * The time since a canonical timestamp as a compact age for a column: `now`
 * under a minute (an instant ahead of the clock too), then `5m`, `3h` (up to
 * two days), `2d` (up to two weeks), `5w` (up to eight), `4mo` (up to a
 * year), `1y`. Rounded down at every step, so an age never reads older than
 * it is, and an anniversary reads as the full year; a timestamp that is not
 * canonical is shown as it is.
 */
export function compactAge(timestamp: string, now: Date = new Date()): string {
  if (!isIsoTimestamp(timestamp)) return timestamp;
  const minutes = minutesSince(new Date(timestamp), now);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${Math.floor(hours)}h`;
  const days = minutes / DAY_MINUTES;
  if (days < 14) return `${Math.floor(days)}d`;
  if (days < 56) return `${Math.floor(days / 7)}w`;
  if (days < YEAR_DAYS) return `${Math.floor(days / MONTH_DAYS)}mo`;
  return `${Math.floor(days / YEAR_DAYS)}y`;
}
