/**
 * The contract between this app and Google Calendar — and nothing else.
 *
 * This file names the four **write** operations the product performs, the shape
 * of the one kind of event it writes, the scopes the owner consents to, and the
 * four ways a Google call can fail. It imports nothing from `googleapis` and
 * nothing from the database, so it costs nothing to load, and a **client
 * component can import the scopes from here** — which is the whole reason they
 * live in this file rather than beside the sync code that uses them.
 *
 * Two implementations satisfy {@link CalendarClient}:
 *
 * - `lib/google/client.ts` — the real one, over `googleapis`.
 * - `lib/google/fake.ts` — an in-memory one with the same behaviour, including
 *   the failures. Every test uses the fake; the real client is never called
 *   from a test, and as of this phase has never been run against live Google.
 *
 * ### The surface is not this small any more
 *
 * This file once said "the plan is one-way sync: confirmed stay in, event out;
 * the app never reads the owner's calendar". That is no longer true and the
 * sentence has been deleted rather than softened. The owner asked for the
 * opposite — *"Anything that may be in the calendar needs to be blocked… yk if
 * they added like other people before"* — so the app also **lists** the owner's
 * calendars and **reads** events from the one they choose. Those two reads live
 * on `SyncCalendarClient` in `lib/google/sync.ts`, which extends the interface
 * below; the scopes here cover all six calls.
 */

import type { DateStr } from "@/lib/dates";

/* ============================================================
   SCOPE
   ============================================================ */

/**
 * ## What the owner is actually consenting to, and why it grew
 *
 * This file used to ask for one scope, `calendar.app.created`, and argued for it
 * on privacy grounds: it reaches **only calendars this app itself created**, so
 * the owner was "handing over a room, not a key to the building". The argument
 * was sound and the scope was wrong, because of the sentence it buried at the
 * end — *a calendar the owner makes by hand and points us at will not work*.
 *
 * That is not a footnote. It is the feature. The owner's requirement, verbatim:
 *
 * > *"Anything that may be in the calendar needs to be blocked. not hourly stuff
 * > like that. yk if they added like other people before yk doing it."*
 *
 * The weeks they mean were promised to cousins over WhatsApp two summers ago and
 * live in the calendar they already keep — a calendar this app did not create and
 * under `calendar.app.created` can never see. Worse, that scope made the connect
 * screen a dead end: on first connect there are no app-created calendars, so the
 * picker had nothing in it, no calendar id was ever stored, and Settings reported
 * "not connected" forever with no way forward.
 *
 * So the ask is wider now, and the honest description of it is:
 *
 * **The owner is letting this app see the *names* of every calendar they keep,
 * and read, write and delete events on the calendars they *own*.** Not one room.
 * It cannot see a colleague's calendar or a partner's calendar shared with them,
 * it cannot change any calendar's sharing or settings, and it cannot delete a
 * calendar — but within their own calendars it can read everything, and reading
 * everything is the point: a week it cannot see is a week it will double-book.
 *
 * Each of the three is the narrowest scope Google publishes for the call that
 * needs it. Checked per operation against the **live** Calendar v3 discovery
 * document (`https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest`) and
 * Google's auth guide, not from memory, because a scope that turns out not to
 * cover an operation is discovered at the worst possible moment — mid-consent.
 */

/**
 * *"See the list of Google calendars you're subscribed to."*
 *
 * The index only — names and ids, nothing inside any of them. Needed for
 * `calendarList.list`, which is how the owner is offered a choice at all.
 *
 * `calendarList.list` accepts exactly four scopes: this one, `calendar.calendarlist`
 * (which also lets the app **add and remove** subscriptions), `calendar.readonly`
 * and `calendar` (both of which read every calendar's contents). This is the
 * smallest of the four.
 */
export const CALENDAR_LIST_SCOPE =
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

/**
 * *"See, create, change, and delete events on Google calendars you own."*
 *
 * The working scope. It covers `events.list` — the pull that finds the weeks
 * already promised — and `events.insert`, `events.patch`, `events.delete`, which
 * put confirmed stays out.
 *
 * `.owned` is doing real work in that name. The alternative Google offers is
 * `calendar.events`, *"view and edit events on all your calendars"*, which
 * additionally reaches every calendar merely **shared** with the owner: a
 * partner's, a work calendar somebody added them to. This app has no business in
 * those. `.owned` stops at calendars the owner owns, which is also exactly the
 * set they can pick from — see `listCalendars`, which asks Google for
 * `minAccessRole: 'owner'` so the picker cannot offer a calendar the grant
 * cannot write to.
 */
export const CALENDAR_EVENTS_OWNED_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned";

/**
 * *"Make secondary Google calendars, and see, create, change, and delete events
 * on them."*
 *
 * Kept from the original design, for the owner who does **not** want the summer
 * mixed into the calendar they live by. It is the only narrow scope that accepts
 * `calendars.insert`; the alternative, `calendar.calendars`, would additionally
 * let the app *"see and change the properties of Google calendars you have
 * access to"* — renaming or retitling calendars it did not make.
 *
 * It is no longer the whole grant, and on its own it was never enough. It is the
 * "make me a fresh one" half of the choice.
 */
export const CALENDAR_APP_CREATED_SCOPE =
  "https://www.googleapis.com/auth/calendar.app.created";

/**
 * Everything the second consent asks for, and therefore the three lines Google
 * puts on the screen:
 *
 * 1. *"See the list of Google calendars you're subscribed to"*
 * 2. *"See, create, change, and delete events on Google calendars you own"*
 * 3. *"Make secondary Google calendars, and see, create, change, and delete
 *    events on them"*
 *
 * **Each string must also be listed on the OAuth consent screen in the Google
 * Cloud console.** A scope the app requests and the consent screen does not
 * declare is silently dropped by Google — the owner consents, the callback
 * succeeds, and the grant simply lacks it. `SETUP-GOOGLE.md` has the exact
 * strings and where they go.
 *
 * Signing in asks for none of this: `lib/auth.ts` registers Google with the
 * default `openid email profile` and stops. This is a **second, later** consent,
 * asked from Settings by an owner who has already decided they want it.
 */
export const GOOGLE_CALENDAR_SCOPES: readonly string[] = [
  CALENDAR_LIST_SCOPE,
  CALENDAR_EVENTS_OWNED_SCOPE,
  CALENDAR_APP_CREATED_SCOPE,
];

/**
 * The legacy everything-scope. Nothing here ever asks for it, but an account
 * that carries it — granted by some earlier build, or by another app — can do
 * all six calls, so it counts as held.
 */
export const CALENDAR_FULL_SCOPE = "https://www.googleapis.com/auth/calendar";

/**
 * Which of {@link GOOGLE_CALENDAR_SCOPES} this account has **not** granted.
 *
 * The grant is stored by better-auth on `account.scope` as one string. Google
 * separates with spaces, better-auth re-joins with commas, and a real row in
 * this app's database has been seen holding `", "` — so split on both rather
 * than pick a side.
 *
 * This is the check that catches the upgrade case, and it is the reason the
 * check returns the *missing* scopes rather than a boolean. An owner who
 * consented while the app asked for one scope holds a grant that is real,
 * usable, and short — Google will keep handing that same old grant back for
 * ever, because a widened scope is never granted retroactively. Something has to
 * notice, and "some but not all" is what tells the settings screen to say *the
 * permission you gave is narrower than what this now needs* instead of pretending
 * nobody ever connected anything.
 */
export function missingCalendarScopes(granted: string | null | undefined): string[] {
  if (!granted) return [...GOOGLE_CALENDAR_SCOPES];
  const held = new Set(granted.split(/[\s,]+/).filter(Boolean));
  if (held.has(CALENDAR_FULL_SCOPE)) return [];
  return GOOGLE_CALENDAR_SCOPES.filter((scope) => !held.has(scope));
}

/** Has this account granted everything the sync needs? */
export function hasCalendarScope(granted: string | null | undefined): boolean {
  return missingCalendarScopes(granted).length === 0;
}

/**
 * Did the owner grant *something* calendar-shaped, just not enough?
 *
 * True only for a partial grant — the old narrow consent, or a consent screen in
 * the Google console that is missing one of the three strings. False both for an
 * account that has never been asked (nothing to explain) and for one that holds
 * the lot (nothing to fix). The settings screen shows a different sentence for
 * each, because "you have not connected Google" and "the access you gave is
 * narrower than this needs" are different problems with the same button.
 */
export function hasPartialCalendarScope(granted: string | null | undefined): boolean {
  const missing = missingCalendarScopes(granted);
  return missing.length > 0 && missing.length < GOOGLE_CALENDAR_SCOPES.length;
}

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
 * The four writes. `SyncCalendarClient` in `lib/google/sync.ts` adds the two
 * reads — `listCalendars` and `listEvents` — that two-way sync needs.
 *
 * Every method rejects with a {@link GoogleCalendarError} and nothing else —
 * both implementations funnel their failures through one mapper, so a caller
 * can switch on `kind` and never has to guess what it caught.
 */
export interface CalendarClient {
  /**
   * Make the house a secondary calendar of its own and return its id.
   *
   * One of the two ways a house gets a calendar, and the one for an owner who
   * does not want the summer mixed into the calendar they live by. The other is
   * picking a calendar they already keep, which needs no call at all — the id
   * comes straight off `listCalendars`. Either way the id lands on
   * `houses.googleCalendarId`, and that is the only calendar this app touches.
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
