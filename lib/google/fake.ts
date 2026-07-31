/**
 * A {@link CalendarClient} that keeps a Google Calendar in a `Map`.
 *
 * There are no Google credentials on this machine and the consent screen is not
 * scriptable, so the real client in `lib/google/client.ts` has never been run
 * against live Google. This file is what every test runs instead — and what the
 * sync layer is developed against, so the seam stays honest rather than being a
 * seam only a test ever uses.
 *
 * It is deliberately more than a stub:
 *
 * - **It refuses what Google refuses.** An event on a calendar that does not
 *   exist, a backwards date range, a half-specified patch — each fails here with
 *   the same {@link GoogleErrorKind} the real API would produce. A fake that
 *   accepts everything teaches the caller nothing.
 * - **It remembers deletions.** Deleting the same event twice answers `410
 *   Gone`, exactly as Google does, so "delete is idempotent" is a property the
 *   sync layer can actually test rather than assume.
 * - **It can be made to fail on demand.** {@link FakeCalendarClient.fail} and
 *   {@link FakeCalendarClient.failOnce} inject any of the four error kinds, which
 *   is the only way to exercise `googleSync: 'failed'` and the cron's retry pass.
 * - **It records every call**, so a test can assert what was sent rather than
 *   only what survived.
 *
 * The one thing it does not do is imitate Google's ids. They are short, stable,
 * and obviously fake — `fake-calendar-1@group.calendar.google.com` — because a
 * test that fails should say so in its assertion message, not in a hex string.
 *
 * @example
 * ```ts
 * const google = fakeClient();
 * const { calendarId } = await google.createCalendar("Yazlık — stays");
 * await google.insertEvent(calendarId, { summary: "Ada, 4", start: "2026-08-01", end: "2026-08-08" });
 * expect(google.events(calendarId)).toHaveLength(1);
 *
 * google.fail("insertEvent", "rateLimit");
 * await expect(google.insertEvent(calendarId, event)).rejects.toMatchObject({ kind: "rateLimit" });
 * ```
 */

import { isDateStr, type DateStr } from "@/lib/dates";
import {
  GoogleCalendarError,
  type CalendarClient,
  type CalendarEvent,
  type CalendarEventPatch,
  type GoogleErrorKind,
} from "@/lib/google/types";

/* ============================================================
   WHAT THE FAKE HOLDS
   ============================================================ */

/** The four methods of {@link CalendarClient}, by name. */
export type CalendarOperation = "createCalendar" | "insertEvent" | "patchEvent" | "deleteEvent";

const OPERATIONS: readonly CalendarOperation[] = [
  "createCalendar",
  "insertEvent",
  "patchEvent",
  "deleteEvent",
];

/** A secondary calendar, as this app ever sees one: an id and a title. */
export type FakeCalendar = {
  calendarId: string;
  summary: string;
};

/**
 * A stored event. `opaque` is resolved rather than optional — the fake applies
 * the same default the real client does (`false`, i.e. `transparency:
 * 'transparent'`), so a test reads the value that would be on the wire.
 */
export type FakeEvent = {
  eventId: string;
  calendarId: string;
  summary: string;
  description?: string;
  location?: string;
  start: DateStr;
  end: DateStr;
  opaque: boolean;
};

/** One call that reached the client, with the arguments it carried. */
export type FakeCall =
  | { operation: "createCalendar"; summary: string }
  | { operation: "insertEvent"; calendarId: string; event: CalendarEvent }
  | { operation: "patchEvent"; calendarId: string; eventId: string; patch: CalendarEventPatch }
  | { operation: "deleteEvent"; calendarId: string; eventId: string };

/**
 * How to fail.
 *
 * - A {@link GoogleErrorKind} — `"auth"`, `"notFound"`, `"rateLimit"`, `"other"` —
 *   is the usual case and produces a representative status and reason.
 * - A {@link GoogleCalendarError} when the test cares about the exact status,
 *   reason, or `retryable`.
 * - A function for anything else, including throwing a value that is *not* a
 *   `GoogleCalendarError`. That is how to prove the sync layer's catch-all is
 *   real: nothing outside this module guarantees only typed errors escape.
 */
export type FakeFailure = GoogleErrorKind | GoogleCalendarError | (() => unknown);

/** What a failure of each kind looks like when only the kind was named. */
const REPRESENTATIVE: Record<GoogleErrorKind, { status: number; reason: string; message: string }> = {
  auth: {
    status: 401,
    reason: "authError",
    message: "Fake Google: the token is not valid.",
  },
  notFound: {
    status: 404,
    reason: "notFound",
    message: "Fake Google: no such calendar or event.",
  },
  rateLimit: {
    // Calendar answers a burst with 403 far more often than 429, which is the
    // exact confusion `RATE_REASONS` in client.ts exists to resolve. The fake
    // reproduces the awkward shape rather than the tidy one.
    status: 403,
    reason: "rateLimitExceeded",
    message: "Fake Google: too many calls.",
  },
  other: {
    status: 500,
    reason: "backendError",
    message: "Fake Google: something went wrong.",
  },
};

/* ============================================================
   THE INTERFACE THE TESTS SEE
   ============================================================ */

/**
 * {@link CalendarClient} plus everything a test needs to look inside it.
 *
 * Every reader returns copies. A test that mutates what it read changes nothing,
 * so a stale assertion cannot quietly become true.
 */
export interface FakeCalendarClient extends CalendarClient {
  /* --- reading state --- */

  /** Every calendar, in creation order. */
  calendars(): FakeCalendar[];
  /** One calendar, or `undefined` if this app never created it. */
  calendar(calendarId: string): FakeCalendar | undefined;
  /** Live events on one calendar, in insertion order. All calendars if omitted. */
  events(calendarId?: string): FakeEvent[];
  /** One event, or `undefined` if it never existed or was deleted. */
  event(calendarId: string, eventId: string): FakeEvent | undefined;

  /* --- reading calls --- */

  /** Every call that arrived, in order, including ones that failed. */
  calls(): FakeCall[];
  /** Only the calls to one method, narrowed to that method's shape. */
  callsTo<K extends CalendarOperation>(operation: K): Extract<FakeCall, { operation: K }>[];
  /** The most recent call to one method, if there was one. */
  lastCall<K extends CalendarOperation>(operation: K): Extract<FakeCall, { operation: K }> | undefined;

  /* --- making it fail --- */

  /**
   * Fail every call to `operation` — or to all four, with `"*"` — until
   * {@link clearFailures}. This is the dead token: it does not get better.
   */
  fail(operation: CalendarOperation | "*", failure: FakeFailure): void;
  /**
   * Fail the next call to `operation` only, then behave normally. Call it more
   * than once to queue several. This is the blip a retry should survive.
   */
  failOnce(operation: CalendarOperation | "*", failure: FakeFailure): void;
  /** Forget injected failures, standing and queued. All four if none is named. */
  clearFailures(operation?: CalendarOperation | "*"): void;

  /* --- setting up and starting over --- */

  /**
   * Register a calendar without going through {@link createCalendar} — no call
   * is recorded and no failure applies.
   *
   * For the common fixture where a house is *already* connected and carries a
   * `googleCalendarId` the test chose. Pass that id in.
   */
  seedCalendar(options?: { calendarId?: string; summary?: string }): FakeCalendar;
  /** Put an event on a calendar without recording a call. Creates the calendar if needed. */
  seedEvent(calendarId: string, event: CalendarEvent, eventId?: string): FakeEvent;
  /** Drop the calls but keep the calendars and events. */
  clearCalls(): void;
  /** Back to empty: no calendars, no events, no calls, no failures, ids from 1. */
  reset(): void;
}

/* ============================================================
   THE FAKE
   ============================================================ */

type StoredCalendar = {
  calendarId: string;
  summary: string;
  events: Map<string, FakeEvent>;
  /** Ids that existed and no longer do. Google answers these `410 Gone`. */
  deleted: Set<string>;
};

/** A calendar or event the caller named that this app cannot reach. */
function missing(what: string, operation: CalendarOperation, status = 404): GoogleCalendarError {
  return new GoogleCalendarError("notFound", `Fake Google: ${what}`, {
    status,
    reason: status === 410 ? "deleted" : "notFound",
    operation,
  });
}

/** The caller sent something Google would reject outright. Never worth a retry. */
function rejected(message: string, operation: CalendarOperation): GoogleCalendarError {
  return new GoogleCalendarError("other", `Fake Google: ${message}`, {
    status: 400,
    reason: "badRequest",
    operation,
  });
}

/**
 * A calendar client backed by two maps.
 *
 * Cheap enough to make one per test — and it should be one per test, because the
 * id counters restart with it, which is what makes assertions on ids readable.
 */
export function fakeClient(): FakeCalendarClient {
  const calendars = new Map<string, StoredCalendar>();
  const calls: FakeCall[] = [];
  const standing = new Map<CalendarOperation, FakeFailure>();
  const queued = new Map<CalendarOperation, FakeFailure[]>();

  let nextCalendar = 1;
  let nextEvent = 1;

  /* --- failure injection --- */

  function expand(operation: CalendarOperation | "*"): readonly CalendarOperation[] {
    return operation === "*" ? OPERATIONS : [operation];
  }

  function build(failure: FakeFailure, operation: CalendarOperation): unknown {
    if (typeof failure === "function") return failure();
    if (failure instanceof GoogleCalendarError) return failure;
    const shape = REPRESENTATIVE[failure];
    return new GoogleCalendarError(failure, shape.message, {
      status: shape.status,
      reason: shape.reason,
      operation,
    });
  }

  /**
   * Throw if this call was told to fail. Queued failures go first — a test that
   * asks for one blip and then a standing failure gets them in that order.
   */
  function maybeFail(operation: CalendarOperation): void {
    const next = queued.get(operation)?.shift();
    const failure = next ?? standing.get(operation);
    if (failure === undefined) return;
    throw build(failure, operation);
  }

  /* --- lookups --- */

  function must(calendarId: string, operation: CalendarOperation): StoredCalendar {
    const found = calendars.get(calendarId);
    if (!found) throw missing(`no calendar ${calendarId}.`, operation);
    return found;
  }

  function mustEvent(
    calendar: StoredCalendar,
    eventId: string,
    operation: CalendarOperation,
  ): FakeEvent {
    const found = calendar.events.get(eventId);
    if (found) return found;
    // Gone, not merely absent: an event this app deleted a moment ago, or one
    // the owner deleted by hand in the Google UI.
    if (calendar.deleted.has(eventId)) throw missing(`event ${eventId} is gone.`, operation, 410);
    throw missing(`no event ${eventId}.`, operation);
  }

  /* --- validation, as close to Google's as matters --- */

  function checkRange(start: DateStr, end: DateStr, operation: CalendarOperation): void {
    if (!isDateStr(start)) throw rejected(`start ${JSON.stringify(start)} is not a date.`, operation);
    if (!isDateStr(end)) throw rejected(`end ${JSON.stringify(end)} is not a date.`, operation);
    // Half-open and exclusive at both ends of the codebase: `end` is the day the
    // house is free again, so `end === start` is an empty stay, not a one-night one.
    if (end <= start) throw rejected(`end ${end} is not after start ${start}.`, operation);
  }

  function store(calendarId: string, summary?: string): StoredCalendar {
    const existing = calendars.get(calendarId);
    if (existing) return existing;
    const created: StoredCalendar = {
      calendarId,
      summary: summary ?? "",
      events: new Map(),
      deleted: new Set(),
    };
    calendars.set(calendarId, created);
    return created;
  }

  function recorded<K extends CalendarOperation>(
    operation: K,
  ): Extract<FakeCall, { operation: K }>[] {
    return calls.filter(
      (call): call is Extract<FakeCall, { operation: K }> => call.operation === operation,
    );
  }

  function put(calendar: StoredCalendar, event: CalendarEvent, eventId: string): FakeEvent {
    const stored: FakeEvent = {
      eventId,
      calendarId: calendar.calendarId,
      summary: event.summary,
      ...(event.description === undefined ? {} : { description: event.description }),
      ...(event.location === undefined ? {} : { location: event.location }),
      start: event.start,
      end: event.end,
      // The real client sends `transparency: 'transparent'` when this is unset.
      opaque: event.opaque ?? false,
    };
    calendar.events.set(eventId, stored);
    calendar.deleted.delete(eventId);
    return stored;
  }

  return {
    /* ============================================================
       THE FOUR OPERATIONS
       ============================================================ */

    async createCalendar(summary: string) {
      calls.push({ operation: "createCalendar", summary });
      maybeFail("createCalendar");

      if (typeof summary !== "string" || summary.trim() === "") {
        throw rejected("a calendar needs a summary.", "createCalendar");
      }

      const calendarId = `fake-calendar-${nextCalendar++}@group.calendar.google.com`;
      store(calendarId, summary);
      return { calendarId };
    },

    async insertEvent(calendarId: string, event: CalendarEvent) {
      calls.push({ operation: "insertEvent", calendarId, event: { ...event } });
      maybeFail("insertEvent");

      const calendar = must(calendarId, "insertEvent");
      checkRange(event.start, event.end, "insertEvent");
      if (typeof event.summary !== "string" || event.summary === "") {
        throw rejected("an event needs a summary.", "insertEvent");
      }

      const eventId = `fakeevent${nextEvent++}`;
      put(calendar, event, eventId);
      return { eventId };
    },

    async patchEvent(calendarId: string, eventId: string, patch: CalendarEventPatch) {
      calls.push({ operation: "patchEvent", calendarId, eventId, patch: { ...patch } });
      maybeFail("patchEvent");

      const calendar = must(calendarId, "patchEvent");
      const current = mustEvent(calendar, eventId, "patchEvent");

      // Send both ends or neither. Google's answer to a half-specified all-day
      // range is an unhelpful 400, and the caller has both dates in hand every
      // time — there is no legitimate reason to send one.
      if ((patch.start === undefined) !== (patch.end === undefined)) {
        throw rejected("patch start and end together or not at all.", "patchEvent");
      }

      const merged: CalendarEvent = {
        summary: patch.summary ?? current.summary,
        description: patch.description ?? current.description,
        location: patch.location ?? current.location,
        start: patch.start ?? current.start,
        end: patch.end ?? current.end,
        opaque: patch.opaque ?? current.opaque,
      };

      checkRange(merged.start, merged.end, "patchEvent");
      put(calendar, merged, eventId);
    },

    async deleteEvent(calendarId: string, eventId: string) {
      calls.push({ operation: "deleteEvent", calendarId, eventId });
      maybeFail("deleteEvent");

      const calendar = must(calendarId, "deleteEvent");
      mustEvent(calendar, eventId, "deleteEvent");

      calendar.events.delete(eventId);
      calendar.deleted.add(eventId);
    },

    /* ============================================================
       LOOKING INSIDE
       ============================================================ */

    calendars() {
      return [...calendars.values()].map(({ calendarId, summary }) => ({ calendarId, summary }));
    },

    calendar(calendarId: string) {
      const found = calendars.get(calendarId);
      return found ? { calendarId: found.calendarId, summary: found.summary } : undefined;
    },

    events(calendarId?: string) {
      const wanted =
        calendarId === undefined
          ? [...calendars.values()]
          : [calendars.get(calendarId)].filter((c): c is StoredCalendar => c !== undefined);
      return wanted.flatMap((calendar) => [...calendar.events.values()].map((e) => ({ ...e })));
    },

    event(calendarId: string, eventId: string) {
      const found = calendars.get(calendarId)?.events.get(eventId);
      return found ? { ...found } : undefined;
    },

    calls() {
      return calls.slice();
    },

    callsTo<K extends CalendarOperation>(operation: K) {
      return recorded(operation);
    },

    lastCall<K extends CalendarOperation>(operation: K) {
      return recorded(operation).at(-1);
    },

    /* ============================================================
       CONTROLS
       ============================================================ */

    fail(operation: CalendarOperation | "*", failure: FakeFailure) {
      for (const op of expand(operation)) standing.set(op, failure);
    },

    failOnce(operation: CalendarOperation | "*", failure: FakeFailure) {
      for (const op of expand(operation)) {
        const list = queued.get(op) ?? [];
        list.push(failure);
        queued.set(op, list);
      }
    },

    clearFailures(operation: CalendarOperation | "*" = "*") {
      for (const op of expand(operation)) {
        standing.delete(op);
        queued.delete(op);
      }
    },

    seedCalendar(options: { calendarId?: string; summary?: string } = {}) {
      const calendarId =
        options.calendarId ?? `fake-calendar-${nextCalendar++}@group.calendar.google.com`;
      const calendar = store(calendarId, options.summary ?? "Seeded calendar");
      if (options.summary !== undefined) calendar.summary = options.summary;
      return { calendarId: calendar.calendarId, summary: calendar.summary };
    },

    seedEvent(calendarId: string, event: CalendarEvent, eventId?: string) {
      const calendar = store(calendarId, "Seeded calendar");
      return { ...put(calendar, event, eventId ?? `fakeevent${nextEvent++}`) };
    },

    clearCalls() {
      calls.length = 0;
    },

    reset() {
      calendars.clear();
      calls.length = 0;
      standing.clear();
      queued.clear();
      nextCalendar = 1;
      nextEvent = 1;
    },
  };
}
