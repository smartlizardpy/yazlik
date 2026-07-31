/**
 * The contract between this app and Google Calendar — and nothing else.
 *
 * This file names the four operations the product actually performs, the shape
 * of the one kind of event it writes, and the four ways a Google call can fail.
 * It imports nothing from `googleapis`, so it costs nothing to load and can be
 * read by code that will never talk to Google at all.
 *
 * Two implementations satisfy {@link CalendarClient}:
 *
 * - `lib/google/client.ts` — the real one, over `googleapis`.
 * - `lib/google/fake.ts` — an in-memory one with the same behaviour, including
 *   the failures. Every test uses the fake; the real client is never called
 *   from a test, and as of this phase has never been run against live Google.
 *
 * ### Why the surface is this small
 *
 * The plan is one-way sync: confirmed stay in, event out. The app never reads
 * the owner's calendar, never lists events, never watches for changes. Anything
 * beyond create / insert / patch / delete would be surface that has to keep
 * working without ever being used, so it is not here.
 */

import type { DateStr } from "@/lib/dates";

/* ============================================================
   SCOPE
   ============================================================ */

/**
 * The only OAuth scope this app asks for.
 *
 * Google's words for it: *"Make secondary Google calendars, and see, create,
 * change, and delete events on them."* The important half is what it leaves
 * out — it grants access **only to calendars this app itself created**. It
 * cannot read, edit, or even see the owner's personal calendar, their work
 * calendar, or anything they subscribe to. The owner is handing over a room,
 * not a key to the building.
 *
 * The obvious alternatives are all wider than the job:
 *
 * - `.../auth/calendar` — every calendar the owner can access, read and write.
 * - `.../auth/calendar.events` — events on *all* their calendars.
 * - `.../auth/calendar.calendars` + `.../auth/calendar.events` — two scopes to
 *   do what this one does, and the second still reaches everything.
 *
 * Verified twice before this was written, because a scope that turns out not to
 * cover an operation is discovered at the worst possible moment — during the
 * owner's first consent:
 *
 * 1. The discovery document vendored in `googleapis@173.0.0` lists this scope
 *    as accepted by `calendars.insert`, `events.insert`, `events.patch` and
 *    `events.delete` — all four calls this app makes, and no others are needed.
 * 2. Google's live Calendar auth guide describes it exactly as quoted above.
 *
 * So there is no fallback to `calendar.events` plus `calendar`, and the owner
 * consents to one line on the screen instead of "see, edit, share and
 * permanently delete all the calendars you can access".
 *
 * One consequence worth knowing before the consent screen is designed: because
 * the grant is scoped to calendars *this app created*, a calendar the owner
 * makes by hand and points us at will not work. The app has to create it. That
 * is why `houses.googleCalendarId` is written by us on first connect and is
 * never an input field.
 */
export const CALENDAR_APP_CREATED_SCOPE =
  "https://www.googleapis.com/auth/calendar.app.created";

/** Everything the OAuth consent asks for. One entry, on purpose. */
export const GOOGLE_CALENDAR_SCOPES: readonly string[] = [CALENDAR_APP_CREATED_SCOPE];

/* ============================================================
   TOKENS
   ============================================================ */

/**
 * What the caller has to hand over to make a call.
 *
 * These live in better-auth's `account` table rather than a bespoke store, so
 * the field names here are deliberately the app's names (`accessToken`), not
 * Google's wire names (`access_token`). `lib/google/client.ts` does the one
 * translation.
 *
 * `refreshToken` is the one that matters. An access token is minutes old by the
 * time a booking is approved; the refresh token is what lets the client mint a
 * new one without the owner present. Without it, sync works until the first
 * token expires and then quietly stops.
 */
export type GoogleTokens = {
  accessToken?: string | null;
  refreshToken?: string | null;
  /** When the access token dies. `Date` from the database, ms since epoch, or unknown. */
  expiresAt?: Date | number | null;
};

/* ============================================================
   THE ONE KIND OF EVENT THIS APP WRITES
   ============================================================ */

/**
 * An all-day event covering a stay.
 *
 * `start` and `end` are `YYYY-MM-DD` strings and the range is **half-open**,
 * exactly as everywhere else in this codebase: the guest sleeps on `start`,
 * leaves on `end`, and `end` is free for the next arrival. That happens to be
 * precisely Google's rule for an all-day event's `end.date`, so the booking
 * columns go on the wire unchanged — no ±1 day fudge in either direction, which
 * is the single most common way an all-day calendar integration goes wrong.
 *
 * There is no time, no timezone, and no attendee list. A stay is days, the
 * calendar is the owner's own, and inviting the guest by email is the `.ics`
 * attachment's job (see `lib/ics.ts`), not this one's.
 */
export type CalendarEvent = {
  /** Event title. Guest name and headcount, composed by the sync layer. */
  summary: string;
  /** The booking note and a link back to `/app`. Plain text. */
  description?: string;
  location?: string;
  /** Check-in day, inclusive. */
  start: DateStr;
  /** Check-out day, exclusive. */
  end: DateStr;
  /**
   * `true` marks the owner busy for those days.
   *
   * Defaults to `false` — transparent — matching the same call in `lib/ics.ts`
   * and for the same reason: a week at the house should not black out a week of
   * somebody's working calendar.
   */
  opaque?: boolean;
};

/**
 * The subset of an event a patch changes.
 *
 * Google's `events.patch` merges: fields left out keep their current value.
 * One rule the API does enforce — **send `start` and `end` together or neither**.
 * Patching only one end of an all-day range is rejected as an empty or
 * backwards time range, which arrives here as an `other` error with status 400.
 */
export type CalendarEventPatch = Partial<CalendarEvent>;

/* ============================================================
   THE CLIENT
   ============================================================ */

/**
 * Four operations. The whole integration.
 *
 * Every method rejects with a {@link GoogleCalendarError} and nothing else —
 * both implementations funnel their failures through one mapper, so a caller
 * can switch on `kind` and never has to guess what it caught.
 */
export interface CalendarClient {
  /**
   * Make the house its own secondary calendar and return its id.
   *
   * Called exactly once per house, on first connect. The id is stored on
   * `houses.googleCalendarId` and is the only calendar this app can ever touch.
   */
  createCalendar(summary: string): Promise<{ calendarId: string }>;

  /** Put a confirmed stay on the calendar. The returned id goes on `bookings.googleEventId`. */
  insertEvent(calendarId: string, event: CalendarEvent): Promise<{ eventId: string }>;

  /** The dates or the title changed. Merges; see {@link CalendarEventPatch}. */
  patchEvent(calendarId: string, eventId: string, event: CalendarEventPatch): Promise<void>;

  /** The stay was cancelled or declined after confirmation. Take it off the calendar. */
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
}

/* ============================================================
   FAILURE
   ============================================================ */

/**
 * The four ways a Google call fails, each needing a different answer.
 *
 * The sync layer treats these very differently, and an untyped error would
 * force it to guess from a message string:
 *
 * - `auth` — the token is dead, revoked, or was never valid; or the app has no
 *   client credentials configured at all. **Retrying cannot help.** The owner
 *   has to reconnect. HTTP 401, most 403s, and the OAuth token endpoint's
 *   `invalid_grant`, which is what a revoked refresh token actually looks like.
 * - `notFound` — the calendar or the event is gone, almost always because
 *   somebody deleted it by hand in the Google UI. Retrying cannot help either,
 *   but the answer is different: forget the stored id and move on. A delete that
 *   fails this way has, in every sense that matters, succeeded.
 * - `rateLimit` — too many calls. **Retrying is the correct response**, later.
 * - `other` — a 5xx, a network fault, a malformed request, anything unclassified.
 *
 * @see {@link GoogleCalendarError.retryable} for the one-line version.
 */
export type GoogleErrorKind = "auth" | "notFound" | "rateLimit" | "other";

export type GoogleCalendarErrorOptions = {
  /** HTTP status, when there was a response at all. */
  status?: number;
  /** Google's own machine-readable reason, e.g. `rateLimitExceeded`, `invalid_grant`. */
  reason?: string;
  /** Which of the four calls failed, for the log line. */
  operation?: string;
  /** Override the default derived from `kind`. */
  retryable?: boolean;
  cause?: unknown;
};

/**
 * Every failure that leaves a {@link CalendarClient}, real or fake.
 *
 * The message is for the server log, never for a guest or an owner. Nothing in
 * this integration is allowed to surface to a person: an approval commits
 * first, sync happens after, and a failure sets `googleSync: 'failed'` and
 * stops. See `app/_actions/decision.ts`.
 */
export class GoogleCalendarError extends Error {
  readonly kind: GoogleErrorKind;
  readonly status?: number;
  readonly reason?: string;
  readonly operation?: string;
  /** Whether the reminders cron should pick this row up again on its next pass. */
  readonly retryable: boolean;

  constructor(kind: GoogleErrorKind, message: string, options: GoogleCalendarErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GoogleCalendarError";
    this.kind = kind;
    this.status = options.status;
    this.reason = options.reason;
    this.operation = options.operation;
    this.retryable = options.retryable ?? defaultRetryable(kind, options.status);
  }
}

/**
 * Is trying again later worth anything?
 *
 * `rateLimit` yes, by definition. `auth` and `notFound` never — the token is
 * dead or the resource is gone, and both need a human or a different decision.
 * `other` covers both "Google had a bad minute" and "we sent nonsense": a 5xx
 * or no response at all is worth another pass, a 4xx is us and will fail
 * identically forever.
 */
function defaultRetryable(kind: GoogleErrorKind, status?: number): boolean {
  if (kind === "rateLimit") return true;
  if (kind !== "other") return false;
  return status === undefined || status >= 500;
}

/** Narrowing helper for `catch` blocks, which see `unknown`. */
export function isGoogleCalendarError(error: unknown): error is GoogleCalendarError {
  return error instanceof GoogleCalendarError;
}
