"use server";

/**
 * The two things a guest can do, and neither of them involves signing in.
 *
 * `requestBooking` asks for dates. `cancelBooking` gives them back. Both are
 * **public** — the slug in the URL is what lets you ask, the token in the URL is
 * what lets you cancel, and there is no session anywhere in this file. That is
 * the product decision, not an oversight: guests are family, and an account
 * wall is exactly the friction this replaces.
 *
 * ### The rule that matters
 *
 * `requestBooking` calls `checkRequest()` — the same function the calendar uses
 * to grey days out. Not a copy of it, not an "and also check that the dates are
 * free". The form and the calendar cannot disagree about what is bookable
 * because they ask one function, and `today` comes from the server, so a phone
 * with a wrong clock changes nothing.
 *
 * Hard integrity — two confirmed stays on the same night — is the database's
 * job (`bookings_no_overlap`), and it only fires on approval. Two pending
 * requests on one week is a correct state; the owner sees the clash and picks.
 *
 * ### Copy
 *
 * Everything a guest reads comes from `lib/i18n` in the *house's* language.
 * Everything the owner reads is English, per the plan — the dashboard is
 * English only in v1 and their mail should match it.
 *
 * Neither of the two emails this file triggers is written here. All five live
 * in `lib/emails.ts` — one file that knows about escaping, language and the
 * `.ics`, rather than five inboxes' worth of HTML scattered across the actions
 * that happen to send them. Both calls are awaited and neither can throw.
 */

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "@/db";
import { bookings } from "@/db/schema";
import { checkRequest, type CheckFailureCode } from "@/lib/availability";
import { bookingByToken, busyRanges, houseBySlug, houseRules } from "@/lib/bookings";
import { isDateStr, toStr } from "@/lib/dates";
import { sendGuestCancelled, sendRequestReceived } from "@/lib/emails";
import { newToken } from "@/lib/ids";
import { DEFAULT_LANG, failureMessage, t, toLang, type Lang } from "@/lib/i18n";

/* ============================================================
   SHAPES
   ============================================================ */

/**
 * A request. `guests` accepts a string because a form sends strings; everything
 * is coerced and validated below rather than trusted.
 */
export type RequestBookingInput = {
  /** The house's public slug, from `/h/[slug]`. */
  slug: string;
  guestName: string;
  guestEmail: string;
  guests: number | string;
  note?: string | null;
  /** Check-in day, `YYYY-MM-DD`. */
  startDate: string;
  /** Check-out day, `YYYY-MM-DD`, exclusive. */
  endDate: string;
};

/**
 * `field` is the input's `name`, so an error lands beside the thing that caused
 * it: `guestName`, `guestEmail`, `guests`, `note`, `startDate`, `endDate`.
 * A date-range control that owns both days should watch for either date key.
 */
export type RequestBookingResult =
  | { ok: true; token: string }
  | { ok: false; error: string; field?: string };

export type CancelBookingResult = { ok: true } | { ok: false; error: string };

/* ============================================================
   PAYLOAD
   ============================================================ */

type Payload = FormData | Record<string, unknown>;

function readField(source: Payload, key: string): unknown {
  if (source instanceof FormData) {
    const value = source.get(key);
    return typeof value === "string" ? value : undefined;
  }
  return source[key];
}

const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() : value);

/** `""` means "not filled in" for every field on this form. */
const blankToUndefined = (value: unknown) => {
  const text = trimmed(value);
  return text === "" ? undefined : text;
};

const toCount = (value: unknown) => {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text === "") return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

/* ============================================================
   VALIDATION
   ============================================================ */

/**
 * Built per request, because every message is in the house's language — which
 * is only known once the house is loaded. Cheap: zod schemas are plain objects.
 */
function requestSchema(lang: Lang) {
  const msg = (key: string) => t(key, lang);

  return z.object({
    guestName: z.preprocess(
      blankToUndefined,
      z
        .string({ error: msg("form.name.required") })
        .max(80, msg("form.name.tooLong")),
    ),
    guestEmail: z.preprocess(
      blankToUndefined,
      z
        .string({ error: msg("form.email.required") })
        .max(254, msg("form.email.tooLong"))
        .pipe(z.email({ error: msg("form.email.invalid") })),
    ),
    guests: z.preprocess(
      toCount,
      z
        .number({ error: msg("form.guests.required") })
        .int({ error: msg("form.guests.whole") })
        .min(1, msg("form.guests.min")),
    ),
    note: z.preprocess(
      blankToUndefined,
      z.string().max(500, msg("form.note.tooLong")).optional(),
    ),
    startDate: z.preprocess(
      blankToUndefined,
      z
        .string({ error: msg("form.dates.required") })
        .refine(isDateStr, { error: msg("form.dates.invalid") }),
    ),
    endDate: z.preprocess(
      blankToUndefined,
      z
        .string({ error: msg("form.dates.required") })
        .refine(isDateStr, { error: msg("form.dates.invalid") }),
    ),
  });
}

/** One message, attached to one field. A wall of red is nobody's idea of help. */
function failure(error: z.ZodError): RequestBookingResult {
  const issue = error.issues[0];
  if (!issue) {
    return { ok: false, error: t("form.error.generic", DEFAULT_LANG) };
  }
  const field = issue.path.find((part): part is string => typeof part === "string");
  return field
    ? { ok: false, error: issue.message, field }
    : { ok: false, error: issue.message };
}

/**
 * Which input a broken house rule belongs to.
 *
 * Length and ordering are the checkout day's fault; everything else about the
 * dates is the arrival day's. Headcount is its own control.
 */
const FAILURE_FIELD: Record<CheckFailureCode, string> = {
  END_BEFORE_START: "endDate",
  PAST: "startDate",
  TOO_SHORT: "endDate",
  TOO_LONG: "endDate",
  INVALID_GUESTS: "guests",
  TOO_MANY_GUESTS: "guests",
  OUTSIDE_WINDOW: "startDate",
  OVERLAP: "startDate",
  GAP: "startDate",
};

/* ============================================================
   REQUEST
   ============================================================ */

/**
 * Ask for dates. Public — anyone holding the house's link may call this.
 *
 * Returns the new booking's token so the caller can send the guest straight to
 * `/b/[token]`, which is the only place they will ever see this booking again.
 */
export async function requestBooking(
  input: RequestBookingInput | FormData,
): Promise<RequestBookingResult> {
  // RATE LIMIT: a public write with no session belongs behind a per-IP limiter
  // (say 5 requests per hour). Not tonight — it needs a shared store this app
  // does not have yet, and a limiter backed by process memory is theatre on a
  // serverless runtime.

  const slug = readField(input, "slug");
  const house = typeof slug === "string" ? await houseBySlug(slug.trim()) : null;

  // Before the house is known there is no language, so English it is.
  if (!house) {
    return { ok: false, error: t("form.house.missing", DEFAULT_LANG) };
  }

  const lang = toLang(house.language);

  const parsed = requestSchema(lang).safeParse({
    guestName: readField(input, "guestName"),
    guestEmail: readField(input, "guestEmail"),
    guests: readField(input, "guests"),
    note: readField(input, "note"),
    startDate: readField(input, "startDate"),
    endDate: readField(input, "endDate"),
  });
  if (!parsed.success) return failure(parsed.error);

  const { guestName, guestEmail, guests, note, startDate, endDate } = parsed.data;

  const rules = houseRules(house);
  const busy = await busyRanges(house.id);
  // The server's day, never the client's. A phone with yesterday's clock does
  // not get to book yesterday.
  const today = toStr(new Date());

  const check = checkRequest(rules, busy, { startDate, endDate, guests }, today);
  if (!check.ok) {
    return {
      ok: false,
      error: failureMessage(check.code, lang, rules, { startDate }),
      field: FAILURE_FIELD[check.code],
    };
  }

  let token = "";
  // The row's own id, read back from the insert. The email is built from a
  // booking, not from six loose variables, and `lib/ics` derives a stable UID
  // from this id — so it has to be the database's, not one invented here.
  let id = "";
  let lastError: unknown = null;

  // The only realistic failure is a token colliding, which is a redraw away.
  for (let attempt = 0; attempt < 3 && !token; attempt++) {
    const candidate = newToken();
    try {
      const [row] = await db
        .insert(bookings)
        .values({
          houseId: house.id,
          kind: "guest",
          guestName,
          guestEmail,
          guests,
          note: note ?? null,
          startDate,
          endDate,
          status: "pending",
          token: candidate,
        })
        .returning({ id: bookings.id });
      token = candidate;
      id = row?.id ?? "";
    } catch (error) {
      lastError = error;
      if (!isUniqueViolation(error)) break;
    }
  }

  if (!token) {
    console.error("[requestBooking] insert failed", lastError);
    return { ok: false, error: t("form.error.generic", lang) };
  }

  await sendRequestReceived(house, {
    id,
    kind: "guest",
    guestName,
    guestEmail,
    guests,
    note: note ?? null,
    startDate,
    endDate,
    status: "pending",
    declineReason: null,
    token,
  });

  // The owner's list gained a request; the house calendar gained a pending range.
  revalidatePath("/app", "layout");
  revalidatePath(`/h/${house.slug}`);

  return { ok: true, token };
}

/* ============================================================
   CANCEL
   ============================================================ */

/**
 * Give the dates back. Public — the token is the whole credential, which is why
 * it is sixteen characters of unguessable alphabet and never appears on a page
 * the guest did not open themselves.
 *
 * A guest may cancel while their booking is `pending` or `confirmed`. Anything
 * else is already over, and gets a plain sentence saying so rather than an error.
 */
export async function cancelBooking(token: string): Promise<CancelBookingResult> {
  const found = typeof token === "string" ? await bookingByToken(token.trim()) : null;
  if (!found) {
    return { ok: false, error: t("booking.notFound", DEFAULT_LANG) };
  }

  const { booking, house } = found;
  const lang = toLang(house.language);

  if (booking.status === "cancelled") {
    return { ok: false, error: t("booking.cancel.already", lang) };
  }
  if (booking.status === "declined") {
    return { ok: false, error: t("booking.cancel.declined", lang) };
  }

  try {
    await db
      .update(bookings)
      .set({
        status: "cancelled",
        // The moment this stopped being open. An approval already stamped it,
        // and overwriting that would lose when the owner said yes.
        decidedAt: booking.decidedAt ?? new Date(),
      })
      .where(eq(bookings.id, booking.id));
  } catch (error) {
    console.error("[cancelBooking] update failed", error);
    return { ok: false, error: t("booking.cancel.failed", lang) };
  }

  // Phase 6 deletes the Google event here, after the row is committed and in a
  // way that cannot fail the cancellation.

  await sendGuestCancelled(house, booking);

  revalidatePath("/app", "layout");
  revalidatePath(`/h/${house.slug}`);
  revalidatePath(`/b/${booking.token}`);

  return { ok: true };
}

/* ============================================================
   HELPERS
   ============================================================ */

/** Postgres `unique_violation` — here, only ever two tokens drawing the same. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
