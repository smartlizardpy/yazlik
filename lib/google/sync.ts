/**
 * Two-way sync between this app and **one** Google calendar the owner chooses.
 *
 * The owner's own words for what they wanted: *"with the calendar thingy sync
 * blockings via the calendar as well… Anything that may be in the calendar needs
 * to be blocked. not hourly stuff like that. yk if they added like other people
 * before yk doing it."*
 *
 * Read that twice, because it is the whole specification:
 *
 * - **App → Google.** A confirmed stay, or a week the owner kept for
 *   themselves, becomes an all-day event on the chosen calendar.
 * - **Google → app.** All-day events that came from somewhere else — weeks the
 *   owner promised to a cousin over WhatsApp two summers ago, long before this
 *   app existed — become `kind: 'block'` bookings, so the guest page shows those
 *   days as taken.
 * - **A 3pm dentist appointment is not somebody staying in the house.** Timed
 *   events are ignored, and the test that proves it is the one that matters most
 *   in this file. The filter is `start.date` (an all-day event) versus
 *   `start.dateTime` (a time of day) — Google sends exactly one of the two.
 *
 * ### The rule that outranks everything else here
 *
 * **Sync must never be able to block an approval.** The booking is committed
 * first, by `app/_actions/decision.ts`, and the sync runs afterwards. Every
 * function exported from this file is total: it catches everything, and the
 * worst thing that can happen is `bookings.googleSync = 'failed'` and a line in
 * the server log. No throw reaches a caller, ever.
 *
 * That is why the outcome types below are unions of plain data rather than
 * exceptions, and why {@link syncBooking} takes a booking that has already been
 * written rather than doing the writing itself.
 *
 * ### The three states, and the difference between two of them
 *
 * - `'none'` — nothing is expected. No credentials on this deployment, no Google
 *   account linked, or no calendar chosen. **Total silence**: no Google call, no
 *   log line, and never `'failed'`. An owner who has not connected anything has
 *   not failed at anything.
 * - `'synced'` — the event is on the calendar and its id is on the row.
 * - `'failed'` — Google was asked and said no. `retryFailedSyncs` comes back for
 *   these later.
 *
 * Two failures get special handling, because retrying them forever is the
 * failure mode this file exists to avoid:
 *
 * - **`auth`** — the refresh token is dead or was revoked. Retrying cannot help
 *   and hammering Google with a dead grant is how an OAuth client gets
 *   throttled. The row is marked `'failed'` and that owner's batch stops — the
 *   pass carries on to the next house, whose grant is somebody else's.
 * - **`notFound` on the calendar** — the owner deleted it by hand in the Google
 *   UI. `houses.googleCalendarId` is cleared so the next sync starts over from
 *   "not connected" instead of failing identically forever.
 *
 * ### Where the extra two Google calls live
 *
 * `lib/google/client.ts` covers four operations — create a calendar, insert,
 * patch, delete an event. Two-way sync needs two more: list the owner's
 * calendars so they can pick one, and list the events on the one they picked.
 * They are implemented here, in {@link realSyncClient}, because `client.ts` was
 * not this slice's to edit. The OAuth wiring is a deliberate duplicate of
 * `connect()` there. **When `client.ts` is next opened, both calls belong in it**
 * and this half of the file should go.
 *
 * @see lib/google/fake.ts — the in-memory client every test runs against. Real
 * Google has never been called from this repository.
 */

import { and, asc, count, eq, isNotNull } from "drizzle-orm";
import type { calendar_v3 } from "googleapis";

import { db } from "@/db";
import { account } from "@/db/auth-schema";
import { bookings, houses, type Booking, type House } from "@/db/schema";
import { addDaysStr, isDateStr, nightsBetween, toStr, type DateStr } from "@/lib/dates";
import { googleClient, toGoogleCalendarError } from "@/lib/google/client";
import { googleCredentials, isGoogleConfigured } from "@/lib/google/config";
import {
  GOOGLE_CALENDAR_SCOPES,
  GoogleCalendarError,
  isGoogleCalendarError,
  type CalendarClient,
  type CalendarEvent,
  type GoogleErrorKind,
  type GoogleTokens,
} from "@/lib/google/types";
import { newToken } from "@/lib/ids";

/* ============================================================
   SCOPES
   ============================================================ */

/**
 * The scopes and the grant check live in `lib/google/types.ts`, not here.
 *
 * They were briefly defined in both files, which is how the bug this comment
 * replaces got in: the settings screen imported the *narrow* list from `types.ts`
 * and asked Google for that, while the `hasCalendarScope` defined here tested
 * against the *wide* list. The owner consented, Google granted what was asked
 * for, and the check said no. Nothing was retryable and nothing was wrong.
 *
 * `types.ts` wins because it is the only one of the two a **client component**
 * can import — it pulls in no database, no `googleapis`, no better-auth — and
 * the button that asks for consent is a client component. Re-exported here so
 * that server code reading this file finds them where it expects to.
 *
 * @see lib/google/types.ts for what each scope grants and why it is the
 * narrowest that covers its call.
 */
export {
  CALENDAR_APP_CREATED_SCOPE,
  CALENDAR_EVENTS_OWNED_SCOPE,
  CALENDAR_FULL_SCOPE,
  CALENDAR_LIST_SCOPE,
  hasCalendarScope,
  hasPartialCalendarScope,
  missingCalendarScopes,
} from "@/lib/google/types";

/** What the second consent asks for. `GOOGLE_CALENDAR_SCOPES`, under this file's name for it. */
export const CALENDAR_SYNC_SCOPES: readonly string[] = GOOGLE_CALENDAR_SCOPES;

/* ============================================================
   THE TWO CALLS `client.ts` DOES NOT HAVE
   ============================================================ */

/** One row of the owner's calendar list, as the "which calendar?" screen needs it. */
export type CalendarChoice = {
  calendarId: string;
  /** What the owner calls it. Their own override wins over the calendar's title. */
  name: string;
  /** Their default calendar — the one to offer first. */
  primary: boolean;
};

/** Google sends `date` for an all-day event and `dateTime` for one with a time. */
export type GoogleEventTime = {
  date?: string | null;
  dateTime?: string | null;
};

/**
 * An event as it comes off the wire, deliberately unprocessed.
 *
 * The all-day filter is the heart of this feature, so the raw shape reaches
 * {@link allDayRange} intact and the decision is made — and tested — here rather
 * than hidden in a mapper.
 */
export type GoogleEvent = {
  id?: string | null;
  status?: string | null;
  summary?: string | null;
  /** Set on an instance of a repeating event. Those are never stays. */
  recurringEventId?: string | null;
  start?: GoogleEventTime | null;
  end?: GoogleEventTime | null;
};

/** The half-open window a pull asks Google about. `to` is exclusive. */
export type EventWindow = { from: DateStr; to: DateStr };

/**
 * {@link CalendarClient} plus the two reads two-way sync needs.
 *
 * Both are `Promise`-returning and both reject with a `GoogleCalendarError`,
 * exactly like the four they join.
 */
export interface SyncCalendarClient extends CalendarClient {
  /** Calendars the owner can write to, most useful first. */
  listCalendars(): Promise<CalendarChoice[]>;
  /** Events overlapping `window`, repeats already expanded into instances. */
  listEvents(calendarId: string, window: EventWindow): Promise<GoogleEvent[]>;
}

/** Google wants RFC 3339; a plain day at UTC midnight is a valid one. */
function atMidnight(day: DateStr): string {
  return `${day}T00:00:00Z`;
}

/** Enough pages for any calendar an owner keeps by hand, and a bound. */
const MAX_EVENT_PAGES = 5;
const EVENTS_PER_PAGE = 2500;

/**
 * The same OAuth wiring as `connect()` in `client.ts`, because the two extra
 * calls had to live outside that file. See the module note.
 */
async function calendarApi(
  tokens: GoogleTokens,
  operation: string,
): Promise<calendar_v3.Calendar> {
  const credentials = googleCredentials();
  if (!credentials) {
    throw new GoogleCalendarError("auth", "Google is not configured on this deployment.", {
      reason: "missingCredentials",
      operation,
    });
  }

  const { google } = await import("googleapis");

  const auth = new google.auth.OAuth2({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });

  const expiresAt = tokens.expiresAt;
  auth.setCredentials({
    access_token: tokens.accessToken ?? undefined,
    refresh_token: tokens.refreshToken ?? undefined,
    expiry_date:
      expiresAt == null
        ? undefined
        : expiresAt instanceof Date
          ? expiresAt.getTime()
          : expiresAt,
  });

  return google.calendar({ version: "v3", auth });
}

/**
 * The real client: `client.ts`'s four operations, plus the two reads.
 *
 * Never constructed by a test. Every test passes a fake through
 * {@link SyncDeps.client}.
 */
export function realSyncClient(tokens: GoogleTokens): SyncCalendarClient {
  const base = googleClient(tokens);

  return {
    ...base,

    async listCalendars() {
      try {
        const api = await calendarApi(tokens, "listCalendars");
        const response = await api.calendarList.list({
          maxResults: 250,
          // Only calendars the owner **owns**, because that is exactly the set
          // the grant can write to: `calendar.events.owned` is "events on
          // calendars you own", and it stops there. `writer` would be the wider
          // and wrong answer — it also returns calendars merely shared with them
          // at write level, every one of which would be offered in the picker
          // and then 403 on the first stay. Offering a dead end is worse than
          // offering nothing. A read-only subscription (a holidays feed) is
          // excluded by the same filter, for the same reason.
          minAccessRole: "owner",
          showHidden: false,
        });

        const items = response.data.items ?? [];
        return items
          .filter((item): item is calendar_v3.Schema$CalendarListEntry => Boolean(item?.id))
          .map((item) => ({
            calendarId: item.id as string,
            name: (item.summaryOverride ?? item.summary ?? item.id) as string,
            primary: item.primary === true,
          }))
          .sort((a, b) => Number(b.primary) - Number(a.primary));
      } catch (error) {
        throw toGoogleCalendarError(error, "listCalendars");
      }
    },

    async listEvents(calendarId: string, window: EventWindow) {
      try {
        const api = await calendarApi(tokens, "listEvents");
        const found: GoogleEvent[] = [];
        let pageToken: string | undefined;

        for (let page = 0; page < MAX_EVENT_PAGES; page++) {
          const response = await api.events.list({
            calendarId,
            timeMin: atMidnight(window.from),
            timeMax: atMidnight(window.to),
            // Expand repeats into instances. Without this a weekly event arrives
            // as one master row with a recurrence rule and no usable dates.
            singleEvents: true,
            showDeleted: false,
            maxResults: EVENTS_PER_PAGE,
            orderBy: "startTime",
            pageToken,
          });

          for (const item of response.data.items ?? []) {
            found.push({
              id: item.id,
              status: item.status,
              summary: item.summary,
              recurringEventId: item.recurringEventId,
              start: item.start ? { date: item.start.date, dateTime: item.start.dateTime } : null,
              end: item.end ? { date: item.end.date, dateTime: item.end.dateTime } : null,
            });
          }

          pageToken = response.data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }

        return found;
      } catch (error) {
        throw toGoogleCalendarError(error, "listEvents");
      }
    },
  };
}

/* ============================================================
   WHAT A CALLER GETS BACK
   ============================================================ */

/** The three values `bookings.googleSync` can hold, as an outcome. */
export type SyncState = "none" | "synced" | "failed";

/**
 * The result of pushing one booking. Never an exception.
 *
 * `reason` is for the log and for a later screen, never for a sentence an owner
 * reads mid-approval — by the time this exists, the approval has already landed.
 */
export type SyncOutcome = {
  state: SyncState;
  /** The Google event id, when there is one. */
  eventId?: string | null;
  /** Which kind of failure, when `state` is `'failed'`. */
  kind?: GoogleErrorKind;
  /** Why nothing happened, when `state` is `'none'`. */
  reason?:
    | "not-configured"
    | "not-linked"
    | "no-calendar"
    | "nothing-to-do"
    | "removed"
    | "calendar-gone";
  /** An `auth` failure. The caller should stop calling Google for this house. */
  stop?: boolean;
};

/** What one pass of {@link pullBlocks} did. */
export type PullResult = {
  state: SyncState;
  /** Foreign all-day events that became new blocks. */
  imported: number;
  /** Imported blocks whose dates or title moved in Google. */
  updated: number;
  /** Blocks whose event is gone from the calendar, so the block went too. */
  removed: number;
  /** Events refused by `bookings_no_overlap` — they would have eaten a confirmed stay. */
  skipped: number;
  /**
   * Weeks this pass lost: an event that should have become — or moved, or
   * lifted — a block, and could not be written for a reason that is nobody's
   * decision. A dropped connection, a deadlock. Without this, a pull that
   * silently lost a week reads exactly like a calendar with nothing new on it.
   */
  failed: number;
  /** Events with a time of day. Not somebody staying in the house. */
  ignoredTimed: number;
  /**
   * All-day events carrying a range this app cannot use: no nights in it, or a
   * day that does not exist. Counted apart from {@link ignoredTimed}, because
   * "it had a time on it" is a different thing to explain to an owner.
   */
  ignoredUnusable: number;
  /** Instances of a repeating event — a birthday, not a fortnight in August. */
  ignoredRepeating: number;
  kind?: GoogleErrorKind;
  reason?: SyncOutcome["reason"];
};

/** What one pass of {@link retryFailedSyncs} did. */
export type RetryResult = {
  attempted: number;
  synced: number;
  /** Rows that turned out to need no event after all. */
  cleared: number;
  failed: number;
  /**
   * True when an `auth` failure cut a house's batch short. The pass carries on
   * to the next house: a revoked grant belongs to one owner, not to the cron.
   */
  stopped: boolean;
};

/* ============================================================
   INJECTION
   ============================================================ */

/**
 * The seam every test goes through.
 *
 * There are no Google credentials on this machine and there is no way to script
 * a consent screen, so the fake is not a convenience — it is the only way any of
 * this is exercised at all before an owner tries it for real.
 */
export type SyncDeps = {
  /** Build the transport. Tests pass `lib/google/fake.ts`. */
  client?: (tokens: GoogleTokens) => SyncCalendarClient;
  /** Today, as `YYYY-MM-DD`. Defaults to the server's clock. */
  today?: DateStr;
  /**
   * Override the credentials check. Defaults to `true` when a client is
   * injected — a test that hands over a transport has supplied the thing
   * `GOOGLE_CLIENT_ID` would have bought.
   */
  configured?: boolean;
};

function isConfigured(deps: SyncDeps): boolean {
  if (deps.configured !== undefined) return deps.configured;
  if (deps.client) return true;
  return isGoogleConfigured();
}

function today(deps: SyncDeps): DateStr {
  const given = deps.today;
  if (given && isDateStr(given)) return given;
  return toStr(new Date());
}

/* ============================================================
   TOKENS
   ============================================================ */

/** better-auth's own name for the provider. Its `account` rows key on this. */
const GOOGLE_PROVIDER = "google";

/** The Google half of an owner's better-auth account, if they have linked one. */
export type GoogleAccount = {
  tokens: GoogleTokens;
  scope: string | null;
  /** Enough of a grant to call Google at all. */
  usable: boolean;
};

/**
 * Read the owner's Google tokens out of better-auth's `account` table.
 *
 * Nothing bespoke stores these — `lib/auth.ts` writes them there on sign-in and
 * this is the only reader. `encryptOAuthTokens` is off, so they are plaintext
 * columns; that is better-auth's default and a decision for another slice.
 */
export async function googleAccount(ownerId: string): Promise<GoogleAccount | null> {
  const [row] = await db
    .select({
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.accessTokenExpiresAt,
      scope: account.scope,
    })
    .from(account)
    .where(and(eq(account.userId, ownerId), eq(account.providerId, GOOGLE_PROVIDER)))
    .limit(1);

  if (!row) return null;

  return {
    tokens: {
      accessToken: row.accessToken ?? null,
      refreshToken: row.refreshToken ?? null,
      expiresAt: row.expiresAt ?? null,
    },
    scope: row.scope ?? null,
    // A refresh token is what makes this work tomorrow; an access token alone
    // works until it expires, which is still worth trying.
    usable: Boolean(row.refreshToken ?? row.accessToken),
  };
}

/* ============================================================
   CONNECTING
   ============================================================ */

/** A house that is genuinely wired up: a transport and a calendar to point it at. */
export type Connection = {
  client: SyncCalendarClient;
  /** `null` when Google is reachable but no calendar has been chosen yet. */
  calendarId: string | null;
  scope: string | null;
};

/** Why a house is not connected. Each one is a state, not a fault. */
export type NotConnected = { reason: "not-configured" | "not-linked" | "no-calendar" };

export type ConnectionResult = Connection | NotConnected;

export function isConnected(result: ConnectionResult): result is Connection {
  return "client" in result;
}

/**
 * Everything needed to call Google for this house, or the reason there isn't.
 *
 * `requireCalendar` is `false` for the connect screen, which has to list
 * calendars *before* one has been chosen, and `true` for every sync path.
 *
 * The credential check comes before the database read on purpose: an
 * unconfigured deployment answers this without touching Postgres.
 */
export async function connectionFor(
  house: House,
  deps: SyncDeps = {},
  options: { requireCalendar?: boolean } = {},
): Promise<ConnectionResult> {
  const requireCalendar = options.requireCalendar ?? true;

  if (requireCalendar && !house.googleCalendarId) return { reason: "no-calendar" };
  if (!isConfigured(deps)) return { reason: "not-configured" };

  const linked = await googleAccount(house.ownerId);
  if (!linked || !linked.usable) return { reason: "not-linked" };

  const build = deps.client ?? realSyncClient;
  return {
    client: build(linked.tokens),
    calendarId: house.googleCalendarId,
    scope: linked.scope,
  };
}

/* ============================================================
   THE EVENT A BOOKING BECOMES
   ============================================================ */

/** Where a tapped event should take the owner. Same fallback chain as `lib/emails.ts`. */
function appUrl(): string {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3100";
  return url.replace(/\/+$/, "");
}

/**
 * The event title, on a calendar that may well be the owner's personal one.
 *
 * The house name leads, because in among school runs and dentists "Ada, 4" means
 * nothing by itself.
 */
function eventSummary(house: House, booking: Booking): string {
  const name = house.name.trim() || "The house";

  if (booking.kind === "block") {
    const note = booking.note?.trim();
    return note ? `${name} — ${note}` : `${name} — kept for us`;
  }

  const guest = booking.guestName?.trim() || "A guest";
  const count = booking.guests > 1 ? `, ${booking.guests}` : "";
  return `${name} — ${guest}${count}`;
}

function eventDescription(booking: Booking): string {
  const lines: string[] = [];
  const email = booking.guestEmail?.trim();
  const note = booking.note?.trim();
  if (email) lines.push(email);
  if (note) lines.push(note);
  lines.push(`${appUrl()}/app`);
  return lines.join("\n");
}

/**
 * The booking as an all-day event.
 *
 * `startDate` and `endDate` go on the wire unchanged. Google's all-day `end.date`
 * is exclusive and so is `bookings.end_date`, so there is no ±1 day here and
 * there must never be one — that fudge is the classic way an all-day integration
 * drifts by a night.
 *
 * Transparent, not busy: a fortnight at the house should not black out a
 * fortnight of the owner's working calendar. `lib/ics.ts` makes the same call.
 */
function eventFor(house: House, booking: Booking): CalendarEvent {
  return {
    summary: eventSummary(house, booking),
    description: eventDescription(booking),
    start: booking.startDate,
    end: booking.endDate,
    opaque: false,
  };
}

/* ============================================================
   POSTGRES
   ============================================================ */

/** `exclusion_violation` — here, only ever `bookings_no_overlap`. */
const EXCLUSION_VIOLATION = "23P01";
/** `unique_violation` — here, only ever two block tokens drawing the same. */
const UNIQUE_VIOLATION = "23505";

/**
 * Does this error, or anything it wraps, carry SQLSTATE `code`?
 *
 * Drizzle wraps every driver error in a `DrizzleQueryError` and hangs the
 * original off `cause`, so `error.code` is `undefined` at the top level. The
 * walk is bounded and only ever compares against the code asked for. Never
 * matches on message text — those are localised by `lc_messages`.
 *
 * The same shape as `hasPgCode` in `app/_actions/decision.ts`, deliberately
 * repeated rather than shared: that file's copy is the authority for the
 * approval path and this one runs after it, in a module the approval path must
 * not depend on for correctness.
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

/**
 * Writing the sync state must never be the thing that throws.
 *
 * Returns whether the write landed, because for one caller that is the
 * difference between a success and a lie: an event whose id was never stored is
 * an event the app can never patch, delete, or find again. See {@link push}.
 */
async function record(bookingId: string, patch: Partial<Booking>): Promise<boolean> {
  try {
    await db.update(bookings).set(patch).where(eq(bookings.id, bookingId));
    return true;
  } catch (error) {
    console.error("[sync] could not record sync state", error);
    return false;
  }
}

/**
 * The owner deleted the calendar in Google. Forget it, so the next pass reads
 * "not connected" and starts over instead of failing in the same place forever.
 */
async function forgetCalendar(houseId: string): Promise<void> {
  try {
    await db
      .update(houses)
      .set({ googleCalendarId: null })
      .where(eq(houses.id, houseId));
    // Every stored event id pointed into a calendar that no longer exists.
    await db
      .update(bookings)
      .set({ googleEventId: null, googleSync: "none" })
      .where(eq(bookings.houseId, houseId));
  } catch (error) {
    console.error("[sync] could not clear the calendar", error);
  }
}

/**
 * Point a house at a calendar, or at none.
 *
 * Every stored `googleEventId` is dropped in the same breath, because those ids
 * only mean anything inside the calendar that minted them. Leaving them behind
 * across a switch is what would make a later pull delete a block whose event
 * lives in the calendar the owner just walked away from.
 *
 * Unlike everything else in this file, this one is allowed to throw: it runs
 * from an owner pressing a button, and if it did not save they should be told.
 */
export async function setHouseCalendar(
  houseId: string,
  calendarId: string | null,
): Promise<void> {
  await db.update(houses).set({ googleCalendarId: calendarId }).where(eq(houses.id, houseId));
  await db
    .update(bookings)
    .set({ googleEventId: null, googleSync: "none" })
    .where(eq(bookings.houseId, houseId));
}

/** How the house's stays have fared on the way to Google. Both numbers, one query. */
export type SyncCounts = {
  /** Stays that reached the calendar. */
  synced: number;
  /** Stays that were said yes to and did not. `retryFailedSyncs` comes back for these. */
  failed: number;
};

/**
 * What the settings screen can honestly say about a connected house.
 *
 * There is no `lastSyncedAt` column anywhere in this schema, so the screen
 * cannot say when anything last went out and no longer pretends to. What it can
 * say is how many stays are on the calendar and how many are not, both of which
 * are one `GROUP BY` over a column that already exists.
 *
 * Total, like everything else in this file: a database that will not answer
 * returns zeroes and a log line rather than taking the settings page down with
 * it. Two zeroes read as "nothing has gone out yet", which is the least wrong
 * thing to say when we genuinely do not know.
 */
export async function syncCounts(houseId: string): Promise<SyncCounts> {
  try {
    const rows = await db
      .select({ status: bookings.googleSync, n: count() })
      .from(bookings)
      .where(eq(bookings.houseId, houseId))
      .groupBy(bookings.googleSync);

    let synced = 0;
    let failed = 0;
    for (const row of rows) {
      if (row.status === "synced") synced = Number(row.n) || 0;
      else if (row.status === "failed") failed = Number(row.n) || 0;
    }
    return { synced, failed };
  } catch (error) {
    console.error("[sync] could not count what has gone out", error);
    return { synced: 0, failed: 0 };
  }
}

/* ============================================================
   APP → GOOGLE
   ============================================================ */

/** Anything thrown, as one of the four kinds. */
function asGoogleError(error: unknown, operation: string): GoogleCalendarError {
  if (isGoogleCalendarError(error)) return error;
  return toGoogleCalendarError(error, operation);
}

type PushOptions = {
  /** `false` after `unblockDates` — the row is gone, so there is nothing to write to. */
  rowExists?: boolean;
  /** Force removal regardless of status, for a row that has just been deleted. */
  remove?: boolean;
};

/**
 * A `404` from `events.delete` names two things at once — the event, and the
 * calendar it was on. Ask Google which of the two went missing.
 *
 * One `events.list` over a single day is the cheapest question this client can
 * put, and it is only ever asked on that ambiguous 404. Anything other than
 * `notFound` coming back is treated as "the calendar is there": a rate limit or
 * a dead token says nothing about whether it exists, and disconnecting a house
 * over a blip would be far worse than leaving a stale id one more pass.
 */
async function calendarIsGone(
  connection: Connection,
  calendarId: string,
  day: DateStr,
): Promise<boolean> {
  try {
    await connection.client.listEvents(calendarId, { from: day, to: addDaysStr(day, 1) });
    return false;
  } catch (error) {
    return asGoogleError(error, "listEvents").kind === "notFound";
  }
}

/**
 * The event was created but its id could not be stored. Take it back off the
 * calendar.
 *
 * A row that does not hold the id can never patch or delete that event again,
 * so leaving it there orphans it on the owner's calendar forever — and the next
 * pass, seeing a row with no event, would insert a second one beside it.
 * Best effort: if this fails too, the log is all that is left.
 */
async function unwind(connection: Connection, calendarId: string, eventId: string): Promise<void> {
  try {
    await connection.client.deleteEvent(calendarId, eventId);
  } catch (error) {
    console.error(`[sync] could not take back event ${eventId}`, error);
  }
}

async function fail(
  booking: Booking,
  error: GoogleCalendarError,
  rowExists: boolean,
): Promise<SyncOutcome> {
  console.error(
    `[sync] ${error.operation ?? "google"} failed for booking ${booking.id}: ${error.kind}`,
    error,
  );
  if (rowExists) await record(booking.id, { googleSync: "failed" });
  return { state: "failed", kind: error.kind, stop: error.kind === "auth" };
}

/**
 * Make the calendar agree with one booking. The core of the app → Google half.
 *
 * Confirmed rows want an event; everything else wants none. The three moves —
 * insert, patch, delete — fall out of that and the presence of a stored event id,
 * so there is no separate "update" entry point that could disagree with "create".
 */
async function push(
  connection: Connection,
  house: House,
  booking: Booking,
  options: PushOptions = {},
): Promise<SyncOutcome> {
  const rowExists = options.rowExists ?? true;
  const calendarId = connection.calendarId;
  if (!calendarId) return { state: "none", reason: "no-calendar" };

  const wanted = !options.remove && booking.status === "confirmed";
  const eventId = booking.googleEventId;

  /* --- the dates are not held any more --- */

  if (!wanted) {
    if (!eventId) {
      // Nothing to take off the calendar — but the row may be sitting in the
      // retry queue from an earlier failure, and a row that needs no event is
      // never going to leave that queue on its own. Say so, once.
      if (rowExists && booking.googleSync !== "none") {
        await record(booking.id, { googleSync: "none" });
      }
      return { state: "none", reason: "nothing-to-do" };
    }
    try {
      await connection.client.deleteEvent(calendarId, eventId);
    } catch (error) {
      const failure = asGoogleError(error, "deleteEvent");
      // A delete that fails because the event is already gone has, in every
      // sense that matters, succeeded.
      if (failure.kind !== "notFound") return fail(booking, failure, rowExists);
      // `410 Gone` is Google answering *for* the event: it was there, it is not
      // now, and the calendar is plainly still around to say so. A plain 404
      // does not say which of the two is missing, so ask before believing it.
      if (
        failure.status !== 410 &&
        (await calendarIsGone(connection, calendarId, booking.startDate))
      ) {
        await forgetCalendar(house.id);
        return { state: "none", reason: "calendar-gone" };
      }
    }
    if (rowExists) {
      // A lost write here is survivable and deliberately not reported as a
      // failure: the event is off the calendar, and a row left holding its id
      // only ever produces one more delete that answers "already gone".
      await record(booking.id, { googleEventId: null, googleSync: "none" });
    }
    return { state: "none", reason: "removed" };
  }

  /* --- it already has an event: move it rather than make a second one --- */

  if (eventId) {
    let moved = false;
    try {
      await connection.client.patchEvent(calendarId, eventId, eventFor(house, booking));
      moved = true;
    } catch (error) {
      const failure = asGoogleError(error, "patchEvent");
      // Anything but `notFound` is a real failure. `notFound` means the owner
      // deleted the event by hand, and the honest repair is to put it back.
      if (failure.kind !== "notFound") return fail(booking, failure, rowExists);
    }

    if (moved) {
      // The row still holds the right id either way, so nothing is orphaned —
      // but it also still reads `'failed'`, and a caller told `'synced'` would
      // be told something the database does not agree with.
      if (rowExists && !(await record(booking.id, { googleSync: "synced" }))) {
        return { state: "failed", kind: "other", stop: false };
      }
      return { state: "synced", eventId };
    }
  }

  /* --- no event yet, or the old one is gone --- */

  let created: { eventId: string };
  try {
    created = await connection.client.insertEvent(calendarId, eventFor(house, booking));
  } catch (error) {
    const failure = asGoogleError(error, "insertEvent");
    if (failure.kind === "notFound") {
      // An insert cannot fail for a missing *event*. The calendar itself is gone.
      await forgetCalendar(house.id);
      return { state: "none", reason: "calendar-gone" };
    }
    return fail(booking, failure, rowExists);
  }

  // The id is the only thread back to this event. An operation whose id was
  // never written down has not succeeded, whatever the calendar now shows.
  if (rowExists && !(await record(booking.id, { googleEventId: created.eventId, googleSync: "synced" }))) {
    await unwind(connection, calendarId, created.eventId);
    return { state: "failed", kind: "other", stop: false };
  }

  return { state: "synced", eventId: created.eventId };
}

/**
 * Put a decision on the calendar. Called after the booking has committed.
 *
 * **This cannot fail in a way the caller has to handle.** Every path returns a
 * {@link SyncOutcome}; nothing throws. A house with no calendar, a deployment
 * with no credentials, an owner who never linked Google — all of them are
 * `'none'`, silently, with zero Google calls.
 */
export async function syncBooking(
  booking: Booking,
  house: House,
  deps: SyncDeps = {},
  options: PushOptions = {},
): Promise<SyncOutcome> {
  try {
    const connection = await connectionFor(house, deps);
    if (!isConnected(connection)) return { state: "none", reason: connection.reason };
    return await push(connection, house, booking, options);
  } catch (error) {
    // The catch-all that makes the promise above true. Nothing outside this
    // module guarantees only typed errors reach here.
    console.error("[sync] unexpected failure", error);
    if (options.rowExists !== false) await record(booking.id, { googleSync: "failed" });
    return { state: "failed", kind: "other" };
  }
}

/**
 * The row is gone — `unblockDates` deleted it. Take its event off the calendar.
 *
 * Separate from {@link syncBooking} only because there is nothing left to write
 * the outcome to: marking a deleted row `'failed'` would update zero rows and
 * mean nothing.
 */
export async function syncRemovedBooking(
  booking: Booking,
  house: House,
  deps: SyncDeps = {},
): Promise<SyncOutcome> {
  return syncBooking(booking, house, deps, { remove: true, rowExists: false });
}

/* ============================================================
   GOOGLE → APP
   ============================================================ */

/** How far ahead a pull looks. Two summers, which is as far as anyone plans. */
const PULL_AHEAD_DAYS = 540;

/**
 * The half-open range of an **all-day** event, or `null` if it is anything else.
 *
 * This one function is the answer to *"not hourly stuff like that"*. Google
 * fills in `start.date` for an all-day event and `start.dateTime` for one with a
 * time of day, never both. A 3pm meeting has a `dateTime` and returns `null`
 * here, and that is the whole filter.
 *
 * The range needs no adjustment: Google's all-day `end.date` is exclusive and so
 * is `bookings.end_date`.
 */
export function allDayRange(event: GoogleEvent): { start: DateStr; end: DateStr } | null {
  const start = event.start?.date;
  const end = event.end?.date;
  if (!start || !end) return null;
  if (!isDateStr(start) || !isDateStr(end)) return null;
  if (nightsBetween(start, end) <= 0) return null;
  return { start, end };
}

function overlapsWindow(row: Booking, window: EventWindow): boolean {
  return row.startDate < window.to && row.endDate > window.from;
}

/**
 * Weeks that were promised before this app existed.
 *
 * Reads the chosen calendar and turns every foreign all-day event into a
 * `kind: 'block'`, `status: 'confirmed'` booking, so the guest page shows those
 * days as taken. Ignores anything with a time of day, and ignores instances of a
 * repeating event — an annual birthday is not a fortnight in August, and a
 * birthday that quietly ate a night every summer would be the kind of bug that
 * makes an owner stop trusting the calendar.
 *
 * ### An imported block can never destroy a confirmed stay
 *
 * `bookings_no_overlap` refuses an overlapping confirmed insert with SQLSTATE
 * `23P01`. That refusal is caught, counted in `skipped`, and the pull carries on.
 * The guest keeps their week; the owner can see the clash in Google and decide.
 * There is deliberately no code path where an event from a calendar can delete a
 * `kind: 'guest'` row.
 *
 * ### How a block knows it came from Google, and where that is still thin
 *
 * By carrying a `googleEventId` on a `kind: 'block'` row — and that marker means
 * two different things. {@link push} writes the same column when a block the
 * owner made **in the app** is sent out to the calendar, so from the removal
 * loop's point of view the two are identical, and an owner who deletes that
 * event in Google loses the block they made here.
 *
 * The fix is a column of its own — `bookings.imported_from_google`, set on
 * import and required by the removal loop — which `db/schema.ts` does not have
 * yet. It is a one-line schema change plus one line in every fixture built from
 * `Booking`, including one in `app/_actions/decision.test.ts`.
 *
 * Never throws.
 */
export async function pullBlocks(house: House, deps: SyncDeps = {}): Promise<PullResult> {
  const empty: PullResult = {
    state: "none",
    imported: 0,
    updated: 0,
    removed: 0,
    skipped: 0,
    failed: 0,
    ignoredTimed: 0,
    ignoredUnusable: 0,
    ignoredRepeating: 0,
  };

  try {
    const connection = await connectionFor(house, deps);
    if (!isConnected(connection)) return { ...empty, reason: connection.reason };

    const calendarId = connection.calendarId;
    if (!calendarId) return { ...empty, reason: "no-calendar" };

    const from = today(deps);
    const window: EventWindow = { from, to: addDaysStr(from, PULL_AHEAD_DAYS) };

    let events: GoogleEvent[];
    try {
      events = await connection.client.listEvents(calendarId, window);
    } catch (error) {
      const failure = asGoogleError(error, "listEvents");
      if (failure.kind === "notFound") {
        await forgetCalendar(house.id);
        return { ...empty, reason: "calendar-gone" };
      }
      console.error(`[sync] could not read the calendar for house ${house.id}`, failure);
      return { ...empty, state: "failed", kind: failure.kind };
    }

    /* --- what came back, sorted into the two kinds that matter --- */

    const result: PullResult = { ...empty, state: "synced" };
    const importable = new Map<string, { start: DateStr; end: DateStr; summary: string | null }>();

    for (const event of events) {
      const id = event.id?.trim();
      if (!id) continue;
      if (event.status === "cancelled") continue;
      if (event.recurringEventId) {
        result.ignoredRepeating++;
        continue;
      }
      const range = allDayRange(event);
      if (!range) {
        // A time of day is somebody's meeting, not somebody's summer — and it
        // is the reason this filter exists, so it is counted as itself rather
        // than lumped in with an all-day event whose range made no sense.
        if (event.start?.dateTime || event.end?.dateTime) result.ignoredTimed++;
        else result.ignoredUnusable++;
        continue;
      }
      importable.set(id, { ...range, summary: event.summary ?? null });
    }

    /* --- what the app already knows about --- */

    const known = await db
      .select()
      .from(bookings)
      .where(and(eq(bookings.houseId, house.id), isNotNull(bookings.googleEventId)));

    const byEvent = new Map<string, Booking>();
    for (const row of known) {
      if (row.googleEventId) byEvent.set(row.googleEventId, row);
    }

    /* --- events the app has not seen become blocks --- */

    for (const [eventId, event] of importable) {
      const existing = byEvent.get(eventId);

      if (!existing) {
        const inserted = await importBlock(house.id, eventId, event);
        if (inserted === "ok") result.imported++;
        else if (inserted === "overlap") result.skipped++;
        else result.failed++;
        continue;
      }

      // A row we pushed for a guest's stay. Google is not the authority on those.
      if (existing.kind !== "block") continue;

      // Only what actually changed is written, so an owner who moved a week and
      // an owner who tidied up its title are two different statements.
      const patch: Partial<Booking> = {};
      if (existing.startDate !== event.start || existing.endDate !== event.end) {
        patch.startDate = event.start;
        patch.endDate = event.end;
      }
      const note = noteFrom(event.summary);
      // The title is the whole reason it was copied across — "Ayşe teyze" is how
      // the owner recognises the week — so it follows the rename.
      if (existing.note !== note) patch.note = note;
      if (Object.keys(patch).length === 0) continue;

      try {
        await db
          .update(bookings)
          .set(patch)
          .where(and(eq(bookings.id, existing.id), eq(bookings.kind, "block")));
        result.updated++;
      } catch (error) {
        if (hasPgCode(error, EXCLUSION_VIOLATION)) {
          result.skipped++;
          continue;
        }
        console.error(`[sync] could not move block ${existing.id}`, error);
        result.failed++;
      }
    }

    /* --- events that are gone take their block with them --- */

    for (const row of known) {
      if (row.kind !== "block") continue;
      // Only blocks that CAME FROM Google. A block the owner made in the app is
      // also given an event id the moment it is pushed out, so `googleEventId`
      // alone cannot tell the two apart — and deleting that event in Google
      // would then lift a block the owner made by hand.
      if (!row.importedFromGoogle) continue;
      if (!row.googleEventId) continue;
      if (importable.has(row.googleEventId)) continue;
      // Only rows the pull actually asked Google about. A block next August is
      // not evidence of anything when the window stopped in June.
      if (!overlapsWindow(row, window)) continue;

      try {
        await db
          .delete(bookings)
          .where(and(eq(bookings.id, row.id), eq(bookings.kind, "block")));
        result.removed++;
      } catch (error) {
        console.error(`[sync] could not lift block ${row.id}`, error);
        result.failed++;
      }
    }

    return result;
  } catch (error) {
    console.error("[sync] pull failed", error);
    return { ...empty, state: "failed", kind: "other" };
  }
}

/**
 * The event's own title, as a block's note.
 *
 * So the owner opening the app reads "Ayşe teyze" and recognises the week
 * rather than wondering who took it. Bounded, because `note` is a `text` column
 * an owner also reads on a card.
 */
function noteFrom(summary: string | null): string | null {
  return summary?.trim().slice(0, 300) || null;
}

/**
 * One foreign event, as a block.
 *
 * Answers with what happened rather than throwing. `"overlap"` is a decision —
 * the dates hold a confirmed stay and the guest keeps them. `"error"` is a week
 * that was lost, which the caller counts rather than passing over in silence.
 */
async function importBlock(
  houseId: string,
  eventId: string,
  event: { start: DateStr; end: DateStr; summary: string | null },
): Promise<"ok" | "overlap" | "error"> {
  const note = noteFrom(event.summary);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await db.insert(bookings).values({
        houseId,
        kind: "block",
        guests: 1,
        note,
        startDate: event.start,
        endDate: event.end,
        status: "confirmed",
        // Never read — a block has no guest page — but the column is unique for
        // everything in the table.
        token: newToken(),
        decidedAt: new Date(),
        googleEventId: eventId,
        googleSync: "synced",
        // The marker the removal loop requires. Without it this block is
        // indistinguishable from one the owner made in the app.
        importedFromGoogle: true,
      });
      return "ok";
    } catch (error) {
      // The dates hold a confirmed stay. The guest keeps them; this event does
      // not become a block, and the pull carries on.
      if (hasPgCode(error, EXCLUSION_VIOLATION)) return "overlap";
      if (hasPgCode(error, UNIQUE_VIOLATION)) continue;
      console.error(`[sync] could not import event ${eventId}`, error);
      return "error";
    }
  }

  return "error";
}

/* ============================================================
   THE CRON'S TWO ENTRY POINTS
   ============================================================ */

/**
 * Come back for the rows Google refused earlier.
 *
 * Grouped by house so one connection — and therefore one token refresh — covers
 * every row on it. An `auth` failure stops that house's batch on the spot: the
 * grant is dead, the next call would fail identically, and a cron that keeps
 * asking is how an OAuth client gets throttled.
 *
 * Houses with no calendar are not in the query at all. A disconnected house has
 * nothing to retry, and `setHouseCalendar` has already reset its rows.
 *
 * Never throws.
 */
export async function retryFailedSyncs(limit = 20, deps: SyncDeps = {}): Promise<RetryResult> {
  const result: RetryResult = { attempted: 0, synced: 0, cleared: 0, failed: 0, stopped: false };

  try {
    const rows = await db
      .select({ booking: bookings, house: houses })
      .from(bookings)
      .innerJoin(houses, eq(bookings.houseId, houses.id))
      .where(and(eq(bookings.googleSync, "failed"), isNotNull(houses.googleCalendarId)))
      .orderBy(asc(bookings.createdAt))
      .limit(Math.max(1, Math.min(limit, 200)));

    /* --- one connection per house, not one per row --- */

    const byHouse = new Map<string, { house: House; queue: Booking[] }>();
    for (const row of rows) {
      const bucket = byHouse.get(row.house.id) ?? { house: row.house, queue: [] };
      bucket.queue.push(row.booking);
      byHouse.set(row.house.id, bucket);
    }

    for (const { house, queue } of byHouse.values()) {
      const connection = await connectionFor(house, deps);
      if (!isConnected(connection)) continue;

      for (const booking of queue) {
        result.attempted++;
        const outcome = await push(connection, house, booking);

        if (outcome.state === "synced") result.synced++;
        else if (outcome.state === "failed") result.failed++;
        else result.cleared++;

        if (outcome.stop) {
          // This owner's token is dead. Stop asking on their behalf — and only
          // on their behalf. The next house is a different owner with a
          // different grant, and one revoked consent must not be able to hold
          // up everybody else's recovery.
          result.stopped = true;
          break;
        }
        if (outcome.reason === "calendar-gone") break;
      }
    }

    return result;
  } catch (error) {
    console.error("[sync] retry pass failed", error);
    return result;
  }
}
