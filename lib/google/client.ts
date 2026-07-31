/**
 * The real Google Calendar client, and the mapper that makes its failures legible.
 *
 * **This file has never been run against live Google.** It was written and
 * unit-tested against a fake (`lib/google/fake.ts`) while there were no
 * credentials to run it with, so every call signature here was checked against
 * the discovery document vendored in `googleapis@173.0.0` rather than recalled:
 *
 * | This client      | googleapis call                                              |
 * |------------------|--------------------------------------------------------------|
 * | `createCalendar` | `calendar.calendars.insert({ requestBody })` → `Schema$Calendar` |
 * | `insertEvent`    | `calendar.events.insert({ calendarId, requestBody })` → `Schema$Event` |
 * | `patchEvent`     | `calendar.events.patch({ calendarId, eventId, requestBody })` |
 * | `deleteEvent`    | `calendar.events.delete({ calendarId, eventId })`             |
 *
 * The one signature that has genuinely drifted and is easy to get wrong from
 * memory: `new google.auth.OAuth2(clientId, clientSecret, redirectUri)` — three
 * positional arguments — is deprecated in `google-auth-library` v10. The
 * options object is what this file uses.
 *
 * ### Nothing here runs at import time
 *
 * There are no credentials on this machine and there may never be any on a
 * given deployment. So:
 *
 * - `process.env` is read inside {@link googleCredentials}, per call, never at
 *   module scope. Importing this file with an empty `.env.local` is a no-op.
 * - `googleapis` is loaded with a **dynamic import**, and only after the
 *   credentials check has passed. An unconfigured app never pays for the
 *   library, and the test suite never loads the real one at all — `client.test.ts`
 *   replaces the module with a stand-in shaped from the same discovery document,
 *   which is how the request bodies below are asserted without a network.
 * - {@link googleClient} itself cannot throw. A missing client id surfaces on
 *   the first call as a normal `auth` failure, which is exactly the path the
 *   sync layer already has to handle for a revoked token.
 *
 * Callers that want to skip the work entirely should ask {@link isGoogleConfigured}
 * first — a house with no integration should record `googleSync: 'none'`, not
 * `'failed'`.
 */

import type { calendar_v3 } from "googleapis";

import {
  GoogleCalendarError,
  isGoogleCalendarError,
  type CalendarClient,
  type CalendarEvent,
  type CalendarEventPatch,
  type GoogleErrorKind,
  type GoogleTokens,
} from "@/lib/google/types";

/* ============================================================
   CREDENTIALS
   ============================================================ */

/** Google's own name for "the refresh token is dead". Worth recognising by sight. */
const INVALID_GRANT = "invalid_grant";

/** Read when a call is made, never when the module loads. */
export type GoogleCredentials = { clientId: string; clientSecret: string };

/**
 * The OAuth client this deployment is registered as, or `null` if it has none.
 *
 * Blank strings count as absent: `.env.local` ships with `GOOGLE_CLIENT_ID=`
 * present and empty, and an empty string is a much more likely configuration
 * than a missing key.
 */
export function googleCredentials(
  overrides: Partial<GoogleCredentials> = {},
): GoogleCredentials | null {
  const clientId = (overrides.clientId ?? process.env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (overrides.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Can this deployment talk to Google at all?
 *
 * The honest question to ask before offering an owner a **Connect Google
 * Calendar** button, and before recording a sync failure that is really a
 * missing environment variable.
 */
export function isGoogleConfigured(): boolean {
  return googleCredentials() !== null;
}

/* ============================================================
   ERRORS
   ============================================================ */

/**
 * 403s that mean "slow down", not "you may not".
 *
 * Google Calendar answers a burst with 403 far more often than 429, and the
 * only thing separating it from a genuine permission failure is this string.
 * Getting it wrong in either direction is expensive: read a rate limit as an
 * auth failure and the app tells an owner to reconnect a perfectly good
 * account; read an auth failure as a rate limit and the cron retries a dead
 * token forever.
 */
const RATE_REASONS = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
  "quotaExceeded",
  "dailyLimitExceeded",
  "backendQuotaExceededError",
  // The AIP-193 spelling, which arrives as `error.status` rather than a reason.
  "RESOURCE_EXHAUSTED",
]);

/**
 * Reasons that mean the grant is gone, whatever status carried them.
 *
 * `invalid_grant` is the important one and it does **not** arrive as a 401. A
 * revoked or expired refresh token fails at Google's *token* endpoint, which
 * answers **400** with `{"error": "invalid_grant"}`. Classified by status alone
 * that is an `other`, the cron retries it forever, and the owner is never told
 * to reconnect — which is the single failure this table exists to prevent.
 */
const AUTH_REASONS = new Set([
  INVALID_GRANT,
  "invalid_client",
  "invalid_token",
  "unauthorized_client",
  "insufficient_scope",
  "invalid_scope",
  "access_denied",
  "authError",
  "insufficientPermissions",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
]);

/** AIP-193 spelling of a 404, in case the status is missing. */
const NOT_FOUND_REASONS = new Set(["NOT_FOUND", "notFound"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pick(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * The HTTP status, from wherever this particular error decided to keep it.
 *
 * Gaxios v7 puts it on `status`; older shapes and hand-written test fixtures use
 * `response.status`; the JSON body repeats it at `error.code`. `code` at the top
 * level is a `string | number` union — `'ECONNRESET'` for a socket fault, a
 * number only when it came from an API-level error — so it is read last and
 * only when numeric.
 */
function readStatus(error: unknown): number | undefined {
  const response = pick(error, "response");
  const body = pick(response, "data");
  return (
    asNumber(pick(error, "status")) ??
    asNumber(pick(response, "status")) ??
    asNumber(pick(pick(body, "error"), "code")) ??
    asNumber(pick(error, "code"))
  );
}

/**
 * Every machine-readable reason this error carries, most specific first.
 *
 * Google has at least four spellings depending on which endpoint answered:
 * `error.errors[].reason` from the classic JSON API, `error.status` from
 * AIP-193, a bare `error` string from the OAuth token endpoint, and Node's own
 * `code` for a socket that never got a response.
 */
function readReasons(error: unknown): string[] {
  const body = pick(pick(error, "response"), "data");
  const inner = pick(body, "error");
  const reasons: string[] = [];

  const errors = pick(inner, "errors");
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const reason = asString(pick(entry, "reason"));
      if (reason) reasons.push(reason);
    }
  }

  const aipStatus = asString(pick(inner, "status"));
  if (aipStatus) reasons.push(aipStatus);

  // `{"error": "invalid_grant"}` — the OAuth token endpoint's whole answer.
  const bare = asString(inner);
  if (bare) reasons.push(bare);

  const nodeCode = asString(pick(error, "code"));
  if (nodeCode) reasons.push(nodeCode);

  return reasons;
}

function readMessage(error: unknown): string {
  const body = pick(pick(error, "response"), "data");
  const inner = pick(body, "error");
  return (
    asString(pick(inner, "message")) ??
    asString(pick(body, "error_description")) ??
    asString(pick(error, "message")) ??
    (typeof error === "string" ? error : "Google Calendar refused the request.")
  );
}

/**
 * Turn anything a Google call threw into one of four kinds.
 *
 * The order of the checks is the whole design. Reasons are read **before**
 * status, because the reason is the more reliable signal in both directions
 * that matter: a rate limit dressed as a 403, and a revoked token dressed as a
 * 400. Status is the fallback for everything with no reason at all.
 *
 * 410 joins 404 as `notFound`. Google answers a second `events.delete` on an
 * already-deleted event with **410 Gone**, and an owner who tidies up the
 * calendar by hand produces exactly that. Treating it as a fault would mark a
 * booking `failed` for having successfully reached the state it wanted.
 *
 * Anything already typed passes through untouched, so wrapping is idempotent.
 */
export function toGoogleCalendarError(error: unknown, operation?: string): GoogleCalendarError {
  if (isGoogleCalendarError(error)) return error;

  const status = readStatus(error);
  const reasons = readReasons(error);
  const reason = reasons[0];
  const message = readMessage(error);

  const kind = classify(status, reasons);

  return new GoogleCalendarError(kind, message, { status, reason, operation, cause: error });
}

function classify(status: number | undefined, reasons: string[]): GoogleErrorKind {
  if (reasons.some((r) => AUTH_REASONS.has(r))) return "auth";
  if (reasons.some((r) => RATE_REASONS.has(r))) return "rateLimit";
  if (reasons.some((r) => NOT_FOUND_REASONS.has(r))) return "notFound";

  if (status === 401 || status === 403) return "auth";
  if (status === 404 || status === 410) return "notFound";
  if (status === 429) return "rateLimit";

  return "other";
}

/* ============================================================
   CONNECTING
   ============================================================ */

export type GoogleClientOptions = Partial<GoogleCredentials> & {
  /**
   * Called whenever the library mints a fresh access token off the refresh
   * token, so the caller can write it back to better-auth's `account` row.
   *
   * Optional, and skipping it costs correctness nothing — the next call simply
   * refreshes again. It saves a round trip, not a failure.
   */
  onTokens?: (tokens: GoogleTokens) => void;
};

/** better-auth stores a `Date`; Google wants milliseconds. */
function expiryMs(expiresAt: GoogleTokens["expiresAt"]): number | undefined {
  if (expiresAt == null) return undefined;
  const ms = expiresAt instanceof Date ? expiresAt.getTime() : expiresAt;
  return Number.isFinite(ms) ? ms : undefined;
}

/** The message an owner never sees and an operator needs immediately. */
const MISSING_CREDENTIALS =
  "Google is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET. See SETUP-GOOGLE.md.";

/**
 * Build the authenticated Calendar API, importing `googleapis` only now.
 *
 * The credentials check comes first deliberately: on a deployment with no
 * integration this function throws without ever loading a megabyte of client
 * library, and the unit tests exercise that path without pulling `googleapis`
 * into the test process.
 */
async function connect(
  tokens: GoogleTokens,
  options: GoogleClientOptions,
  operation: string,
): Promise<calendar_v3.Calendar> {
  const credentials = googleCredentials(options);
  if (!credentials) {
    // `operation` is whichever call ran first, because a failed connection is
    // not cached and each caller therefore builds its own. Without it the log
    // line for an unconfigured deployment names no call at all.
    throw new GoogleCalendarError("auth", MISSING_CREDENTIALS, {
      reason: "missingCredentials",
      operation,
    });
  }

  const { google } = await import("googleapis");

  // Positional arguments here are deprecated in google-auth-library v10.
  const auth = new google.auth.OAuth2({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
  });

  auth.setCredentials({
    access_token: tokens.accessToken ?? undefined,
    refresh_token: tokens.refreshToken ?? undefined,
    expiry_date: expiryMs(tokens.expiresAt),
  });

  const { onTokens } = options;
  if (onTokens) {
    // Typed structurally rather than importing google-auth-library's
    // `Credentials`: it is a transitive dependency, so under pnpm it is not
    // resolvable from this package.
    auth.on(
      "tokens",
      (fresh: {
        access_token?: string | null;
        refresh_token?: string | null;
        expiry_date?: number | null;
      }) => {
        onTokens({
          accessToken: fresh.access_token ?? null,
          // Google only re-sends the refresh token on first consent. Keeping the
          // one we already hold is the difference between a working integration
          // and one that dies the first time it refreshes.
          refreshToken: fresh.refresh_token ?? tokens.refreshToken ?? null,
          expiresAt: fresh.expiry_date ?? null,
        });
      },
    );
  }

  return google.calendar({ version: "v3", auth });
}

/* ============================================================
   REQUEST BODIES
   ============================================================ */

/**
 * The half-open range goes on the wire unchanged.
 *
 * Google's all-day `end.date` is exclusive and so is `bookings.end_date`, so
 * there is no ±1 adjustment here and there must never be one. A stay of
 * 2026-08-01 → 2026-08-08 is seven nights in the database, seven nights in the
 * `.ics`, and seven days on the calendar.
 */
function toEventBody(event: CalendarEvent): calendar_v3.Schema$Event {
  return {
    ...toPatchBody(event),
    start: { date: event.start },
    end: { date: event.end },
    transparency: event.opaque ? "opaque" : "transparent",
  };
}

/** Only the fields the caller actually set. `events.patch` leaves the rest alone. */
function toPatchBody(patch: CalendarEventPatch): calendar_v3.Schema$Event {
  const body: calendar_v3.Schema$Event = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.start !== undefined) body.start = { date: patch.start };
  if (patch.end !== undefined) body.end = { date: patch.end };
  if (patch.opaque !== undefined) body.transparency = patch.opaque ? "opaque" : "transparent";
  return body;
}

/**
 * These events carry no attendees, so Google would send nothing anyway — but
 * saying so out loud means that adding an attendee later cannot accidentally
 * mail a guest a Google invite. The guest's invite is the `.ics` on their
 * confirmation email, and it is meant to stay the only one.
 */
const NO_NOTIFICATIONS = "none";

/* ============================================================
   THE CLIENT
   ============================================================ */

/**
 * A {@link CalendarClient} backed by real Google, for the tokens given.
 *
 * Cheap and total: it allocates a closure and reads nothing. The connection —
 * env lookup, `googleapis` import, OAuth client — happens on the first call and
 * is then reused, so three operations on one instance share one auth client and
 * therefore one token refresh. A failed connection is not cached, so a
 * transient fault does not poison the instance.
 */
export function googleClient(
  tokens: GoogleTokens,
  options: GoogleClientOptions = {},
): CalendarClient {
  let connecting: Promise<calendar_v3.Calendar> | null = null;

  function api(operation: string): Promise<calendar_v3.Calendar> {
    connecting ??= connect(tokens, options, operation).catch((error: unknown) => {
      connecting = null;
      throw error;
    });
    return connecting;
  }

  /** One place where an unknown throw becomes a {@link GoogleCalendarError}. */
  async function run<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw toGoogleCalendarError(error, operation);
    }
  }

  return {
    createCalendar(summary) {
      return run("createCalendar", async () => {
        const calendar = await api("createCalendar");
        const response = await calendar.calendars.insert({ requestBody: { summary } });
        const calendarId = response.data.id;
        if (!calendarId) {
          throw new GoogleCalendarError("other", "Google created a calendar without an id.", {
            operation: "createCalendar",
          });
        }
        return { calendarId };
      });
    },

    insertEvent(calendarId, event) {
      return run("insertEvent", async () => {
        const calendar = await api("insertEvent");
        const response = await calendar.events.insert({
          calendarId,
          sendUpdates: NO_NOTIFICATIONS,
          requestBody: toEventBody(event),
        });
        const eventId = response.data.id;
        if (!eventId) {
          throw new GoogleCalendarError("other", "Google created an event without an id.", {
            operation: "insertEvent",
          });
        }
        return { eventId };
      });
    },

    patchEvent(calendarId, eventId, event) {
      return run("patchEvent", async () => {
        const calendar = await api("patchEvent");
        await calendar.events.patch({
          calendarId,
          eventId,
          sendUpdates: NO_NOTIFICATIONS,
          requestBody: toPatchBody(event),
        });
      });
    },

    deleteEvent(calendarId, eventId) {
      return run("deleteEvent", async () => {
        const calendar = await api("deleteEvent");
        await calendar.events.delete({
          calendarId,
          eventId,
          sendUpdates: NO_NOTIFICATIONS,
        });
      });
    },
  };
}
