/**
 * The work that happens on a schedule rather than because somebody tapped
 * something.
 *
 * Three jobs, deliberately in one pass. They share nothing but a clock, and
 * splitting them into three cron entries would only mean three cold starts and
 * three chances to forget one.
 *
 * ### The rule they all obey
 *
 * **A scheduled job never throws.** Nobody is watching when this runs, and a
 * pass that dies on its first bad row leaves every later row untouched until
 * someone notices — which, for a reminder about a holiday that starts on
 * Friday, is on Saturday. Every job here catches per item, counts what it could
 * not do, and carries on. The result object is the only report there is, so it
 * says what happened rather than just that something did.
 */

import { and, eq, isNotNull } from "drizzle-orm";

import { db } from "@/db";
import { bookings, houses, type Booking, type House } from "@/db/schema";
import { addDaysStr, toStr } from "@/lib/dates";
import { sendArrivalReminder } from "@/lib/emails";
import { pullBlocks, retryFailedSyncs } from "@/lib/google/sync";

export type CronResult = {
  remindersSent: number;
  remindersFailed: number;
  syncsRetried: number;
  syncsCleared: number;
  housesPulled: number;
  blocksImported: number;
  errors: string[];
};

/**
 * How far ahead a reminder looks.
 *
 * Three days is early enough to still pack and late enough that the stay is
 * real. It is a constant rather than a setting because the owner has enough to
 * configure already, and nobody has ever wanted to tune this.
 */
const REMINDER_DAYS_AHEAD = 3;

/**
 * Guests arriving in exactly three days, reminded once.
 *
 * "Exactly" is what makes this safe to run more than once a day: the window is
 * a single day, so a second pass on the same day finds the same rows and would
 * mail them twice. That is the one thing this job cannot do, so the schedule in
 * `vercel.ts` runs it daily and this function does not defend against being
 * called twice — if that ever changes, a `reminded_at` column is the fix, not a
 * cleverer query.
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
      // sendArrivalReminder already swallows its own failures, so reaching here
      // means something stranger — but one guest's bad address must not cost
      // the next guest their reminder.
      result.remindersFailed++;
      result.errors.push(`reminder ${booking.id}: ${String(error)}`);
    }
  }
}

/**
 * Stays that never reached Google, tried again.
 *
 * `retryFailedSyncs` is total and groups by house so one token refresh covers a
 * whole batch; all this adds is the count and a place to record a surprise.
 */
async function retrySyncs(result: CronResult): Promise<void> {
  try {
    const retry = await retryFailedSyncs();
    result.syncsRetried = retry.retried ?? 0;
    result.syncsCleared = retry.cleared ?? 0;
  } catch (error) {
    result.errors.push(`retry: ${String(error)}`);
  }
}

/**
 * Weeks the owner promised in their own calendar, pulled in as blocks.
 *
 * Only houses that have actually chosen a calendar — an owner who never
 * connected Google is not a house with a problem, and asking about them would
 * be a query per pass for nothing.
 */
async function pullCalendars(result: CronResult): Promise<void> {
  const connected = await db
    .select()
    .from(houses)
    .where(isNotNull(houses.googleCalendarId));

  for (const house of connected) {
    try {
      const pulled = await pullBlocks(house);
      result.housesPulled++;
      result.blocksImported += pulled.imported ?? 0;
    } catch (error) {
      // pullBlocks is total too. Same reasoning as above: one house's dead
      // grant must not stop the next owner's calendar being read.
      result.errors.push(`pull ${house.id}: ${String(error)}`);
    }
  }
}

/**
 * One pass of everything scheduled. Never throws.
 *
 * `today` is an argument so a test does not have to move the clock, matching
 * `lib/availability` and `lib/google/sync`, which take theirs for the same
 * reason.
 */
export async function runScheduledWork(today = toStr(new Date())): Promise<CronResult> {
  const result: CronResult = {
    remindersSent: 0,
    remindersFailed: 0,
    syncsRetried: 0,
    syncsCleared: 0,
    housesPulled: 0,
    blocksImported: 0,
    errors: [],
  };

  try {
    await sendReminders(today, result);
  } catch (error) {
    result.errors.push(`reminders: ${String(error)}`);
  }

  await retrySyncs(result);
  await pullCalendars(result);

  return result;
}
