"use server";

/**
 * The four things an owner can do to a set of dates.
 *
 * Approve and decline answer a guest's request. Block and unblock are the owner
 * holding dates for themselves — same table, same overlap rule, no second code
 * path. Every one of them is owner-only: the session says who you are, and the
 * row is fetched joined to `houses` on `ownerId`, so there is no id a caller
 * could swap to reach someone else's booking.
 *
 * ### The rule that matters
 *
 * Two pending requests on the same week is a *correct* state. The owner should
 * see the clash and choose, so nothing stops the second request from existing.
 * What stops it from being confirmed is the database:
 *
 * ```sql
 * ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
 *   EXCLUDE USING gist (house_id WITH =, daterange(start_date, end_date, '[)') WITH &&)
 *   WHERE (status = 'confirmed');
 * ```
 *
 * So `approveBooking` does **not** look for a clash before it writes. Checking
 * and then writing is two statements with a gap in the middle, and that gap is
 * the entire reason the constraint exists. The write goes in, Postgres refuses
 * it with SQLSTATE `23P01`, and this file turns that refusal into one sentence.
 * The same is true of `blockDates`, which competes for dates on exactly the same
 * terms.
 *
 * Reading the code off the error needs one piece of care: Drizzle wraps every
 * driver error in a `DrizzleQueryError` and hangs the original off `cause`, so
 * `error.code` is `undefined` at the top level. {@link hasPgCode} walks the
 * chain. It never matches on the message text — messages are localised by the
 * server's `lc_messages` and rewritten between Postgres versions.
 *
 * ### Soft rules are not re-checked here
 *
 * `lib/availability.ts` refuses a *request* that breaks min nights, max nights,
 * the gap, the headcount, or the season. It is not consulted again on approval,
 * and that is deliberate: approving **is** the owner exercising judgement, and
 * the only way a soft rule can turn against a request while it waits is a
 * neighbouring booking — which is the clash the plan says the owner should see
 * and choose about. Vetoing their choice with their own policy would push them
 * to loosen the policy for every future guest to get one booking through.
 * Integrity stays with the database; policy stays with the person.
 *
 * ### Mail never decides anything, and neither does Google
 *
 * The row is committed before a single email is composed. A dead mail provider
 * costs a notification, never an approval.
 *
 * The Google Calendar sync sits in exactly the same place and under exactly the
 * same rule, one step further out: it runs **after** the commit and after the
 * mail, it is awaited only so the row's `googleSync` is settled before the
 * screen re-reads it, and `lib/google/sync.ts` promises never to throw. A house
 * with no calendar connected — which is every house today — costs one `if` and
 * zero Google calls. See the module note there for what each failure does.
 *
 * Everything an owner reads here is English — the dashboard is English in v1,
 * and its errors should match it. Guest-facing copy lives in `lib/emails.ts`.
 */

import { revalidatePath } from "next/cache";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { bookings, houses, type Booking, type House } from "@/db/schema";
import { isDateStr, nightsBetween } from "@/lib/dates";
import { sendBookingConfirmed, sendBookingDeclined } from "@/lib/emails";
import { syncBooking, syncRemovedBooking } from "@/lib/google/sync";
import { newToken } from "@/lib/ids";
import { getOwnerHouse, requireOwner } from "@/lib/session";

/* ============================================================
   RESULT SHAPE
   ============================================================ */

/**
 * What every action here returns — the shape `app/_actions/house.ts` and
 * `app/_actions/booking.ts` already use. `field` names the input to attach the
 * message to; without it the message belongs to the control as a whole.
 */
export type DecisionResult =
  | { ok: true }
  | { ok: false; error: string; field?: string };

/* ============================================================
   COPY
   ============================================================ */

/**
 * The sentence the whole phase is built around. Two owners, two tabs, or one
 * owner and a fast thumb: whoever loses the race reads this instead of a 500.
 */
const DATES_TAKEN = "Those dates were taken while you were deciding.";

/** The same collision, but nobody was deciding — the owner is claiming dates. */
const BLOCK_TAKEN =
  "Those dates are already taken. Pick dates the calendar shows as free.";

/** A booking id that is not a uuid, or is not on this owner's house. */
const NOT_YOURS = "That request is not one of yours.";

/** The row moved between the read and the write. One reload puts it right. */
const ALREADY_DECIDED = "That request was already decided.";

/* ============================================================
   POSTGRES ERRORS
   ============================================================ */

/** `exclusion_violation` — here, only ever `bookings_no_overlap`. */
const EXCLUSION_VIOLATION = "23P01";

/** `unique_violation` — here, only ever two booking tokens drawing the same. */
const UNIQUE_VIOLATION = "23505";

/**
 * Does this error, or anything it wraps, carry SQLSTATE `code`?
 *
 * Drizzle throws `DrizzleQueryError(query, params, cause)`, so the postgres.js
 * error that actually knows the code is one level down. The walk is bounded and
 * only ever compares against the code asked for, so an unrelated `code` on a
 * wrapper (a Node `EPIPE`, say) can neither match nor hide the one underneath.
 */
function hasPgCode(error: unknown, code: string): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 5 && cursor != null; depth++) {
    if (typeof cursor !== "object") return false;
    if ("code" in cursor && (cursor as { code?: unknown }).code === code) return true;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return false;
}

/** The overlap constraint refused the write. Everything else is a real fault. */
function isOverlap(error: unknown): boolean {
  return hasPgCode(error, EXCLUSION_VIOLATION);
}

/* ============================================================
   INPUT
   ============================================================ */

/**
 * A booking id is a uuid. Guarding the shape keeps a junk id a sentence rather
 * than a `22P02` from the driver, and it costs one regex.
 */
const bookingIdSchema = z.uuid({ error: NOT_YOURS });

const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() : value);

/** Blank means "not given", which for a reason or a note means NULL. */
const emptyToNull = (value: unknown) => {
  if (value == null) return null;
  if (typeof value !== "string") return value;
  const text = value.trim();
  return text === "" ? null : text;
};

const reasonSchema = z.preprocess(
  emptyToNull,
  z
    .string({ error: "Write the reason as text." })
    .max(300, "Keep the reason to 300 characters.")
    .nullable(),
);

const noteSchema = z.preprocess(
  emptyToNull,
  z
    .string({ error: "Write the note as text." })
    .max(300, "Keep the note to 300 characters.")
    .nullable(),
);

function dayField(malformed: string) {
  return z.preprocess(
    trimmed,
    z.string({ error: malformed }).refine(isDateStr, { error: malformed }),
  );
}

const blockSchema = z.object({
  startDate: dayField("Write the first night as a date, like 2026-08-01."),
  endDate: dayField("Write the day the house is free again, like 2026-08-08."),
  note: noteSchema,
});

/** One message, attached to one input. A wall of red helps nobody. */
function failure(error: z.ZodError): DecisionResult {
  const issue = error.issues[0];
  if (!issue) return { ok: false, error: "Check those dates and try again." };
  const field = issue.path.find((part): part is string => typeof part === "string");
  return field
    ? { ok: false, error: issue.message, field }
    : { ok: false, error: issue.message };
}

function parseBookingId(value: unknown): string | null {
  const parsed = bookingIdSchema.safeParse(trimmed(value));
  return parsed.success ? parsed.data : null;
}

/* ============================================================
   READS
   ============================================================ */

/** A booking with the house it sits on. Both are needed by every action here. */
type OwnedBooking = { booking: Booking; house: House };

/**
 * One booking, joined to its house, scoped to the signed-in owner.
 *
 * Ownership is in the `WHERE`, not in an `if` afterwards: a booking on someone
 * else's house does not come back at all, so there is no path where a caller's
 * id is trusted and no second place for that rule to drift.
 */
async function ownedBooking(id: string, ownerId: string): Promise<OwnedBooking | null> {
  const [row] = await db
    .select({ booking: bookings, house: houses })
    .from(bookings)
    .innerJoin(houses, eq(bookings.houseId, houses.id))
    .where(and(eq(bookings.id, id), eq(houses.ownerId, ownerId)))
    .limit(1);
  return row ?? null;
}

/* ============================================================
   AFTER A WRITE
   ============================================================ */

/**
 * Everything that shows these dates.
 *
 * `/app` as a layout because the header counts pending requests, `/h/[slug]`
 * because the calendar fill changed, and `/b/[token]` because the guest's own
 * page is the only place they will read the answer.
 */
function revalidateDates(slug: string, token?: string | null) {
  revalidatePath("/app", "layout");
  revalidatePath(`/h/${slug}`);
  if (token) revalidatePath(`/b/${token}`);
}

/**
 * Send, and if sending fails, say so to the server log and nowhere else.
 *
 * By the time this runs the decision is committed. Letting a mail failure
 * surface as a failed action would tell the owner their approval did not land
 * when it did — which is worse than a missing email by a wide margin.
 *
 * `lib/emails.ts` already promises not to throw. This is the second net, on the
 * grounds that "an approval cannot be undone by an email" is a property of the
 * approval, not a favour another module does for it.
 */
async function mail(label: string, sending: () => Promise<void>): Promise<void> {
  try {
    await sending();
  } catch (error) {
    console.error(`[decision] ${label} email failed`, error);
  }
}

/* ============================================================
   APPROVE
   ============================================================ */

/**
 * Say yes. The dates become the guest's, and nobody else can have them.
 *
 * The update carries `status = 'pending'` in its own `WHERE`, so a second tab
 * that already decided this request updates nothing and gets told so rather
 * than quietly overwriting the first answer.
 */
export async function approveBooking(bookingId: string): Promise<DecisionResult> {
  const owner = await requireOwner();

  const id = parseBookingId(bookingId);
  if (!id) return { ok: false, error: NOT_YOURS };

  const found = await ownedBooking(id, owner.id);
  if (!found) return { ok: false, error: NOT_YOURS };

  const { booking, house } = found;

  if (booking.kind === "block") {
    return { ok: false, error: "Those are dates you blocked, not a request." };
  }
  if (booking.status === "confirmed") {
    return { ok: false, error: "You already approved that request." };
  }
  if (booking.status === "declined") {
    return { ok: false, error: "You already declined that request." };
  }
  if (booking.status === "cancelled") {
    return { ok: false, error: "The guest cancelled that request." };
  }

  let confirmed: Booking;
  try {
    // No overlap check before this line, on purpose. The constraint is the
    // authority and it is checked inside the same statement that writes.
    const [row] = await db
      .update(bookings)
      .set({
        status: "confirmed",
        decidedAt: new Date(),
        // A reason from an earlier decision would be a lie on a confirmed stay.
        declineReason: null,
      })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, "pending")))
      .returning();

    if (!row) return { ok: false, error: ALREADY_DECIDED };
    confirmed = row;
  } catch (error) {
    if (isOverlap(error)) return { ok: false, error: DATES_TAKEN };
    // Anything else is a fault, and a fault that reads like a double-booking is
    // a fault nobody ever finds. It keeps its own message and its own log line.
    console.error("[approveBooking] update failed", error);
    return { ok: false, error: "The approval did not save. Try again in a moment." };
  }

  revalidateDates(house.slug, confirmed.token);

  await mail("confirmation", () => sendBookingConfirmed(house, confirmed));

  // The dates are the guest's whatever Google says next. This can only set
  // `googleSync`; it cannot fail this action, and on an unconnected house it
  // does nothing at all.
  await syncBooking(confirmed, house);

  return { ok: true };
}

/* ============================================================
   DECLINE
   ============================================================ */

/**
 * Say no, optionally with a reason the guest reads on their own page and in
 * their email. The reason is theirs to see, so it is stored on the booking
 * rather than logged somewhere only the owner looks.
 *
 * A confirmed stay cannot be declined — declining answers a *request*. Undoing
 * an approval is a different act with different consequences (an email that
 * says something else, a calendar event to remove) and it does not exist in v1.
 */
export async function declineBooking(
  bookingId: string,
  reason?: string | null,
): Promise<DecisionResult> {
  const owner = await requireOwner();

  const id = parseBookingId(bookingId);
  if (!id) return { ok: false, error: NOT_YOURS };

  const parsed = reasonSchema.safeParse(reason);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Check the reason and try again.",
      field: "reason",
    };
  }

  const found = await ownedBooking(id, owner.id);
  if (!found) return { ok: false, error: NOT_YOURS };

  const { booking, house } = found;

  if (booking.kind === "block") {
    return {
      ok: false,
      error: "Those are dates you blocked, not a request. Unblock them instead.",
    };
  }
  if (booking.status === "confirmed") {
    return { ok: false, error: "You already approved that request." };
  }
  if (booking.status === "declined") {
    return { ok: false, error: "You already declined that request." };
  }
  if (booking.status === "cancelled") {
    return { ok: false, error: "The guest cancelled that request." };
  }

  let declined: Booking;
  try {
    const [row] = await db
      .update(bookings)
      .set({
        status: "declined",
        declineReason: parsed.data,
        decidedAt: new Date(),
      })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, "pending")))
      .returning();

    if (!row) return { ok: false, error: ALREADY_DECIDED };
    declined = row;
  } catch (error) {
    // `bookings_no_overlap` only covers confirmed rows, so nothing here can
    // collide. Anything thrown is a fault.
    console.error("[declineBooking] update failed", error);
    return { ok: false, error: "The decline did not save. Try again in a moment." };
  }

  revalidateDates(house.slug, declined.token);

  await mail("decline", () => sendBookingDeclined(house, declined));

  // A pending request never reached the calendar, so this is almost always a
  // no-op. It runs anyway, because "almost always" is not a guarantee: a row
  // that was somehow confirmed and synced first would leave its event behind.
  await syncBooking(declined, house);

  return { ok: true };
}

/* ============================================================
   BLOCK
   ============================================================ */

/** The longest single block. A mistyped year should not swallow a year. */
const MAX_BLOCK_NIGHTS = 365;

/**
 * Keep dates for yourself. A block is a `kind: 'block'`, `status: 'confirmed'`
 * booking with nobody in it — which means it holds dates through the same
 * constraint as a guest's stay, appears in the same calendar fill, and needs no
 * second overlap rule anywhere.
 *
 * `endDate` is the day the house is free again, exactly as it is for a stay.
 * Blocking 1–8 August holds seven nights and leaves the 8th bookable.
 */
export async function blockDates(
  startDate: string,
  endDate: string,
  note?: string | null,
): Promise<DecisionResult> {
  await requireOwner();

  const house = await getOwnerHouse();
  if (!house) {
    return {
      ok: false,
      error: "You do not have a house yet. Add one, then block dates on it.",
    };
  }

  const parsed = blockSchema.safeParse({ startDate, endDate, note });
  if (!parsed.success) return failure(parsed.error);

  const nights = nightsBetween(parsed.data.startDate, parsed.data.endDate);
  if (nights <= 0) {
    return {
      ok: false,
      error: "A block covers at least one night. Move the last day later.",
      field: "endDate",
    };
  }
  if (nights > MAX_BLOCK_NIGHTS) {
    return {
      ok: false,
      error: `Block ${MAX_BLOCK_NIGHTS} nights or fewer at a time.`,
      field: "endDate",
    };
  }

  let saved = false;
  let created: Booking | null = null;
  let lastError: unknown = null;

  // The token is never used — a block has no guest page — but the column is the
  // guest's credential and stays unique for everything in the table. A 16-char
  // draw collides about never; when it does, draw again.
  for (let attempt = 0; attempt < 3 && !saved; attempt++) {
    try {
      // `returning()` is here only so the new row can be handed to the calendar
      // sync below. A driver that answers with no row still counts as saved —
      // the insert did not throw, and the block exists.
      const [row] = await db
        .insert(bookings)
        .values({
          houseId: house.id,
          kind: "block",
          guests: 1,
          note: parsed.data.note,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          status: "confirmed",
          token: newToken(),
          // Created and decided in one tap; there was never anything pending.
          decidedAt: new Date(),
        })
        .returning();
      created = row ?? null;
      saved = true;
    } catch (error) {
      lastError = error;
      // Same constraint, same race, plainer sentence: nobody was deciding.
      if (isOverlap(error)) return { ok: false, error: BLOCK_TAKEN, field: "startDate" };
      if (!hasPgCode(error, UNIQUE_VIOLATION)) break;
    }
  }

  if (!saved) {
    console.error("[blockDates] insert failed", lastError);
    return { ok: false, error: "The block did not save. Try again in a moment." };
  }

  revalidateDates(house.slug);

  // A block the owner made is a week the house is not free, which is exactly
  // what belongs on their calendar. Same rule as an approval: it cannot fail
  // this action.
  if (created) await syncBooking(created, house);

  return { ok: true };
}

/* ============================================================
   UNBLOCK
   ============================================================ */

/**
 * Give your own dates back. A block is the only thing this deletes.
 *
 * `kind = 'block'` is checked on the row *and* repeated in the `DELETE`'s own
 * `WHERE`. The first check writes the message; the second one is what makes the
 * rule true — a guest's confirmed stay cannot be removed through the blocking
 * control, whatever id it is handed and whatever happened in between.
 */
export async function unblockDates(bookingId: string): Promise<DecisionResult> {
  const owner = await requireOwner();

  const id = parseBookingId(bookingId);
  if (!id) return { ok: false, error: "That block is not one of yours." };

  const found = await ownedBooking(id, owner.id);
  if (!found) return { ok: false, error: "That block is not one of yours." };

  const { booking, house } = found;

  if (booking.kind !== "block") {
    return {
      ok: false,
      error: "Those dates hold a guest's stay, not a block. Cancel the stay instead.",
    };
  }

  try {
    await db
      .delete(bookings)
      .where(and(eq(bookings.id, booking.id), eq(bookings.kind, "block")));
  } catch (error) {
    console.error("[unblockDates] delete failed", error);
    return { ok: false, error: "The block did not lift. Try again in a moment." };
  }

  revalidateDates(house.slug);

  // The row is gone, so there is nothing left to write a sync state to — only
  // an event on Google to take down. If it is already gone, that is a success.
  await syncRemovedBooking(booking, house);

  return { ok: true };
}
