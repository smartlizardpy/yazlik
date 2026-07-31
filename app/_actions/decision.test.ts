/**
 * The owner's four decisions, with no database, no session, and no mail.
 *
 * `@/db` throws at import without a `DATABASE_URL`, so it is replaced wholesale
 * by a fake query builder: every Drizzle chain method returns the chain, the
 * chain is a thenable, and each `select` / `update` / `insert` / `delete` takes
 * its answer from a scripted queue. That lets a test say "the second insert
 * throws `23505`" or "the update throws `23P01`" without a server anywhere.
 *
 * ### What actually matters here
 *
 * `bookings_no_overlap` is the only thing standing between two pending requests
 * on the same week and a double-booking, and it lives in Postgres. The action's
 * whole job is to translate one SQLSTATE — `23P01` — into one sentence. Three
 * properties are worth more than the rest of this file put together:
 *
 * 1. A `23P01` becomes "Those dates were taken while you were deciding."
 * 2. It still does when Drizzle has wrapped it in a `DrizzleQueryError`, which
 *    is what actually happens at runtime: `error.code` is `undefined` at the
 *    top and the real error hangs off `cause`.
 * 3. Nothing else becomes that sentence. A genuine bug keeps its own message
 *    and reaches the log, because a fault dressed as a double-booking is a
 *    fault nobody ever goes looking for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ============================================================
   THE FAKE DATABASE
   ============================================================ */

/**
 * Hoisted above the imports, because `vi.mock` factories run before any
 * top-level `const` in this file exists.
 */
const fake = vi.hoisted(() => {
  type Verb = "select" | "update" | "insert" | "delete";
  type Outcome = { rows?: unknown[]; error?: unknown };

  const queues: Record<Verb, Outcome[]> = {
    select: [],
    update: [],
    insert: [],
    delete: [],
  };
  const calls: Record<Verb, number> = { select: 0, update: 0, insert: 0, delete: 0 };

  /** What the action asked to write, in call order. */
  const written: { set: unknown[]; values: unknown[] } = { set: [], values: [] };

  // Every builder method Drizzle offers that this file's actions reach for.
  const METHODS = [
    "from",
    "innerJoin",
    "where",
    "limit",
    "orderBy",
    "set",
    "values",
    "returning",
  ] as const;

  function builder(verb: Verb) {
    calls[verb] += 1;
    const outcome = queues[verb].shift() ?? { rows: [] };

    const chain: Record<string, unknown> = {};
    for (const method of METHODS) {
      chain[method] = (arg: unknown) => {
        if (method === "set") written.set.push(arg);
        if (method === "values") written.values.push(arg);
        return chain;
      };
    }

    // Drizzle's builders are thenables; awaiting one runs the query. Same here,
    // except the "query" is whatever the test queued.
    chain.then = (onOk: unknown, onErr: unknown) =>
      Promise.resolve()
        .then(() => {
          if (outcome.error) throw outcome.error;
          return outcome.rows ?? [];
        })
        .then(onOk as never, onErr as never);

    return chain;
  }

  const db = {
    select: () => builder("select"),
    update: () => builder("update"),
    insert: () => builder("insert"),
    delete: () => builder("delete"),
  };

  function reset() {
    for (const verb of ["select", "update", "insert", "delete"] as Verb[]) {
      queues[verb].length = 0;
      calls[verb] = 0;
    }
    written.set.length = 0;
    written.values.length = 0;
  }

  /** Queue an answer for the next call of `verb`. */
  function queue(verb: Verb, outcome: Outcome) {
    queues[verb].push(outcome);
  }

  return { db, calls, written, reset, queue };
});

vi.mock("@/db", () => ({ db: fake.db }));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/session", () => ({
  requireOwner: vi.fn(),
  getOwnerHouse: vi.fn(),
}));

vi.mock("@/lib/emails", () => ({
  sendBookingConfirmed: vi.fn(),
  sendBookingDeclined: vi.fn(),
}));

import { revalidatePath } from "next/cache";
import { DrizzleQueryError } from "drizzle-orm/errors";

import type { Booking, House } from "@/db/schema";
import { sendBookingConfirmed, sendBookingDeclined } from "@/lib/emails";
import { getOwnerHouse, requireOwner, type OwnerUser } from "@/lib/session";

import {
  approveBooking,
  blockDates,
  declineBooking,
  unblockDates,
  type DecisionResult,
} from "@/app/_actions/decision";

/* ============================================================
   FIXTURES
   ============================================================ */

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const HOUSE_ID = "22222222-2222-4222-8222-222222222222";
const BOOKING_ID = "33333333-3333-4333-8333-333333333333";

const OWNER = {
  id: OWNER_ID,
  name: "Ozan",
  email: "owner@example.com",
  emailVerified: true,
  image: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
} as unknown as OwnerUser;

const HOUSE: House = {
  id: HOUSE_ID,
  ownerId: OWNER_ID,
  slug: "summerhouse01",
  name: "Çeşme evi",
  town: "Çeşme",
  country: "Türkiye",
  language: "tr",
  blurb: null,
  minNights: 2,
  maxNights: 14,
  gapDays: 1,
  maxGuests: 6,
  bookableFrom: "2026-06-01",
  bookableTo: "2026-09-30",
  showGuestNames: true,
  feedToken: "feedtoken1234567",
  googleCalendarId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const PENDING: Booking = {
  id: BOOKING_ID,
  houseId: HOUSE_ID,
  kind: "guest",
  guestName: "Ayşe Yılmaz",
  guestEmail: "ayse@example.com",
  guests: 4,
  note: "We arrive late on the Friday.",
  startDate: "2026-08-04",
  endDate: "2026-08-10",
  status: "pending",
  declineReason: null,
  token: "guesttoken123456",
  googleEventId: null,
  googleSync: "none",
  importedFromGoogle: false,
  createdAt: new Date("2026-05-01T00:00:00Z"),
  decidedAt: null,
};

const BLOCK: Booking = {
  ...PENDING,
  kind: "block",
  guestName: null,
  guestEmail: null,
  guests: 1,
  note: "Roof repair",
  status: "confirmed",
  token: "blocktoken123456",
};

const booking = (patch: Partial<Booking> = {}): Booking => ({ ...PENDING, ...patch });

/** What `ownedBooking` gets back: the booking joined to its house. */
function found(row: Booking = PENDING, house: House = HOUSE) {
  fake.queue("select", { rows: [{ booking: row, house }] });
}

/** Nothing came back — wrong id, or someone else's house. */
function notFound() {
  fake.queue("select", { rows: [] });
}

/* ============================================================
   ERRORS
   ============================================================ */

/** A postgres.js error: the code lives on the error itself. */
function pgError(code: string, message = `SQLSTATE ${code}`) {
  return Object.assign(new Error(message), { code });
}

/**
 * What actually reaches an action at runtime, using Drizzle's own wrapper
 * rather than a lookalike. `pg-core/session.js` throws
 * `new DrizzleQueryError(query, params, cause)` for every failed statement, so
 * the top-level error has no `code` at all — verified against the real
 * database, where an overlapping approval arrives as a `DrizzleQueryError`
 * whose `cause` is a `PostgresError` with `code: '23P01'` and
 * `constraint_name: 'bookings_no_overlap'`.
 */
function wrapped(cause: Error) {
  return new DrizzleQueryError(
    "update bookings set status = $1 where id = $2",
    ["confirmed", BOOKING_ID],
    cause,
  );
}

const TAKEN = "Those dates were taken while you were deciding.";

/* ============================================================
   SETUP
   ============================================================ */

/** Silenced, but still counted: several tests below assert what reached it. */
const errors = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  fake.reset();
  // Clears every call record, including the console spy's.
  vi.resetAllMocks();

  errors.mockImplementation(() => {});
  vi.mocked(requireOwner).mockResolvedValue(OWNER);
  vi.mocked(getOwnerHouse).mockResolvedValue(HOUSE);
  vi.mocked(sendBookingConfirmed).mockResolvedValue(undefined);
  vi.mocked(sendBookingDeclined).mockResolvedValue(undefined);
});

/* ============================================================
   approveBooking — the overlap constraint
   ============================================================ */

describe("approveBooking: the dates were taken", () => {
  it("turns a bare 23P01 into one sentence", async () => {
    found();
    fake.queue("update", { error: pgError("23P01", "conflicting key value violates exclusion constraint") });

    const result = await approveBooking(BOOKING_ID);

    expect(result).toEqual({ ok: false, error: TAKEN });
  });

  it("turns a 23P01 wrapped by Drizzle into the same sentence", async () => {
    // The case that actually happens: `error.code` is undefined, and the
    // postgres.js error carrying 23P01 hangs off `cause`.
    found();
    fake.queue("update", { error: wrapped(pgError("23P01")) });

    const result = await approveBooking(BOOKING_ID);

    expect(result).toEqual({ ok: false, error: TAKEN });
  });

  it("finds 23P01 even when the wrapper carries a code of its own", async () => {
    // A wrapper's unrelated `code` must not shadow the SQLSTATE underneath it.
    found();
    const outer = wrapped(pgError("23P01"));
    (outer as { code?: string }).code = "EPIPE";
    fake.queue("update", { error: outer });

    const result = await approveBooking(BOOKING_ID);

    expect(result).toEqual({ ok: false, error: TAKEN });
  });

  it("never sends a confirmation for a booking it could not confirm", async () => {
    found();
    fake.queue("update", { error: pgError("23P01") });

    await approveBooking(BOOKING_ID);

    expect(sendBookingConfirmed).not.toHaveBeenCalled();
  });

  it("does not look for the clash before it writes", async () => {
    // The check-then-write race is the reason the constraint exists. One read
    // (the booking) and one write, and no availability query in between.
    found();
    fake.queue("update", { rows: [booking({ status: "confirmed" })] });

    await approveBooking(BOOKING_ID);

    expect(fake.calls.select).toBe(1);
    expect(fake.calls.update).toBe(1);
  });
});

describe("approveBooking: a real fault stays visible", () => {
  it("does not dress an unrelated error as a double-booking", async () => {
    found();
    fake.queue("update", { error: new Error("column bookings.decided_at does not exist") });

    const result = await approveBooking(BOOKING_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).not.toBe(TAKEN);
    expect(result.error).toBe("The approval did not save. Try again in a moment.");
  });

  it("logs the original error, untouched", async () => {
    const bug = new Error("connection terminated unexpectedly");
    found();
    fake.queue("update", { error: bug });

    await approveBooking(BOOKING_ID);

    expect(errors).toHaveBeenCalledWith("[approveBooking] update failed", bug);
  });

  it("does not mistake a neighbouring SQLSTATE for the overlap", async () => {
    for (const code of ["23505", "23503", "23514", "22P02", "40001"]) {
      fake.reset();
      found();
      fake.queue("update", { error: wrapped(pgError(code)) });

      const result = await approveBooking(BOOKING_ID);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected a refusal");
      expect(result.error, `${code} read as an overlap`).not.toBe(TAKEN);
    }
  });

  it("refuses a cyclic error rather than looping on it", async () => {
    const loop = new Error("round and round");
    (loop as { cause?: unknown }).cause = loop;
    found();
    fake.queue("update", { error: loop });

    const result = await approveBooking(BOOKING_ID);

    expect(result.ok).toBe(false);
  });
});

/* ============================================================
   approveBooking — the happy path
   ============================================================ */

describe("approveBooking", () => {
  it("confirms the booking and stamps when it was decided", async () => {
    found();
    fake.queue("update", { rows: [booking({ status: "confirmed" })] });

    const result = await approveBooking(BOOKING_ID);

    expect(result).toEqual({ ok: true });

    const set = fake.written.set[0] as Record<string, unknown>;
    expect(set.status).toBe("confirmed");
    expect(set.decidedAt).toBeInstanceOf(Date);
    // A reason from an earlier decision would be a lie on a confirmed stay.
    expect(set.declineReason).toBeNull();
  });

  it("sends the guest their confirmation, with the row as it now stands", async () => {
    const confirmed = booking({ status: "confirmed", decidedAt: new Date() });
    found();
    fake.queue("update", { rows: [confirmed] });

    await approveBooking(BOOKING_ID);

    expect(sendBookingConfirmed).toHaveBeenCalledWith(HOUSE, confirmed);
  });

  it("keeps the approval when the mail fails", async () => {
    found();
    fake.queue("update", { rows: [booking({ status: "confirmed" })] });
    vi.mocked(sendBookingConfirmed).mockRejectedValueOnce(new Error("resend is down"));

    const result = await approveBooking(BOOKING_ID);

    expect(result).toEqual({ ok: true });
    expect(errors).toHaveBeenCalled();
  });

  it("refreshes the dashboard, the house page, and the guest's own page", async () => {
    found();
    fake.queue("update", { rows: [booking({ status: "confirmed" })] });

    await approveBooking(BOOKING_ID);

    expect(revalidatePath).toHaveBeenCalledWith("/app", "layout");
    expect(revalidatePath).toHaveBeenCalledWith(`/h/${HOUSE.slug}`);
    expect(revalidatePath).toHaveBeenCalledWith(`/b/${PENDING.token}`);
  });

  it("tells the owner when the request was decided in another tab", async () => {
    // The update carries `status = 'pending'` in its own WHERE, so a second
    // decision updates no rows rather than overwriting the first.
    found();
    fake.queue("update", { rows: [] });

    const result = await approveBooking(BOOKING_ID);

    expect(result).toEqual({ ok: false, error: "That request was already decided." });
    expect(sendBookingConfirmed).not.toHaveBeenCalled();
  });
});

describe("approveBooking: what it will not touch", () => {
  it("refuses an id that is not a booking id, without asking the database", async () => {
    const result = await approveBooking("not-a-uuid");

    expect(result).toEqual({ ok: false, error: "That request is not one of yours." });
    expect(fake.calls.select).toBe(0);
  });

  it("refuses a booking on somebody else's house", async () => {
    // The join is scoped by ownerId, so another owner's booking simply does not
    // come back. There is no id a caller could swap.
    notFound();

    const result = await approveBooking(BOOKING_ID);

    expect(result).toEqual({ ok: false, error: "That request is not one of yours." });
    expect(fake.calls.update).toBe(0);
  });

  it("refuses to approve dates the owner blocked", async () => {
    found(BLOCK);

    const result = await approveBooking(BOOKING_ID);

    expect(result).toEqual({
      ok: false,
      error: "Those are dates you blocked, not a request.",
    });
    expect(fake.calls.update).toBe(0);
  });

  it.each([
    ["confirmed", "You already approved that request."],
    ["declined", "You already declined that request."],
    ["cancelled", "The guest cancelled that request."],
  ] as const)("says plainly that a %s request is already answered", async (status, error) => {
    found(booking({ status }));

    const result = await approveBooking(BOOKING_ID);

    expect(result).toEqual({ ok: false, error });
    expect(fake.calls.update).toBe(0);
  });
});

/* ============================================================
   declineBooking
   ============================================================ */

describe("declineBooking", () => {
  it("declines with the owner's reason and emails the guest", async () => {
    const declined = booking({ status: "declined", declineReason: "The house is full." });
    found();
    fake.queue("update", { rows: [declined] });

    const result = await declineBooking(BOOKING_ID, "The house is full.");

    expect(result).toEqual({ ok: true });

    const set = fake.written.set[0] as Record<string, unknown>;
    expect(set.status).toBe("declined");
    expect(set.declineReason).toBe("The house is full.");
    expect(set.decidedAt).toBeInstanceOf(Date);

    expect(sendBookingDeclined).toHaveBeenCalledWith(HOUSE, declined);
  });

  it("declines without a reason at all", async () => {
    found();
    fake.queue("update", { rows: [booking({ status: "declined" })] });

    const result = await declineBooking(BOOKING_ID);

    expect(result).toEqual({ ok: true });
    expect((fake.written.set[0] as Record<string, unknown>).declineReason).toBeNull();
  });

  it("reads a blank reason as no reason", async () => {
    found();
    fake.queue("update", { rows: [booking({ status: "declined" })] });

    await declineBooking(BOOKING_ID, "   ");

    expect((fake.written.set[0] as Record<string, unknown>).declineReason).toBeNull();
  });

  it("trims the reason it stores", async () => {
    found();
    fake.queue("update", { rows: [booking({ status: "declined" })] });

    await declineBooking(BOOKING_ID, "  Not this week.  ");

    expect((fake.written.set[0] as Record<string, unknown>).declineReason).toBe(
      "Not this week.",
    );
  });

  it("refuses a reason over 300 characters, before writing anything", async () => {
    const result = await declineBooking(BOOKING_ID, "x".repeat(301));

    expect(result).toEqual({
      ok: false,
      error: "Keep the reason to 300 characters.",
      field: "reason",
    });
    expect(fake.calls.select).toBe(0);
    expect(fake.calls.update).toBe(0);
  });

  it("accepts a reason of exactly 300 characters", async () => {
    found();
    fake.queue("update", { rows: [booking({ status: "declined" })] });

    const result = await declineBooking(BOOKING_ID, "x".repeat(300));

    expect(result).toEqual({ ok: true });
  });

  it("keeps the decline when the mail fails", async () => {
    found();
    fake.queue("update", { rows: [booking({ status: "declined" })] });
    vi.mocked(sendBookingDeclined).mockRejectedValueOnce(new Error("resend is down"));

    const result = await declineBooking(BOOKING_ID);

    expect(result).toEqual({ ok: true });
  });

  it("never says the dates were taken — nothing competes for a decline", async () => {
    // `bookings_no_overlap` only covers confirmed rows, so a failure here is a
    // fault and reads like one.
    found();
    fake.queue("update", { error: wrapped(pgError("23P01")) });

    const result = await declineBooking(BOOKING_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.error).not.toBe(TAKEN);
    expect(result.error).toBe("The decline did not save. Try again in a moment.");
  });

  it("refuses to decline dates the owner blocked", async () => {
    found(BLOCK);

    const result = await declineBooking(BOOKING_ID);

    expect(result).toEqual({
      ok: false,
      error: "Those are dates you blocked, not a request. Unblock them instead.",
    });
    expect(fake.calls.update).toBe(0);
  });

  it("refuses to decline a stay it already approved", async () => {
    found(booking({ status: "confirmed" }));

    const result = await declineBooking(BOOKING_ID);

    expect(result).toEqual({ ok: false, error: "You already approved that request." });
    expect(fake.calls.update).toBe(0);
  });

  it("refuses a booking on somebody else's house", async () => {
    notFound();

    const result = await declineBooking(BOOKING_ID);

    expect(result).toEqual({ ok: false, error: "That request is not one of yours." });
  });

  it("refreshes the guest's own page — it is where they read the answer", async () => {
    found();
    fake.queue("update", { rows: [booking({ status: "declined" })] });

    await declineBooking(BOOKING_ID);

    expect(revalidatePath).toHaveBeenCalledWith(`/b/${PENDING.token}`);
  });
});

/* ============================================================
   blockDates
   ============================================================ */

describe("blockDates", () => {
  it("writes a confirmed block with nobody in it", async () => {
    fake.queue("insert", { rows: [] });

    const result = await blockDates("2026-09-01", "2026-09-05", "Roof repair");

    expect(result).toEqual({ ok: true });

    const values = fake.written.values[0] as Record<string, unknown>;
    expect(values.houseId).toBe(HOUSE_ID);
    expect(values.kind).toBe("block");
    // A block holds dates through the same constraint as a guest's stay, which
    // only covers confirmed rows.
    expect(values.status).toBe("confirmed");
    expect(values.startDate).toBe("2026-09-01");
    expect(values.endDate).toBe("2026-09-05");
    expect(values.note).toBe("Roof repair");
    expect(values.guests).toBe(1);
    expect(values.decidedAt).toBeInstanceOf(Date);
    expect(typeof values.token).toBe("string");
    expect((values.token as string).length).toBe(16);
  });

  it("takes a block with no note", async () => {
    fake.queue("insert", { rows: [] });

    const result = await blockDates("2026-09-01", "2026-09-05");

    expect(result).toEqual({ ok: true });
    expect((fake.written.values[0] as Record<string, unknown>).note).toBeNull();
  });

  it("says plainly that the dates are gone, rather than 500ing", async () => {
    fake.queue("insert", { error: wrapped(pgError("23P01")) });

    const result = await blockDates("2026-08-04", "2026-08-10");

    expect(result).toEqual({
      ok: false,
      error: "Those dates are already taken. Pick dates the calendar shows as free.",
      field: "startDate",
    });
  });

  it("does not retry a collision it cannot win", async () => {
    fake.queue("insert", { error: pgError("23P01") });

    await blockDates("2026-08-04", "2026-08-10");

    expect(fake.calls.insert).toBe(1);
  });

  it("draws another token when two collide", async () => {
    fake.queue("insert", { error: wrapped(pgError("23505")) });
    fake.queue("insert", { rows: [] });

    const result = await blockDates("2026-09-01", "2026-09-05");

    expect(result).toEqual({ ok: true });
    expect(fake.calls.insert).toBe(2);

    const first = fake.written.values[0] as Record<string, unknown>;
    const second = fake.written.values[1] as Record<string, unknown>;
    expect(second.token).not.toBe(first.token);
  });

  it("gives up on anything that is not a collision", async () => {
    const bug = new Error("relation bookings does not exist");
    fake.queue("insert", { error: bug });

    const result = await blockDates("2026-09-01", "2026-09-05");

    expect(result).toEqual({
      ok: false,
      error: "The block did not save. Try again in a moment.",
    });
    expect(fake.calls.insert).toBe(1);
    expect(errors).toHaveBeenCalledWith("[blockDates] insert failed", bug);
  });

  it("refreshes the dashboard and the house calendar", async () => {
    fake.queue("insert", { rows: [] });

    await blockDates("2026-09-01", "2026-09-05");

    expect(revalidatePath).toHaveBeenCalledWith("/app", "layout");
    expect(revalidatePath).toHaveBeenCalledWith(`/h/${HOUSE.slug}`);
  });

  it("refuses an owner with no house yet", async () => {
    vi.mocked(getOwnerHouse).mockResolvedValue(null);

    const result = await blockDates("2026-09-01", "2026-09-05");

    expect(result).toEqual({
      ok: false,
      error: "You do not have a house yet. Add one, then block dates on it.",
    });
    expect(fake.calls.insert).toBe(0);
  });

  it.each([
    ["1 September 2026", "2026-09-05"],
    ["2026-9-1", "2026-09-05"],
    ["2026-02-30", "2026-09-05"],
    ["", "2026-09-05"],
  ])("refuses %s as a first day", async (start, end) => {
    const result = await blockDates(start, end);

    expect(result).toEqual({
      ok: false,
      error: "Write the first night as a date, like 2026-08-01.",
      field: "startDate",
    });
    expect(fake.calls.insert).toBe(0);
  });

  it("refuses a malformed last day", async () => {
    const result = await blockDates("2026-09-01", "next Tuesday");

    expect(result).toEqual({
      ok: false,
      error: "Write the day the house is free again, like 2026-08-08.",
      field: "endDate",
    });
  });

  it("refuses a block of no nights at all", async () => {
    // endDate is the day the house is free again, exactly as it is for a stay.
    const result = await blockDates("2026-09-01", "2026-09-01");

    expect(result).toEqual({
      ok: false,
      error: "A block covers at least one night. Move the last day later.",
      field: "endDate",
    });
    expect(fake.calls.insert).toBe(0);
  });

  it("refuses a last day before the first", async () => {
    const result = await blockDates("2026-09-05", "2026-09-01");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.field).toBe("endDate");
  });

  it("takes a single night", async () => {
    fake.queue("insert", { rows: [] });

    const result = await blockDates("2026-09-01", "2026-09-02");

    expect(result).toEqual({ ok: true });
  });

  it("refuses a mistyped year that would swallow the calendar", async () => {
    const result = await blockDates("2026-09-01", "2036-09-01");

    expect(result).toEqual({
      ok: false,
      error: "Block 365 nights or fewer at a time.",
      field: "endDate",
    });
    expect(fake.calls.insert).toBe(0);
  });

  it("refuses a note over 300 characters", async () => {
    const result = await blockDates("2026-09-01", "2026-09-05", "x".repeat(301));

    expect(result).toEqual({
      ok: false,
      error: "Keep the note to 300 characters.",
      field: "note",
    });
    expect(fake.calls.insert).toBe(0);
  });
});

/* ============================================================
   unblockDates
   ============================================================ */

describe("unblockDates", () => {
  it("deletes the owner's own block", async () => {
    found(BLOCK);
    fake.queue("delete", { rows: [] });

    const result = await unblockDates(BOOKING_ID);

    expect(result).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(1);
  });

  it("will not delete a guest's confirmed stay", async () => {
    // The blocking control must never become a way to erase a booking.
    found(booking({ status: "confirmed" }));

    const result = await unblockDates(BOOKING_ID);

    expect(result).toEqual({
      ok: false,
      error: "Those dates hold a guest's stay, not a block. Cancel the stay instead.",
    });
    expect(fake.calls.delete).toBe(0);
  });

  it("will not delete a pending request either", async () => {
    found(booking({ status: "pending" }));

    const result = await unblockDates(BOOKING_ID);

    expect(result.ok).toBe(false);
    expect(fake.calls.delete).toBe(0);
  });

  it("refuses a block on somebody else's house", async () => {
    notFound();

    const result = await unblockDates(BOOKING_ID);

    expect(result).toEqual({ ok: false, error: "That block is not one of yours." });
    expect(fake.calls.delete).toBe(0);
  });

  it("refuses an id that is not a booking id, without asking the database", async () => {
    const result = await unblockDates("nope");

    expect(result).toEqual({ ok: false, error: "That block is not one of yours." });
    expect(fake.calls.select).toBe(0);
  });

  it("keeps a failed delete visible", async () => {
    const bug = new Error("deadlock detected");
    found(BLOCK);
    fake.queue("delete", { error: bug });

    const result = await unblockDates(BOOKING_ID);

    expect(result).toEqual({
      ok: false,
      error: "The block did not lift. Try again in a moment.",
    });
    expect(errors).toHaveBeenCalledWith("[unblockDates] delete failed", bug);
  });

  it("refreshes the dashboard and the house calendar", async () => {
    found(BLOCK);
    fake.queue("delete", { rows: [] });

    await unblockDates(BOOKING_ID);

    expect(revalidatePath).toHaveBeenCalledWith("/app", "layout");
    expect(revalidatePath).toHaveBeenCalledWith(`/h/${HOUSE.slug}`);
  });
});

/* ============================================================
   EVERY ACTION
   ============================================================ */

describe("every action", () => {
  it("goes through requireOwner before it does anything else", async () => {
    // lib/session is the only route into auth. An action that reads the session
    // itself is an action that can forget a rule.
    found();
    fake.queue("update", { rows: [booking({ status: "confirmed" })] });
    await approveBooking(BOOKING_ID);
    expect(requireOwner).toHaveBeenCalledTimes(1);

    vi.mocked(requireOwner).mockClear();
    found();
    fake.queue("update", { rows: [booking({ status: "declined" })] });
    await declineBooking(BOOKING_ID);
    expect(requireOwner).toHaveBeenCalledTimes(1);

    vi.mocked(requireOwner).mockClear();
    fake.queue("insert", { rows: [] });
    await blockDates("2026-09-01", "2026-09-05");
    expect(requireOwner).toHaveBeenCalledTimes(1);

    vi.mocked(requireOwner).mockClear();
    found(BLOCK);
    fake.queue("delete", { rows: [] });
    await unblockDates(BOOKING_ID);
    expect(requireOwner).toHaveBeenCalledTimes(1);
  });

  it("writes copy that does not apologise", async () => {
    const refusals: string[] = [];

    notFound();
    refusals.push(await message(approveBooking(BOOKING_ID)));

    found(BLOCK);
    refusals.push(await message(approveBooking(BOOKING_ID)));

    found();
    fake.queue("update", { error: pgError("23P01") });
    refusals.push(await message(approveBooking(BOOKING_ID)));

    fake.queue("insert", { error: pgError("23P01") });
    refusals.push(await message(blockDates("2026-08-04", "2026-08-10")));

    found(booking({ status: "confirmed" }));
    refusals.push(await message(unblockDates(BOOKING_ID)));

    for (const refusal of refusals) {
      expect(refusal, "apologises").not.toMatch(/sorry|unfortunately|oops|error/i);
      expect(refusal.length, "too short to be a sentence").toBeGreaterThan(10);
      expect(refusal.trim().endsWith("."), `${refusal} is not a sentence`).toBe(true);
    }
  });
});

async function message(result: Promise<DecisionResult>): Promise<string> {
  const settled = await result;
  if (settled.ok) throw new Error("expected a refusal");
  return settled.error;
}
