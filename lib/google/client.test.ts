/**
 * The Google Calendar client, tested without Google.
 *
 * There are no credentials on this machine and the consent screen is not
 * scriptable, so nothing here reaches the network — and the suite is arranged so
 * that it *cannot*. `googleapis` is replaced by a stand-in whose call shapes were
 * read off the discovery document vendored in `googleapis@173.0.0`, which is the
 * same source `lib/google/client.ts` was written from:
 *
 * ```
 * calendars.insert({ requestBody })                  → { data: Schema$Calendar }
 * events.insert({ calendarId, requestBody })         → { data: Schema$Event }
 * events.patch({ calendarId, eventId, requestBody }) → { data: Schema$Event }
 * events.delete({ calendarId, eventId })
 * ```
 *
 * Three things are worth the length:
 *
 * 1. **The dates.** A stay is half-open in the database, half-open in the `.ics`,
 *    and Google's all-day `end.date` is exclusive too — so the columns go on the
 *    wire untouched. A ±1 fudge is the classic all-day calendar bug and it would
 *    be invisible without an assertion on the exact request body.
 * 2. **The error mapper.** Google reports the same failure four different ways
 *    depending on which endpoint answered, and the sync layer's whole behaviour
 *    hangs off which of four kinds it gets. Every shape below is one Google
 *    actually sends: a rate limit dressed as a 403, a revoked token dressed as a
 *    400, an AIP-193 `RESOURCE_EXHAUSTED`, a socket that never got a response.
 * 3. **The fake.** It is not scaffolding — it is what the sync layer is built
 *    against, so its refusals have to match the real thing or every test above it
 *    is testing a fiction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeClient, type FakeCalendarClient } from "@/lib/google/fake";
import {
  GoogleCalendarError,
  isGoogleCalendarError,
  type CalendarClient,
  type CalendarEvent,
} from "@/lib/google/types";
import {
  googleClient,
  googleCredentials,
  isGoogleConfigured,
  toGoogleCalendarError,
} from "@/lib/google/client";

/* ============================================================
   THE STAND-IN FOR googleapis
   ============================================================ */

type StubCall = { method: string; params: Record<string, unknown> };

const stub = vi.hoisted(() => ({
  /** Every request the client made, in order. */
  calls: [] as { method: string; params: Record<string, unknown> }[],
  /** Options each `new google.auth.OAuth2(...)` was constructed with. */
  authOptions: [] as unknown[],
  /** Whatever was handed to `setCredentials`, in Google's wire names. */
  credentials: [] as unknown[],
  /** `tokens` listeners the client registered. */
  listeners: [] as ((tokens: unknown) => void)[],
  /** Options each `google.calendar(...)` was built with. */
  calendarOptions: [] as unknown[],
  /** Method name → what to answer with. Throwing is how the transport fails. */
  replies: new Map<string, (params: Record<string, unknown>) => unknown>(),
}));

vi.mock("googleapis", () => {
  class OAuth2 {
    constructor(options: unknown) {
      stub.authOptions.push(options);
    }
    setCredentials(credentials: unknown) {
      stub.credentials.push(credentials);
    }
    on(event: string, listener: (tokens: unknown) => void) {
      if (event === "tokens") stub.listeners.push(listener);
      return this;
    }
  }

  const defaults: Record<string, (params: Record<string, unknown>) => unknown> = {
    "calendars.insert": (params) => ({
      data: {
        id: "cal-from-google@group.calendar.google.com",
        summary: (params.requestBody as { summary?: string } | undefined)?.summary,
      },
    }),
    "events.insert": () => ({ data: { id: "evt-from-google" } }),
    "events.patch": (params) => ({ data: { id: params.eventId } }),
    "events.delete": () => ({ data: "" }),
  };

  async function request(method: string, params: Record<string, unknown>) {
    stub.calls.push({ method, params });
    const reply = stub.replies.get(method) ?? defaults[method];
    return reply?.(params);
  }

  return {
    google: {
      auth: { OAuth2 },
      calendar(options: unknown) {
        stub.calendarOptions.push(options);
        return {
          calendars: {
            insert: (params: Record<string, unknown>) => request("calendars.insert", params),
          },
          events: {
            insert: (params: Record<string, unknown>) => request("events.insert", params),
            patch: (params: Record<string, unknown>) => request("events.patch", params),
            delete: (params: Record<string, unknown>) => request("events.delete", params),
          },
        };
      },
    },
  };
});

/** Credentials that exist only in this file. Nothing here can reach Google. */
const CREDS = { clientId: "test-client-id", clientSecret: "test-client-secret" };

const SAVED_ID = process.env.GOOGLE_CLIENT_ID;
const SAVED_SECRET = process.env.GOOGLE_CLIENT_SECRET;

beforeEach(() => {
  stub.calls.length = 0;
  stub.authOptions.length = 0;
  stub.credentials.length = 0;
  stub.listeners.length = 0;
  stub.calendarOptions.length = 0;
  stub.replies.clear();
  // Deterministic whatever the shell exports.
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

afterEach(() => {
  if (SAVED_ID === undefined) delete process.env.GOOGLE_CLIENT_ID;
  else process.env.GOOGLE_CLIENT_ID = SAVED_ID;
  if (SAVED_SECRET === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
  else process.env.GOOGLE_CLIENT_SECRET = SAVED_SECRET;
});

/** The request body of the nth call to `method`. */
function bodyOf(method: string, index = 0): Record<string, unknown> {
  const call = stub.calls.filter((c: StubCall) => c.method === method)[index];
  expect(call, `no call ${index} to ${method}`).toBeDefined();
  return call!.params.requestBody as Record<string, unknown>;
}

/** A stay: seven nights, half-open, exactly as the database stores it. */
const STAY: CalendarEvent = {
  summary: "Ada Yılmaz · 4 guests",
  description: "Arriving late. See /app",
  start: "2026-08-01",
  end: "2026-08-08",
};

/* ============================================================
   CREDENTIALS
   ============================================================ */

describe("googleCredentials", () => {
  it("is null when the environment has none", () => {
    expect(googleCredentials()).toBeNull();
    expect(isGoogleConfigured()).toBe(false);
  });

  it("treats a present-but-empty variable as absent", () => {
    // Exactly what `.env.local` ships: the key is there, the value is not.
    process.env.GOOGLE_CLIENT_ID = "";
    process.env.GOOGLE_CLIENT_SECRET = "";
    expect(googleCredentials()).toBeNull();

    process.env.GOOGLE_CLIENT_ID = "   ";
    process.env.GOOGLE_CLIENT_SECRET = "   ";
    expect(googleCredentials()).toBeNull();
  });

  it("needs both halves", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    expect(googleCredentials()).toBeNull();

    delete process.env.GOOGLE_CLIENT_ID;
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    expect(googleCredentials()).toBeNull();
  });

  it("reads the environment and trims it", () => {
    process.env.GOOGLE_CLIENT_ID = "  id  ";
    process.env.GOOGLE_CLIENT_SECRET = "  secret  ";
    expect(googleCredentials()).toEqual({ clientId: "id", clientSecret: "secret" });
    expect(isGoogleConfigured()).toBe(true);
  });

  it("prefers explicit overrides to the environment", () => {
    process.env.GOOGLE_CLIENT_ID = "from-env";
    process.env.GOOGLE_CLIENT_SECRET = "from-env";
    expect(googleCredentials(CREDS)).toEqual(CREDS);
  });
});

/* ============================================================
   NOTHING THROWS WITHOUT CREDENTIALS
   ============================================================ */

describe("googleClient with no credentials", () => {
  it("constructs anyway", () => {
    // The whole app must boot with an empty `.env.local`. Building the client is
    // allocating a closure; it reads nothing and cannot fail.
    expect(() => googleClient({ refreshToken: "r" })).not.toThrow();
  });

  it("fails on the first call, as auth, without attempting a request", async () => {
    const client = googleClient({ refreshToken: "r" });

    const error = await client.createCalendar("Yazlık — stays").catch((e: unknown) => e);

    expect(isGoogleCalendarError(error)).toBe(true);
    expect(error).toMatchObject({
      kind: "auth",
      reason: "missingCredentials",
      retryable: false,
      operation: "createCalendar",
    });
    expect((error as GoogleCalendarError).message).toContain("GOOGLE_CLIENT_ID");
    // No OAuth client was built and no request went out.
    expect(stub.authOptions).toHaveLength(0);
    expect(stub.calls).toHaveLength(0);
  });

  it("fails the same way on every method", async () => {
    const client = googleClient({});
    const kinds = await Promise.all([
      client.insertEvent("cal", STAY).catch((e: GoogleCalendarError) => e.kind),
      client.patchEvent("cal", "evt", { summary: "x" }).catch((e: GoogleCalendarError) => e.kind),
      client.deleteEvent("cal", "evt").catch((e: GoogleCalendarError) => e.kind),
    ]);
    expect(kinds).toEqual(["auth", "auth", "auth"]);
    expect(stub.calls).toHaveLength(0);
  });

  it("does not cache the failed connection", async () => {
    const client = googleClient({ refreshToken: "r" });

    await expect(client.createCalendar("Yazlık — stays")).rejects.toMatchObject({ kind: "auth" });

    // The operator fills in the environment; the same instance now works. A
    // cached rejection would need a restart to clear, which on a serverless
    // deployment means the integration stays dead for the life of the instance.
    process.env.GOOGLE_CLIENT_ID = CREDS.clientId;
    process.env.GOOGLE_CLIENT_SECRET = CREDS.clientSecret;

    await expect(client.createCalendar("Yazlık — stays")).resolves.toEqual({
      calendarId: "cal-from-google@group.calendar.google.com",
    });
  });
});

/* ============================================================
   WHAT THE REAL CLIENT PUTS ON THE WIRE
   ============================================================ */

describe("googleClient requests", () => {
  function client(options: Record<string, unknown> = {}) {
    return googleClient({ accessToken: "at", refreshToken: "rt" }, { ...CREDS, ...options });
  }

  it("creates a calendar from a summary and returns Google's id", async () => {
    const result = await client().createCalendar("Yazlık — stays");

    expect(result).toEqual({ calendarId: "cal-from-google@group.calendar.google.com" });
    expect(stub.calls[0]?.method).toBe("calendars.insert");
    expect(bodyOf("calendars.insert")).toEqual({ summary: "Yazlık — stays" });
  });

  it("sends the stay's dates unchanged, half-open, with no time and no timezone", async () => {
    const result = await client().insertEvent("cal-1", STAY);

    expect(result).toEqual({ eventId: "evt-from-google" });
    expect(stub.calls[0]?.params.calendarId).toBe("cal-1");
    expect(bodyOf("events.insert")).toEqual({
      summary: STAY.summary,
      description: STAY.description,
      // 1 Aug in, 8 Aug out — seven nights, and the 8th is free for the next
      // guest. Google's all-day `end.date` is exclusive, so no ±1 anywhere.
      start: { date: "2026-08-01" },
      end: { date: "2026-08-08" },
      transparency: "transparent",
    });
  });

  it("marks the owner busy only when asked", async () => {
    await client().insertEvent("cal-1", { ...STAY, opaque: true });
    expect(bodyOf("events.insert")).toMatchObject({ transparency: "opaque" });
  });

  it("never lets Google mail anybody", async () => {
    const google = client();
    await google.insertEvent("cal-1", STAY);
    await google.patchEvent("cal-1", "evt-1", { summary: "x" });
    await google.deleteEvent("cal-1", "evt-1");

    // The guest's invite is the `.ics` on their confirmation email and is meant
    // to stay the only one. These events carry no attendees today; saying
    // `sendUpdates: none` out loud means adding one later cannot mail them.
    for (const call of stub.calls) {
      expect(call.params.sendUpdates).toBe("none");
    }
  });

  it("patches only the fields it was given", async () => {
    await client().patchEvent("cal-1", "evt-1", { start: "2026-08-02", end: "2026-08-09" });

    expect(stub.calls[0]).toMatchObject({
      method: "events.patch",
      params: { calendarId: "cal-1", eventId: "evt-1" },
    });
    // `events.patch` merges: a summary that is not sent is a summary that is not
    // touched. Sending `summary: undefined` would be a different request.
    expect(bodyOf("events.patch")).toEqual({
      start: { date: "2026-08-02" },
      end: { date: "2026-08-09" },
    });
  });

  it("sends an empty patch as an empty body rather than nulls", async () => {
    await client().patchEvent("cal-1", "evt-1", {});
    expect(bodyOf("events.patch")).toEqual({});
  });

  it("deletes by calendar and event id", async () => {
    await client().deleteEvent("cal-1", "evt-1");
    expect(stub.calls[0]).toMatchObject({
      method: "events.delete",
      params: { calendarId: "cal-1", eventId: "evt-1", sendUpdates: "none" },
    });
  });

  it("hands Google the tokens under Google's own names", async () => {
    const expiresAt = new Date("2026-08-01T10:00:00.000Z");
    await googleClient({ accessToken: "at", refreshToken: "rt", expiresAt }, CREDS).deleteEvent(
      "cal-1",
      "evt-1",
    );

    expect(stub.authOptions[0]).toEqual({
      clientId: CREDS.clientId,
      clientSecret: CREDS.clientSecret,
    });
    expect(stub.credentials[0]).toEqual({
      access_token: "at",
      refresh_token: "rt",
      expiry_date: expiresAt.getTime(),
    });
  });

  it("accepts an expiry already in milliseconds, and none at all", async () => {
    await googleClient({ refreshToken: "rt", expiresAt: 1_800_000_000_000 }, CREDS).deleteEvent(
      "c",
      "e",
    );
    expect(stub.credentials[0]).toMatchObject({ expiry_date: 1_800_000_000_000 });

    stub.credentials.length = 0;
    await googleClient({ refreshToken: "rt" }, CREDS).deleteEvent("c", "e");
    expect(stub.credentials[0]).toMatchObject({ expiry_date: undefined });
  });

  it("connects once and reuses it across calls", async () => {
    const google = client();
    await google.createCalendar("Yazlık — stays");
    await google.insertEvent("cal-1", STAY);
    await google.deleteEvent("cal-1", "evt-1");

    // Three operations, one OAuth client — so one token refresh, not three.
    expect(stub.authOptions).toHaveLength(1);
    expect(stub.calendarOptions).toHaveLength(1);
    expect(stub.calls).toHaveLength(3);
  });

  it("passes refreshed tokens back, keeping the refresh token Google omits", async () => {
    const fresh: unknown[] = [];
    await client({ onTokens: (tokens: unknown) => fresh.push(tokens) }).deleteEvent("c", "e");

    expect(stub.listeners).toHaveLength(1);
    // Google re-sends a refresh token on first consent and never again, so a
    // refresh that only carries an access token must not blank the stored one.
    stub.listeners[0]?.({ access_token: "new-at", expiry_date: 1_800_000_000_000 });

    expect(fresh).toEqual([
      { accessToken: "new-at", refreshToken: "rt", expiresAt: 1_800_000_000_000 },
    ]);
  });

  it("registers no listener when nobody is listening", async () => {
    await client().deleteEvent("c", "e");
    expect(stub.listeners).toHaveLength(0);
  });
});

/* ============================================================
   WHAT THE REAL CLIENT DOES WITH A REFUSAL
   ============================================================ */

describe("googleClient failures", () => {
  const google = () => googleClient({ refreshToken: "rt" }, CREDS);

  /** A Gaxios rejection, shaped as the classic JSON API sends it. */
  function gaxios(status: number, reason: string, message: string) {
    return Object.assign(new Error(message), {
      status,
      response: { status, data: { error: { code: status, message, errors: [{ reason }] } } },
    });
  }

  it("types a 404 from the transport as notFound and names the operation", async () => {
    stub.replies.set("events.delete", () => {
      throw gaxios(404, "notFound", "Not Found");
    });

    const error = await google()
      .deleteEvent("cal-1", "evt-1")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GoogleCalendarError);
    expect(error).toMatchObject({
      kind: "notFound",
      status: 404,
      reason: "notFound",
      operation: "deleteEvent",
      retryable: false,
    });
  });

  it("types a rate limit as retryable", async () => {
    stub.replies.set("events.insert", () => {
      throw gaxios(403, "rateLimitExceeded", "Rate Limit Exceeded");
    });

    await expect(google().insertEvent("cal-1", STAY)).rejects.toMatchObject({
      kind: "rateLimit",
      retryable: true,
      operation: "insertEvent",
    });
  });

  it("treats a calendar created without an id as a fault, not a success", async () => {
    stub.replies.set("calendars.insert", () => ({ data: {} }));

    await expect(google().createCalendar("Yazlık — stays")).rejects.toMatchObject({
      kind: "other",
      operation: "createCalendar",
    });
  });

  it("treats an event created without an id as a fault", async () => {
    stub.replies.set("events.insert", () => ({ data: {} }));

    // Returning `undefined` here would store `googleEventId: null` on a booking
    // that really does have an event — and nothing would ever delete it.
    await expect(google().insertEvent("cal-1", STAY)).rejects.toMatchObject({
      kind: "other",
      operation: "insertEvent",
    });
  });
});

/* ============================================================
   THE ERROR MAPPER
   ============================================================ */

describe("toGoogleCalendarError", () => {
  /** The shape gaxios hands back for a JSON API error. */
  function apiError(status: number, reasons: string[], message = "Google says no") {
    return Object.assign(new Error(message), {
      status,
      response: {
        status,
        data: { error: { code: status, message, errors: reasons.map((reason) => ({ reason })) } },
      },
    });
  }

  it("reads 401 as auth", () => {
    const mapped = toGoogleCalendarError(apiError(401, ["authError"], "Invalid Credentials"));
    expect(mapped.kind).toBe("auth");
    expect(mapped.status).toBe(401);
    expect(mapped.reason).toBe("authError");
    expect(mapped.message).toBe("Invalid Credentials");
    expect(mapped.retryable).toBe(false);
  });

  it("reads a bare 403 as auth", () => {
    // No reason at all: the owner removed the app, or the scope is wrong.
    const mapped = toGoogleCalendarError({ status: 403 });
    expect(mapped.kind).toBe("auth");
  });

  it("separates a rate limit from a refusal, though both arrive as 403", () => {
    // The single most consequential branch in this file. Read the first as auth
    // and the app tells an owner to reconnect a perfectly good account; read the
    // second as a rate limit and the cron retries a dead token forever.
    for (const reason of [
      "rateLimitExceeded",
      "userRateLimitExceeded",
      "quotaExceeded",
      "dailyLimitExceeded",
    ]) {
      const mapped = toGoogleCalendarError(apiError(403, [reason]));
      expect(mapped.kind, reason).toBe("rateLimit");
      expect(mapped.retryable, reason).toBe(true);
    }

    for (const reason of ["insufficientPermissions", "authError", "access_denied"]) {
      const mapped = toGoogleCalendarError(apiError(403, [reason]));
      expect(mapped.kind, reason).toBe("auth");
      expect(mapped.retryable, reason).toBe(false);
    }
  });

  it("reads a revoked refresh token, which is a 400 and not a 401", () => {
    // The OAuth token endpoint's whole answer. Classified by status alone this
    // is an `other`, the cron retries it forever, and the owner is never told to
    // reconnect — the exact failure the reason table exists to prevent.
    const mapped = toGoogleCalendarError({
      status: 400,
      response: {
        status: 400,
        data: {
          error: "invalid_grant",
          error_description: "Token has been expired or revoked.",
        },
      },
    });

    expect(mapped.kind).toBe("auth");
    expect(mapped.status).toBe(400);
    expect(mapped.reason).toBe("invalid_grant");
    expect(mapped.message).toBe("Token has been expired or revoked.");
    expect(mapped.retryable).toBe(false);
  });

  it("reads 404 and 410 as notFound", () => {
    expect(toGoogleCalendarError(apiError(404, ["notFound"])).kind).toBe("notFound");
    // Google answers a second delete of the same event with 410 Gone. Treating
    // that as a fault would mark a booking failed for reaching the state it
    // wanted, so the delete path can stay idempotent.
    expect(toGoogleCalendarError(apiError(410, ["deleted"], "Resource has been deleted")).kind).toBe(
      "notFound",
    );
  });

  it("reads 429 as a rate limit", () => {
    const mapped = toGoogleCalendarError({ status: 429 });
    expect(mapped.kind).toBe("rateLimit");
    expect(mapped.retryable).toBe(true);
  });

  it("reads the AIP-193 spellings, which arrive as a status string", () => {
    const aip = (status: number, name: string) => ({
      response: { status, data: { error: { code: status, status: name, message: name } } },
    });

    expect(toGoogleCalendarError(aip(429, "RESOURCE_EXHAUSTED")).kind).toBe("rateLimit");
    expect(toGoogleCalendarError(aip(401, "UNAUTHENTICATED")).kind).toBe("auth");
    expect(toGoogleCalendarError(aip(403, "PERMISSION_DENIED")).kind).toBe("auth");
    expect(toGoogleCalendarError(aip(404, "NOT_FOUND")).kind).toBe("notFound");
  });

  it("keeps a 5xx retryable and a 4xx not", () => {
    expect(toGoogleCalendarError(apiError(500, ["backendError"]))).toMatchObject({
      kind: "other",
      retryable: true,
    });
    expect(toGoogleCalendarError(apiError(503, []))).toMatchObject({
      kind: "other",
      retryable: true,
    });
    // We sent nonsense. It will fail identically forever, so retrying it is only
    // a way of failing more often.
    expect(toGoogleCalendarError(apiError(400, ["badRequest"]))).toMatchObject({
      kind: "other",
      retryable: false,
    });
  });

  it("keeps a socket that never got an answer retryable", () => {
    const mapped = toGoogleCalendarError(
      Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      "insertEvent",
    );

    expect(mapped.kind).toBe("other");
    expect(mapped.status).toBeUndefined();
    expect(mapped.reason).toBe("ECONNRESET");
    expect(mapped.retryable).toBe(true);
    expect(mapped.operation).toBe("insertEvent");
    expect(mapped.message).toBe("socket hang up");
  });

  it("finds the status wherever the shape happens to keep it", () => {
    // Gaxios v7 on the error itself, older shapes on `response`, the JSON body's
    // own copy, and a numeric top-level `code`.
    expect(toGoogleCalendarError({ status: 404 }).kind).toBe("notFound");
    expect(toGoogleCalendarError({ response: { status: 404 } }).kind).toBe("notFound");
    expect(toGoogleCalendarError({ response: { data: { error: { code: 404 } } } }).kind).toBe(
      "notFound",
    );
    expect(toGoogleCalendarError({ code: 404 }).kind).toBe("notFound");
  });

  it("does not read a string `code` as a status", () => {
    // `code` is `string | number` on gaxios errors. `'404'` is not a status and
    // must not be treated as one.
    const mapped = toGoogleCalendarError({ code: "ETIMEDOUT" });
    expect(mapped.kind).toBe("other");
    expect(mapped.status).toBeUndefined();
    expect(mapped.reason).toBe("ETIMEDOUT");
  });

  it("survives anything at all being thrown", () => {
    for (const thrown of [undefined, null, "just a string", 42, new Error("plain")]) {
      const mapped = toGoogleCalendarError(thrown);
      expect(mapped).toBeInstanceOf(GoogleCalendarError);
      expect(mapped.kind).toBe("other");
      expect(mapped.message).toBeTruthy();
    }
    expect(toGoogleCalendarError("just a string").message).toBe("just a string");
    expect(toGoogleCalendarError(undefined).message).toBe(
      "Google Calendar refused the request.",
    );
  });

  it("keeps the original as `cause`", () => {
    const original = apiError(500, ["backendError"]);
    expect(toGoogleCalendarError(original).cause).toBe(original);
  });

  it("is idempotent", () => {
    const once = toGoogleCalendarError(apiError(401, ["authError"]), "insertEvent");
    // Wrapping twice must not restate a typed error as an untyped `other`.
    expect(toGoogleCalendarError(once, "patchEvent")).toBe(once);
    expect(once.operation).toBe("insertEvent");
  });
});

describe("GoogleCalendarError", () => {
  it("derives retryable from the kind", () => {
    expect(new GoogleCalendarError("rateLimit", "x").retryable).toBe(true);
    expect(new GoogleCalendarError("auth", "x").retryable).toBe(false);
    expect(new GoogleCalendarError("notFound", "x").retryable).toBe(false);
    expect(new GoogleCalendarError("other", "x", { status: 503 }).retryable).toBe(true);
    expect(new GoogleCalendarError("other", "x", { status: 400 }).retryable).toBe(false);
    expect(new GoogleCalendarError("other", "x").retryable).toBe(true);
  });

  it("lets the caller override it", () => {
    expect(new GoogleCalendarError("auth", "x", { retryable: true }).retryable).toBe(true);
  });

  it("narrows in a catch block", () => {
    expect(isGoogleCalendarError(new GoogleCalendarError("other", "x"))).toBe(true);
    expect(isGoogleCalendarError(new Error("x"))).toBe(false);
    expect(isGoogleCalendarError("x")).toBe(false);
  });
});

/* ============================================================
   THE FAKE
   ============================================================ */

describe("fakeClient", () => {
  let google: FakeCalendarClient;

  beforeEach(() => {
    google = fakeClient();
  });

  /* --- the round trip --- */

  it("creates a calendar and hands back an id", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");

    expect(calendarId).toBe("fake-calendar-1@group.calendar.google.com");
    expect(google.calendars()).toEqual([
      { calendarId, summary: "Yazlık — stays" },
    ]);
    expect(google.calendar(calendarId)).toMatchObject({ summary: "Yazlık — stays" });
    expect(google.calls()).toEqual([
      { operation: "createCalendar", summary: "Yazlık — stays" },
    ]);
  });

  it("stores an inserted event exactly as it was given", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    const { eventId } = await google.insertEvent(calendarId, STAY);

    expect(eventId).toBe("fakeevent1");
    expect(google.event(calendarId, eventId)).toEqual({
      eventId,
      calendarId,
      summary: STAY.summary,
      description: STAY.description,
      start: "2026-08-01",
      end: "2026-08-08",
      // Unset means transparent, matching `lib/ics.ts`: a week at the house does
      // not black out a week of somebody's working calendar.
      opaque: false,
    });
  });

  it("patches what it is given and leaves the rest", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    const { eventId } = await google.insertEvent(calendarId, STAY);

    await google.patchEvent(calendarId, eventId, { start: "2026-08-02", end: "2026-08-09" });

    expect(google.event(calendarId, eventId)).toMatchObject({
      summary: STAY.summary,
      description: STAY.description,
      start: "2026-08-02",
      end: "2026-08-09",
    });

    await google.patchEvent(calendarId, eventId, { summary: "Ada Yılmaz · 2 guests" });
    expect(google.event(calendarId, eventId)).toMatchObject({
      summary: "Ada Yılmaz · 2 guests",
      start: "2026-08-02",
      end: "2026-08-09",
    });
  });

  it("deletes an event", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    const { eventId } = await google.insertEvent(calendarId, STAY);

    await google.deleteEvent(calendarId, eventId);

    expect(google.event(calendarId, eventId)).toBeUndefined();
    expect(google.events(calendarId)).toEqual([]);
    // The calendar survives its last event.
    expect(google.calendar(calendarId)).toBeDefined();
  });

  it("keeps calendars apart", async () => {
    const a = await google.createCalendar("House A");
    const b = await google.createCalendar("House B");
    await google.insertEvent(a.calendarId, STAY);
    await google.insertEvent(b.calendarId, STAY);
    await google.insertEvent(b.calendarId, { ...STAY, start: "2026-09-01", end: "2026-09-05" });

    expect(google.events(a.calendarId)).toHaveLength(1);
    expect(google.events(b.calendarId)).toHaveLength(2);
    expect(google.events()).toHaveLength(3);
  });

  /* --- refusals that match Google's --- */

  it("refuses an event on a calendar that does not exist", async () => {
    const error = await google.insertEvent("nope@group.calendar.google.com", STAY).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(GoogleCalendarError);
    expect(error).toMatchObject({
      kind: "notFound",
      status: 404,
      retryable: false,
      operation: "insertEvent",
    });
  });

  it("refuses a range that is backwards or empty", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");

    await expect(
      google.insertEvent(calendarId, { ...STAY, start: "2026-08-08", end: "2026-08-01" }),
    ).rejects.toMatchObject({ kind: "other", status: 400 });

    // Half-open: `end` is the day the house is free again, so the same day twice
    // is nought nights, not one.
    await expect(
      google.insertEvent(calendarId, { ...STAY, start: "2026-08-01", end: "2026-08-01" }),
    ).rejects.toMatchObject({ kind: "other", status: 400 });

    expect(google.events(calendarId)).toEqual([]);
  });

  it("refuses a date that is not a date", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");

    await expect(
      google.insertEvent(calendarId, { ...STAY, start: "2026-02-30" }),
    ).rejects.toMatchObject({ kind: "other", status: 400 });
    await expect(
      google.insertEvent(calendarId, { ...STAY, end: "next tuesday" }),
    ).rejects.toMatchObject({ kind: "other", status: 400 });
  });

  it("refuses a calendar with no summary", async () => {
    await expect(google.createCalendar("   ")).rejects.toMatchObject({
      kind: "other",
      status: 400,
    });
    expect(google.calendars()).toEqual([]);
  });

  it("refuses half a date range in a patch", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    const { eventId } = await google.insertEvent(calendarId, STAY);

    // The caller has both dates in hand every time, and Google's answer to one
    // of them is an unhelpful 400.
    await expect(
      google.patchEvent(calendarId, eventId, { start: "2026-08-02" }),
    ).rejects.toMatchObject({ kind: "other", status: 400 });

    expect(google.event(calendarId, eventId)).toMatchObject({ start: "2026-08-01" });
  });

  it("refuses a patch that would invert the range", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    const { eventId } = await google.insertEvent(calendarId, STAY);

    await expect(
      google.patchEvent(calendarId, eventId, { start: "2026-08-09", end: "2026-08-08" }),
    ).rejects.toMatchObject({ kind: "other", status: 400 });

    expect(google.event(calendarId, eventId)).toMatchObject({ start: "2026-08-01" });
  });

  it("refuses to touch an event that never existed", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");

    await expect(google.deleteEvent(calendarId, "ghost")).rejects.toMatchObject({
      kind: "notFound",
      status: 404,
      operation: "deleteEvent",
    });
    await expect(google.patchEvent(calendarId, "ghost", {})).rejects.toMatchObject({
      kind: "notFound",
      status: 404,
      operation: "patchEvent",
    });
  });

  it("answers a second delete with 410, exactly as Google does", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    const { eventId } = await google.insertEvent(calendarId, STAY);

    await google.deleteEvent(calendarId, eventId);
    const again = await google.deleteEvent(calendarId, eventId).catch((e: unknown) => e);

    // Still `notFound`, so a sync layer that treats notFound as "already gone"
    // is idempotent — which is what an owner tidying up by hand needs it to be.
    expect(again).toMatchObject({ kind: "notFound", status: 410, retryable: false });
  });

  it("refuses everything on a calendar that does not exist", async () => {
    const kinds = await Promise.all([
      google.insertEvent("ghost", STAY).catch((e: GoogleCalendarError) => e.kind),
      google.patchEvent("ghost", "e", {}).catch((e: GoogleCalendarError) => e.kind),
      google.deleteEvent("ghost", "e").catch((e: GoogleCalendarError) => e.kind),
    ]);
    expect(kinds).toEqual(["notFound", "notFound", "notFound"]);
  });

  /* --- failure injection --- */

  it("fails a named operation until it is cleared", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");

    google.fail("insertEvent", "rateLimit");

    await expect(google.insertEvent(calendarId, STAY)).rejects.toMatchObject({
      kind: "rateLimit",
      retryable: true,
      operation: "insertEvent",
    });
    await expect(google.insertEvent(calendarId, STAY)).rejects.toMatchObject({
      kind: "rateLimit",
    });
    // Everything else still works — a rate limit on one call is not an outage.
    await expect(google.createCalendar("House B")).resolves.toBeDefined();

    google.clearFailures("insertEvent");
    await expect(google.insertEvent(calendarId, STAY)).resolves.toMatchObject({
      eventId: "fakeevent1",
    });
  });

  it("fails only the next call when asked to", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");

    google.failOnce("insertEvent", "other");

    await expect(google.insertEvent(calendarId, STAY)).rejects.toMatchObject({ kind: "other" });
    // The blip a retry is supposed to survive.
    await expect(google.insertEvent(calendarId, STAY)).resolves.toBeDefined();
    expect(google.events(calendarId)).toHaveLength(1);
  });

  it("queues one-shot failures in order and runs them before a standing one", async () => {
    google.failOnce("createCalendar", "rateLimit");
    google.failOnce("createCalendar", "notFound");
    google.fail("createCalendar", "auth");

    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) {
      kinds.push(await google.createCalendar("x").then(() => "ok", (e: GoogleCalendarError) => e.kind));
    }

    expect(kinds).toEqual(["rateLimit", "notFound", "auth"]);
  });

  it("fails everything at once, which is what a dead token looks like", async () => {
    const { calendarId } = google.seedCalendar();
    google.fail("*", "auth");

    const kinds = await Promise.all([
      google.createCalendar("x").catch((e: GoogleCalendarError) => e.kind),
      google.insertEvent(calendarId, STAY).catch((e: GoogleCalendarError) => e.kind),
      google.patchEvent(calendarId, "e", {}).catch((e: GoogleCalendarError) => e.kind),
      google.deleteEvent(calendarId, "e").catch((e: GoogleCalendarError) => e.kind),
    ]);

    expect(kinds).toEqual(["auth", "auth", "auth", "auth"]);
    expect(google.calls()).toHaveLength(4);

    google.clearFailures();
    await expect(google.createCalendar("x")).resolves.toBeDefined();
  });

  it("throws exactly the error it was handed", async () => {
    const exact = new GoogleCalendarError("rateLimit", "Back off", {
      status: 429,
      reason: "userRateLimitExceeded",
      retryable: true,
    });
    google.fail("createCalendar", exact);

    await expect(google.createCalendar("x")).rejects.toBe(exact);
  });

  it("can throw something that is not a GoogleCalendarError at all", async () => {
    // Nothing outside `lib/google` guarantees only typed errors escape. The sync
    // layer's catch-all has to be real, so it has to be testable.
    google.fail("insertEvent", () => new TypeError("undefined is not a function"));

    const error = await google.insertEvent("any", STAY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(isGoogleCalendarError(error)).toBe(false);
  });

  it("records the call even when it fails", async () => {
    google.fail("insertEvent", "auth");
    await google.insertEvent("cal-x", STAY).catch(() => undefined);

    // A failed sync still has to be provable: "we tried, with these dates".
    expect(google.callsTo("insertEvent")).toEqual([
      { operation: "insertEvent", calendarId: "cal-x", event: STAY },
    ]);
  });

  /* --- inspection --- */

  it("records every call with its arguments", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    const { eventId } = await google.insertEvent(calendarId, STAY);
    await google.patchEvent(calendarId, eventId, { summary: "Ada · 2" });
    await google.deleteEvent(calendarId, eventId);

    expect(google.calls().map((c) => c.operation)).toEqual([
      "createCalendar",
      "insertEvent",
      "patchEvent",
      "deleteEvent",
    ]);
    expect(google.lastCall("patchEvent")).toEqual({
      operation: "patchEvent",
      calendarId,
      eventId,
      patch: { summary: "Ada · 2" },
    });
    expect(google.lastCall("createCalendar")).toEqual({
      operation: "createCalendar",
      summary: "Yazlık — stays",
    });
    expect(google.callsTo("deleteEvent")).toHaveLength(1);
  });

  it("has no last call before there is a call", () => {
    expect(google.lastCall("insertEvent")).toBeUndefined();
    expect(google.callsTo("insertEvent")).toEqual([]);
  });

  it("hands out copies, not its own state", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    const { eventId } = await google.insertEvent(calendarId, STAY);

    const read = google.event(calendarId, eventId)!;
    read.summary = "tampered";
    google.calls().length = 0;

    expect(google.event(calendarId, eventId)?.summary).toBe(STAY.summary);
    expect(google.calls()).toHaveLength(2);
  });

  it("copies the arguments it records", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    const event = { ...STAY };
    await google.insertEvent(calendarId, event);

    // A caller that reuses one object for two events must not rewrite history.
    event.summary = "changed after the call";

    expect(google.lastCall("insertEvent")?.event.summary).toBe(STAY.summary);
  });

  /* --- setting up and starting over --- */

  it("seeds a calendar the fixture already names", async () => {
    // The common case: a house row that already carries a `googleCalendarId`.
    const seeded = google.seedCalendar({
      calendarId: "already-connected@group.calendar.google.com",
      summary: "Yazlık — stays",
    });

    expect(seeded.calendarId).toBe("already-connected@group.calendar.google.com");
    // Seeding is setup, not traffic.
    expect(google.calls()).toEqual([]);

    await expect(google.insertEvent(seeded.calendarId, STAY)).resolves.toMatchObject({
      eventId: "fakeevent1",
    });
  });

  it("seeds an event so a patch or a delete has something to find", async () => {
    const seeded = google.seedEvent("cal-from-fixture", STAY, "evt-from-fixture");

    expect(seeded).toMatchObject({ eventId: "evt-from-fixture", opaque: false });
    expect(google.calls()).toEqual([]);

    await google.patchEvent("cal-from-fixture", "evt-from-fixture", {
      start: "2026-08-03",
      end: "2026-08-10",
    });
    expect(google.event("cal-from-fixture", "evt-from-fixture")).toMatchObject({
      start: "2026-08-03",
    });

    await google.deleteEvent("cal-from-fixture", "evt-from-fixture");
    expect(google.event("cal-from-fixture", "evt-from-fixture")).toBeUndefined();
  });

  it("drops the calls without dropping the state", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    await google.insertEvent(calendarId, STAY);

    google.clearCalls();

    expect(google.calls()).toEqual([]);
    expect(google.events(calendarId)).toHaveLength(1);
  });

  it("resets to empty, ids included", async () => {
    const { calendarId } = await google.createCalendar("Yazlık — stays");
    await google.insertEvent(calendarId, STAY);
    google.fail("*", "auth");

    google.reset();

    expect(google.calendars()).toEqual([]);
    expect(google.events()).toEqual([]);
    expect(google.calls()).toEqual([]);

    // Ids restart, so an assertion on `fake-calendar-1` means the same thing in
    // every test rather than depending on what ran before it.
    const again = await google.createCalendar("Yazlık — stays");
    expect(again.calendarId).toBe("fake-calendar-1@group.calendar.google.com");
    expect((await google.insertEvent(again.calendarId, STAY)).eventId).toBe("fakeevent1");
  });

  it("is a CalendarClient and can be used as one", async () => {
    // The point of the whole file: the sync layer takes this type, and gets the
    // real client in production without knowing which it holds.
    const client: CalendarClient = fakeClient();
    const { calendarId } = await client.createCalendar("Yazlık — stays");
    const { eventId } = await client.insertEvent(calendarId, STAY);
    await client.patchEvent(calendarId, eventId, { summary: "x", start: "2026-08-01", end: "2026-08-03" });
    await client.deleteEvent(calendarId, eventId);
  });
});
