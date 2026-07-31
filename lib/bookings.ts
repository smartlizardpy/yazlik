/**
 * Reads against `bookings` and `houses`.
 *
 * Every screen that asks "what is taken?" asks it here, and every screen that
 * needs the soft rules gets them from {@link houseRules}. That matters more than
 * it looks: `lib/availability` is only the authority on the rules if nothing
 * else gets to decide what `HouseRules` means. One mapping, one definition of
 * busy, no page inventing its own.
 *
 * Nothing in this file writes. Mutations live in `app/_actions/booking.ts`.
 */

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { bookings, houses, type Booking, type House } from "@/db/schema";
import type { BusyRange, HouseRules } from "@/lib/availability";

/* ============================================================
   RULES
   ============================================================ */

/**
 * The columns {@link houseRules} reads. A `Pick` rather than the whole row, so a
 * caller holding a partial house — a settings form previewing unsaved changes,
 * a test — can use it without inventing a `feedToken`.
 */
export type HouseRulesSource = Pick<
  House,
  "minNights" | "maxNights" | "gapDays" | "maxGuests" | "bookableFrom" | "bookableTo"
>;

/**
 * A house row narrowed to what `lib/availability` wants.
 *
 * The only interesting part is the season: the database stores an absent bound
 * as SQL NULL, which Drizzle hands back as `null`, and `HouseRules` reads `null`
 * as "unbounded". The `?? null` is there for the `undefined` a form object can
 * carry — a missing key and an explicitly empty one have to mean the same thing.
 */
export function houseRules(house: HouseRulesSource): HouseRules {
  return {
    minNights: house.minNights,
    maxNights: house.maxNights,
    gapDays: house.gapDays,
    maxGuests: house.maxGuests,
    bookableFrom: house.bookableFrom ?? null,
    bookableTo: house.bookableTo ?? null,
  };
}

/* ============================================================
   WHAT IS TAKEN
   ============================================================ */

/**
 * Every range that holds dates: confirmed bookings and owner blocks alike.
 *
 * `kind` is deliberately not filtered. A block is a booking with nobody in it —
 * that is the whole point of one table and one overlap rule, and a query that
 * remembered to exclude blocks would be the bug.
 *
 * Past stays are included. They cost nothing (`disabledDates` drops days before
 * today, `checkRequest` refuses the past outright) and leaving them in means the
 * answer does not depend on when it was asked.
 */
export async function busyRanges(houseId: string): Promise<BusyRange[]> {
  return db
    .select({ startDate: bookings.startDate, endDate: bookings.endDate })
    .from(bookings)
    .where(and(eq(bookings.houseId, houseId), eq(bookings.status, "confirmed")))
    .orderBy(asc(bookings.startDate));
}

/**
 * Requests nobody has answered yet.
 *
 * Kept apart from {@link busyRanges} on purpose. Pending dates are *not* busy —
 * two people may ask for the same week and the owner should see the clash — so
 * they never reach `checkRequest`. The calendar draws them as a dashed outline,
 * which reads as "someone asked first" without pretending the days are gone.
 */
export async function pendingRanges(houseId: string): Promise<BusyRange[]> {
  return db
    .select({ startDate: bookings.startDate, endDate: bookings.endDate })
    .from(bookings)
    .where(and(eq(bookings.houseId, houseId), eq(bookings.status, "pending")))
    .orderBy(asc(bookings.startDate));
}

/* ============================================================
   LOOKUPS
   ============================================================ */

/**
 * A house by its public slug, or null.
 *
 * No shape check on `slug` before the query: `scripts/seed.ts` writes readable
 * slugs like `demo-house`, and a guard built around `newSlug()`'s alphabet would
 * 404 the demo data. The column is unique and indexed, so a junk URL costs one
 * index probe.
 */
export async function houseBySlug(slug: string): Promise<House | null> {
  if (!slug) return null;
  const [house] = await db.select().from(houses).where(eq(houses.slug, slug)).limit(1);
  return house ?? null;
}

/** A booking and the house it belongs to — the two things `/b/[token]` renders. */
export type BookingWithHouse = { booking: Booking; house: House };

/**
 * A booking by the token in its private URL, with its house.
 *
 * The token is the guest's entire credential, so this is the one lookup that
 * stands in for authentication. It joins the house because every caller needs
 * it — for the language, the name, and the rules — and two round trips for one
 * page is a waste.
 */
export async function bookingByToken(token: string): Promise<BookingWithHouse | null> {
  if (!token) return null;
  const [row] = await db
    .select({ booking: bookings, house: houses })
    .from(bookings)
    .innerJoin(houses, eq(bookings.houseId, houses.id))
    .where(eq(bookings.token, token))
    .limit(1);
  return row ?? null;
}
