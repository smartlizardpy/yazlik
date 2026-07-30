/**
 * Date helpers over plain `YYYY-MM-DD` strings.
 *
 * The whole app stores stays as two `date` columns and never a timestamp, so
 * there is no timezone maths anywhere. A stay is a half-open interval
 * `[startDate, endDate)`: the guest sleeps on `startDate`, leaves on `endDate`,
 * and `endDate` itself is free for the next arrival (a same-day changeover).
 *
 * Everything in here is pure and total: no `new Date()`, no locale, no clock.
 */

import { addDays, differenceInCalendarDays, format, isValid, parseISO } from "date-fns";

/** A calendar day in `YYYY-MM-DD` form. */
export type DateStr = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True when `s` is a real calendar day written as `YYYY-MM-DD`. */
export function isDateStr(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = parseISO(s);
  return isValid(d) && format(d, "yyyy-MM-dd") === s;
}

/**
 * Parse `YYYY-MM-DD` into a local-midnight `Date`.
 * Throws on anything that is not a real day, so a bad value fails at the edge
 * rather than silently becoming `Invalid Date` three functions later.
 */
export function toDate(s: DateStr): Date {
  if (!isDateStr(s)) throw new TypeError(`Not a YYYY-MM-DD date: ${JSON.stringify(s)}`);
  return parseISO(s);
}

/** Format a `Date` back to `YYYY-MM-DD`. */
export function toStr(d: Date): DateStr {
  if (!isValid(d)) throw new TypeError("Not a valid Date");
  return format(d, "yyyy-MM-dd");
}

/** `n` days after `s` (negative `n` moves backwards). */
export function addDaysStr(s: DateStr, n: number): DateStr {
  return toStr(addDays(toDate(s), n));
}

/** Negative when `a` is earlier, `0` when equal, positive when later. */
export function compareDates(a: DateStr, b: DateStr): number {
  return differenceInCalendarDays(toDate(a), toDate(b));
}

/** Number of nights in `[start, end)`. Zero for a same day, negative if reversed. */
export function nightsBetween(start: DateStr, end: DateStr): number {
  return differenceInCalendarDays(toDate(end), toDate(start));
}

/**
 * Every day in the half-open range `[start, end)` — the nights that are slept,
 * excluding the checkout day. Empty when `end <= start`.
 */
export function eachDayInRange(start: DateStr, end: DateStr): DateStr[] {
  const nights = nightsBetween(start, end);
  if (nights <= 0) return [];
  const days: DateStr[] = [];
  let cursor = toDate(start);
  for (let i = 0; i < nights; i++) {
    days.push(toStr(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

/**
 * Do two stays collide? Half-open, so a stay ending on the 10th and one
 * starting on the 10th do **not** overlap — that is a same-day changeover.
 * Empty or reversed ranges never overlap.
 */
export function rangesOverlap(
  aStart: DateStr,
  aEnd: DateStr,
  bStart: DateStr,
  bEnd: DateStr,
): boolean {
  if (nightsBetween(aStart, aEnd) <= 0) return false;
  if (nightsBetween(bStart, bEnd) <= 0) return false;
  return compareDates(aStart, bEnd) < 0 && compareDates(bStart, aEnd) < 0;
}

/** Human-facing day, e.g. `1 June 2026`. Used in guest-facing rule messages. */
export function formatDay(s: DateStr): string {
  return format(toDate(s), "d MMMM yyyy");
}
