/**
 * The *soft* booking rules.
 *
 * Double-booking is prevented by the database (a gist exclusion constraint on
 * confirmed bookings). Everything in this file is policy, not integrity: min
 * and max nights, the gap between stays, headcount, the bookable window, and a
 * friendly overlap check so a guest is told before they submit rather than
 * after the owner tries to approve.
 *
 * Checked twice — at request time and again at approval time — so the answer
 * has to be deterministic. `today` is always an argument; this module never
 * reads the clock.
 */

import {
  addDaysStr,
  compareDates,
  eachDayInRange,
  formatDay,
  nightsBetween,
  rangesOverlap,
  type DateStr,
} from "@/lib/dates";

export type HouseRules = {
  minNights: number;
  maxNights: number;
  /** Days that must sit empty either side of a stay. `0` allows same-day changeover. */
  gapDays: number;
  maxGuests: number;
  /** First day of the season. `null` means no lower bound. */
  bookableFrom: DateStr | null;
  /**
   * Last day of the season. `null` means no upper bound. A stay must *check out*
   * on or before this day, so the last night sleepable is `bookableTo - 1`.
   */
  bookableTo: DateStr | null;
};

/** A stay that already holds the dates: a confirmed booking or an owner block. */
export type BusyRange = {
  startDate: DateStr;
  endDate: DateStr;
};

export type BookingRequest = {
  startDate: DateStr;
  endDate: DateStr;
  guests: number;
};

export type CheckFailureCode =
  | "END_BEFORE_START"
  | "PAST"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "INVALID_GUESTS"
  | "TOO_MANY_GUESTS"
  | "OUTSIDE_WINDOW"
  | "OVERLAP"
  | "GAP";

export type CheckResult =
  | { ok: true }
  | { ok: false; reason: string; code: CheckFailureCode };

const fail = (code: CheckFailureCode, reason: string): CheckResult => ({
  ok: false,
  code,
  reason,
});

function nights(n: number): string {
  return n === 1 ? "1 night" : `${n} nights`;
}

function guestWord(n: number): string {
  return n === 1 ? "1 guest" : `${n} guests`;
}

function days(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/**
 * The dates a calendar may offer, given the season and the day it is rendered.
 * `max` is `null` when the owner set no end to the season.
 */
export function bookableWindow(
  rules: HouseRules,
  today: DateStr,
): { min: DateStr; max: DateStr | null } {
  const min =
    rules.bookableFrom && compareDates(rules.bookableFrom, today) > 0
      ? rules.bookableFrom
      : today;
  return { min, max: rules.bookableTo ?? null };
}

/**
 * Validate a request against the house rules and the dates already taken.
 * Returns the first rule broken, with a reason written for the guest.
 *
 * Checks run cheapest and most fundamental first, so a request that is both in
 * the past and too short is reported as `PAST` — fix the impossible thing before
 * quibbling about length.
 */
export function checkRequest(
  rules: HouseRules,
  busy: BusyRange[],
  req: BookingRequest,
  today: DateStr,
): CheckResult {
  const total = nightsBetween(req.startDate, req.endDate);

  if (total <= 0) {
    return fail(
      "END_BEFORE_START",
      "Check-out has to be at least one night after check-in. Pick a later date to leave.",
    );
  }

  if (compareDates(req.startDate, today) < 0) {
    return fail(
      "PAST",
      `Check-in on ${formatDay(req.startDate)} has already passed. Pick an arrival date from today onwards.`,
    );
  }

  if (total < rules.minNights) {
    return fail(
      "TOO_SHORT",
      `Stays here are ${nights(rules.minNights)} or more. Move your checkout later so the stay covers at least ${nights(rules.minNights)}.`,
    );
  }

  if (total > rules.maxNights) {
    return fail(
      "TOO_LONG",
      `Stays here are up to ${nights(rules.maxNights)}. Shorten your dates to ${nights(rules.maxNights)} or fewer.`,
    );
  }

  if (!Number.isInteger(req.guests) || req.guests < 1) {
    return fail("INVALID_GUESTS", "Enter how many people are coming — at least one.");
  }

  if (req.guests > rules.maxGuests) {
    return fail(
      "TOO_MANY_GUESTS",
      `The house sleeps ${guestWord(rules.maxGuests)}. Lower the number of guests to ${rules.maxGuests} or fewer.`,
    );
  }

  const { bookableFrom, bookableTo } = rules;
  const beforeSeason = bookableFrom != null && compareDates(req.startDate, bookableFrom) < 0;
  const afterSeason = bookableTo != null && compareDates(req.endDate, bookableTo) > 0;
  if (beforeSeason || afterSeason) {
    return fail("OUTSIDE_WINDOW", seasonReason(bookableFrom, bookableTo));
  }

  for (const b of busy) {
    if (rangesOverlap(req.startDate, req.endDate, b.startDate, b.endDate)) {
      return fail(
        "OVERLAP",
        "Those dates are already taken. Pick another range — the calendar greys out the days that have gone.",
      );
    }
  }

  if (rules.gapDays > 0) {
    for (const b of busy) {
      const paddedStart = addDaysStr(b.startDate, -rules.gapDays);
      const paddedEnd = addDaysStr(b.endDate, rules.gapDays);
      if (rangesOverlap(req.startDate, req.endDate, paddedStart, paddedEnd)) {
        return fail(
          "GAP",
          `The house needs ${days(rules.gapDays)} clear between stays. Shift your dates a little further from the booking next to them.`,
        );
      }
    }
  }

  return { ok: true };
}

function seasonReason(from: DateStr | null, to: DateStr | null): string {
  if (from && to) {
    return `The house takes bookings between ${formatDay(from)} and ${formatDay(to)}. Pick dates inside that window.`;
  }
  if (from) {
    return `The house takes bookings from ${formatDay(from)} onwards. Pick a later arrival date.`;
  }
  return `The house takes bookings up to ${formatDay(to as DateStr)}. Pick an earlier checkout date.`;
}

/**
 * The days a calendar should grey out: every night already held, padded by
 * `gapDays` on both sides, with anything before `today` dropped.
 *
 * A checkout day is *not* included — it is free for the next arrival when
 * `gapDays` is 0. Days outside the season are not enumerated here (the range is
 * unbounded); clamp the calendar with {@link bookableWindow} instead.
 */
export function disabledDates(
  rules: HouseRules,
  busy: BusyRange[],
  today: DateStr,
): Set<DateStr> {
  const out = new Set<DateStr>();
  const gap = Math.max(0, rules.gapDays);
  for (const b of busy) {
    if (nightsBetween(b.startDate, b.endDate) <= 0) continue;
    const from = addDaysStr(b.startDate, -gap);
    const to = addDaysStr(b.endDate, gap);
    for (const day of eachDayInRange(from, to)) {
      if (compareDates(day, today) < 0) continue;
      out.add(day);
    }
  }
  return out;
}
