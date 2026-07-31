/**
 * The work that happens on a schedule rather than because somebody tapped
 * something.
 *
 * One job now: arrival reminders. A Google Calendar sync used to run here too,
 * retrying stays that never reached Google and pulling all-day events back in
 * as blocks. It is gone — the subscribe feed at `/api/feed/[feedToken].ics`
 * gives an owner the same thing they wanted, in whatever calendar they already
 * keep, with no OAuth client to register, no scopes to widen and no tokens to
 * expire.
 *
 * ### The rule this obeys
 *
 * **A scheduled job never throws.** Nobody is watching when this runs, and a
 * pass that dies on its first bad row leaves every later row untouched until
 * someone notices — which, for a reminder about a holiday that starts on
 * Friday, is Saturday. It catches per guest, counts what it could not do, and
 * carries on. The result object is the only report there is, so it says what
 * happened rather than just that something did.
 */

import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { bookings, houses, type Booking, type House } from "@/db/schema";
import { addDaysStr, toStr } from "@/lib/dates";
import { sendArrivalReminder } from "@/lib/emails";

export type CronResult = {
  remindersSent: number;
  remindersFailed: number;
  errors: string[];
};

/**
 * How far ahead a reminder looks.
 *
 * Three days is early enough to still pack and late enough that the stay is
 * real. A constant rather than a setting: the owner has enough to configure
 * already, and nobody has ever wanted to tune this.
 */
const REMINDER_DAYS_AHEAD = 3;

/**
 * Guests arriving in exactly three days, reminded once.
 *
 * "Exactly" is what makes the daily schedule safe: the window is a single day,
 * so a second pass on the same day would find the same rows and mail the same
 * guest twice. That is the one thing this cannot do, which is why `vercel.ts`
 * runs it once a day. If that ever changes, the fix is a `reminded_at` column,
 * not a cleverer query.
 */
async function sendReminders(today: string, result: CronResult): Promise<void> {
  const target = addDaysStr(today, REMINDER_DAYS_AHEAD);

  const rows = await db
    .select({ booking: bookings, house: houses })
    .from(bookings)
    .innerJoin(houses, eq(bookings.houseId, houses.id))
    .where(
      and(
        eq(bookings.status, "confirmed"),
        eq(bookings.kind, "guest"),
        eq(bookings.startDate, target),
      ),
    );

  for (const { booking, house } of rows) {
    if (!booking.guestEmail) continue;
    try {
      await sendArrivalReminder(house as House, booking as Booking);
      result.remindersSent++;
    } catch (error) {
      // sendArrivalReminder swallows its own failures, so reaching here means
      // something stranger — but one guest's bad address must not cost the
      // next guest their reminder.
      result.remindersFailed++;
      result.errors.push(`reminder ${booking.id}: ${String(error)}`);
    }
  }
}

/**
 * One pass of everything scheduled. Never throws.
 *
 * `today` is an argument so a test does not have to move the clock, matching
 * `lib/availability`, which takes its for the same reason.
 */
export async function runScheduledWork(
  today = toStr(new Date()),
): Promise<CronResult> {
  const result: CronResult = {
    remindersSent: 0,
    remindersFailed: 0,
    errors: [],
  };

  try {
    await sendReminders(today, result);
  } catch (error) {
    result.errors.push(`reminders: ${String(error)}`);
  }

  return result;
}
