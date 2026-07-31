/**
 * The calendar file is the one output nobody reviews by reading it — it goes
 * straight into Apple Calendar, Google, or Outlook, and those either accept it
 * silently or drop it silently. So the tests are the review.
 *
 * Four of them exist because the mistakes are famous: an inclusive DTEND, `\n`
 * line endings, folding by character instead of by octet, and unescaped commas.
 */

import { describe, expect, it } from "vitest";

import {
  bookingInvite,
  buildIcs,
  escapeText,
  foldLine,
  houseFeed,
  icsFilename,
  stayEvent,
  stayUid,
  type StayBooking,
  type StayHouse,
} from "@/lib/ics";

/* ============================================================
   FIXTURES AND HELPERS
   ============================================================ */

const HOUSE: StayHouse = {
  name: "Çeşme evi",
  town: "Çeşme",
  country: "Türkiye",
  language: "tr",
};

/** 4 August → 10 August 2026. Six nights, checkout on the tenth. */
const BOOKING: StayBooking = {
  id: "3f1c9a7e-0b2d-4c5f-8a1b-6d7e8f9a0b1c",
  kind: "guest",
  guestName: "Ayşe Yılmaz",
  guests: 4,
  note: null,
  startDate: "2026-08-04",
  endDate: "2026-08-10",
  status: "confirmed",
  token: "tok_abc123",
};

function booking(overrides: Partial<StayBooking>): StayBooking {
  return { ...BOOKING, ...overrides };
}

/** The physical lines of the file, as a strict reader would split them. */
function lines(ics: string): string[] {
  const parts = ics.split("\r\n");
  // The file ends with CRLF, so the split leaves one trailing empty element.
  expect(parts.at(-1)).toBe("");
  return parts.slice(0, -1);
}

/** Undo folding: CRLF followed by a single space is a continuation. */
function unfold(ics: string): string {
  return ics.replace(/\r\n /g, "");
}

/** The logical content lines, folding removed. */
function logical(ics: string): string[] {
  return lines(unfold(ics));
}

function octets(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** The one line starting with `name:` or `name;`, folding already removed. */
function prop(ics: string, name: string): string {
  const found = logical(ics).filter((line) => line.startsWith(`${name}:`) || line.startsWith(`${name};`));
  expect(found.length).toBeGreaterThan(0);
  return found[0];
}

const FIXED_NOW = new Date("2026-07-30T22:15:00.000Z");

/* ============================================================
   THE EXCLUSIVE DTEND
   ============================================================ */

describe("all-day dates", () => {
  it("writes DTEND as the checkout day itself, not the day before", () => {
    const ics = houseFeed(HOUSE, [BOOKING], { now: FIXED_NOW });

    expect(ics).toContain("DTSTART;VALUE=DATE:20260804");
    // The stay is [4 Aug, 10 Aug). VALUE=DATE makes DTEND exclusive, which is
    // the same interval — so the tenth goes in unchanged. The 9th is the bug.
    expect(ics).toContain("DTEND;VALUE=DATE:20260810");
    expect(ics).not.toContain("20260809");
  });

  it("keeps both dates untouched on the event", () => {
    const event = stayEvent({ house: HOUSE, booking: BOOKING });

    expect(event.start).toBe("2026-08-04");
    expect(event.end).toBe("2026-08-10");
  });

  it("gives a one-night stay a DTEND one day after DTSTART", () => {
    const ics = houseFeed(HOUSE, [booking({ startDate: "2026-08-04", endDate: "2026-08-05" })], {
      now: FIXED_NOW,
    });

    expect(ics).toContain("DTSTART;VALUE=DATE:20260804");
    expect(ics).toContain("DTEND;VALUE=DATE:20260805");
  });

  it("never emits DTEND equal to DTSTART", () => {
    // Availability refuses a zero-night range and the database has never held
    // one, but DTEND == DTSTART is invalid and some clients drop it in silence.
    const event = stayEvent({
      house: HOUSE,
      booking: booking({ startDate: "2026-08-04", endDate: "2026-08-04" }),
    });

    expect(event.end).toBe("2026-08-05");
  });

  it("uses VALUE=DATE, so no client reads it as midnight local time", () => {
    const ics = houseFeed(HOUSE, [BOOKING], { now: FIXED_NOW });

    expect(prop(ics, "DTSTART")).toBe("DTSTART;VALUE=DATE:20260804");
    expect(ics).not.toContain("DTSTART:2026");
  });
});

/* ============================================================
   LINE ENDINGS
   ============================================================ */

describe("line endings", () => {
  const ics = houseFeed(HOUSE, [BOOKING], { now: FIXED_NOW });

  it("uses CRLF and nothing else", () => {
    expect(ics.replace(/\r\n/g, "")).not.toContain("\n");
    expect(ics.replace(/\r\n/g, "")).not.toContain("\r");
  });

  it("terminates the last line too", () => {
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });

  it("opens and closes the calendar", () => {
    const content = lines(ics);
    expect(content[0]).toBe("BEGIN:VCALENDAR");
    expect(content.at(-1)).toBe("END:VCALENDAR");
    expect(content).toContain("BEGIN:VEVENT");
    expect(content).toContain("END:VEVENT");
  });

  it("keeps a newline inside a note out of the line structure", () => {
    const withNote = houseFeed(HOUSE, [booking({ note: "Gate code 4821\nWe arrive late" })], {
      now: FIXED_NOW,
    });

    // One DESCRIPTION line, not two — the newline is escaped, not literal.
    expect(logical(withNote).filter((l) => l.startsWith("DESCRIPTION:"))).toHaveLength(1);
  });
});

/* ============================================================
   FOLDING AT 75 OCTETS
   ============================================================ */

describe("folding", () => {
  /** 71 characters, 94 octets — and octet 75 sits inside a `ş`. */
  const LONG_NAME = "Çeşme Şirinyer Güzelbahçe Köşkü — Üzümlü Bağ Evi ve Şirin Misafirhanesi";
  const LONG_HOUSE: StayHouse = { ...HOUSE, name: LONG_NAME };
  const ics = bookingInvite(LONG_HOUSE, BOOKING, { now: FIXED_NOW });

  it("has a fixture that would actually break a naive fold", () => {
    const raw = new TextEncoder().encode(`SUMMARY:${LONG_NAME}`);
    expect(raw.length).toBeGreaterThan(75);
    // 10xxxxxx — a UTF-8 continuation byte. Cutting here splits a character.
    expect(raw[75] & 0xc0).toBe(0x80);
  });

  it("keeps every physical line inside 75 octets", () => {
    for (const line of lines(ics)) {
      expect(octets(line)).toBeLessThanOrEqual(75);
    }
  });

  it("counts octets, not characters", () => {
    const summary = lines(ics).find((line) => line.startsWith("SUMMARY:"));
    expect(summary).toBeDefined();
    // Fewer than 75 characters on a line that is at its octet limit: proof the
    // cut was driven by bytes. A character-driven fold would have taken more.
    expect(summary!.length).toBeLessThan(75);
    expect(octets(summary!)).toBeGreaterThan(70);
  });

  it("never cuts a character in half", () => {
    expect(ics).not.toContain("�");
    for (const line of lines(ics)) {
      // Round-tripping a corrupt line through UTF-8 would produce U+FFFD.
      expect(new TextDecoder().decode(new TextEncoder().encode(line))).toBe(line);
    }
  });

  it("marks continuations with a single folding space", () => {
    const folded = lines(ics).filter((line) => line.startsWith(" "));
    expect(folded.length).toBeGreaterThan(0);

    // Re-folding every unfolded line reproduces the file byte for byte: one
    // space added per fold, one space taken off per unfold. A space in the
    // value that lands on the boundary survives the round trip, which is why
    // "a continuation never starts with two spaces" would be the wrong test.
    expect(logical(ics).map(foldLine).join("\r\n") + "\r\n").toBe(ics);
  });

  it("unfolds back to the whole house name", () => {
    expect(unfold(ics)).toContain(`SUMMARY:${LONG_NAME}`);
  });

  it("leaves a short line alone", () => {
    expect(foldLine("SUMMARY:Çeşme evi")).toBe("SUMMARY:Çeşme evi");
    expect(foldLine("BEGIN:VEVENT")).toBe("BEGIN:VEVENT");
  });
});

/* ============================================================
   ESCAPING
   ============================================================ */

describe("escaping", () => {
  const NOTE = "Bringing the dog, two kids; and a\\van\nWe arrive after 22:00";
  const ics = houseFeed(HOUSE, [booking({ note: NOTE })], {
    now: FIXED_NOW,
    baseUrl: "https://yazlik.example",
  });
  const description = prop(ics, "DESCRIPTION");

  it("escapes commas, semicolons, backslashes and newlines", () => {
    expect(description).toContain("dog\\, two kids\\; and a\\\\van\\nWe arrive");
  });

  it("leaves no raw comma or semicolon in the value", () => {
    const value = description.slice("DESCRIPTION:".length);
    expect(value.replace(/\\[,;]/g, "")).not.toMatch(/[,;]/);
  });

  it("does not escape colons", () => {
    expect(ics).not.toContain("\\:");
    expect(description).toContain("after 22:00");
    expect(ics).toContain("URL:https://yazlik.example/app");
  });

  it("escapes the property values, not the property names", () => {
    expect(escapeText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    expect(escapeText("https://example.com/b/tok")).toBe("https://example.com/b/tok");
    expect(escapeText("plain")).toBe("plain");
  });

  it("escapes a backslash before it escapes anything else", () => {
    // "\," in a note is a literal backslash then a comma: "\\\," not "\\,".
    expect(escapeText("\\,")).toBe("\\\\\\,");
  });

  it("drops control characters a calendar client would reject", () => {
    expect(escapeText("a\u0000b\u0007c")).toBe("abc");
  });
});

/* ============================================================
   UIDS
   ============================================================ */

describe("uids", () => {
  it("is the same across two builds, so a re-import updates", () => {
    const first = bookingInvite(HOUSE, BOOKING, { now: new Date("2026-07-30T22:15:00.000Z") });
    const second = bookingInvite(HOUSE, BOOKING, { now: new Date("2026-08-01T09:00:00.000Z") });

    const uid = (ics: string) => prop(ics, "UID");
    expect(uid(first)).toBe(uid(second));
    // The stamps differ, which is what makes the stable UID meaningful.
    expect(prop(first, "DTSTAMP")).not.toBe(prop(second, "DTSTAMP"));
  });

  it("comes from the booking id and nothing else", () => {
    expect(stayUid(BOOKING.id)).toBe(`${BOOKING.id}@yazlik.app`);
    expect(prop(bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW }), "UID")).toBe(
      `UID:${BOOKING.id}@yazlik.app`,
    );
  });

  it("does not move with the base URL", () => {
    const local = bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW, baseUrl: "http://localhost:3100" });
    const live = bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW, baseUrl: "https://yazlik.example" });

    expect(prop(local, "UID")).toBe(prop(live, "UID"));
  });

  it("is unique per booking", () => {
    const ics = houseFeed(HOUSE, [BOOKING, booking({ id: "9c8b7a6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d" })], {
      now: FIXED_NOW,
    });
    const uids = logical(ics).filter((line) => line.startsWith("UID:"));

    expect(uids).toHaveLength(2);
    expect(new Set(uids).size).toBe(2);
  });
});

/* ============================================================
   DTSTAMP
   ============================================================ */

describe("dtstamp", () => {
  it("is UTC, in basic format", () => {
    const ics = bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW });
    expect(prop(ics, "DTSTAMP")).toBe("DTSTAMP:20260730T221500Z");
    expect(prop(ics, "DTSTAMP")).toMatch(/^DTSTAMP:\d{8}T\d{6}Z$/);
  });
});

/* ============================================================
   THE FEED
   ============================================================ */

describe("houseFeed", () => {
  const ROWS: StayBooking[] = [
    BOOKING,
    booking({
      id: "11111111-1111-4111-8111-111111111111",
      guestName: "Deniz Kaya",
      status: "pending",
      startDate: "2026-08-12",
      endDate: "2026-08-15",
    }),
    booking({
      id: "22222222-2222-4222-8222-222222222222",
      guestName: "Mert Demir",
      status: "declined",
      startDate: "2026-08-20",
      endDate: "2026-08-23",
    }),
    booking({
      id: "33333333-3333-4333-8333-333333333333",
      guestName: "Selin Arslan",
      status: "cancelled",
      startDate: "2026-08-25",
      endDate: "2026-08-28",
    }),
    booking({
      id: "44444444-4444-4444-8444-444444444444",
      kind: "block",
      guestName: null,
      guests: 1,
      note: "Roof repair",
      status: "confirmed",
      startDate: "2026-06-01",
      endDate: "2026-06-05",
    }),
  ];

  const ics = houseFeed(HOUSE, ROWS, { now: FIXED_NOW });

  it("carries only confirmed stays", () => {
    expect(logical(ics).filter((line) => line === "BEGIN:VEVENT")).toHaveLength(2);
    expect(ics).toContain("Ayşe Yılmaz");
    expect(ics).not.toContain("Deniz Kaya");
    expect(ics).not.toContain("Mert Demir");
    expect(ics).not.toContain("Selin Arslan");
  });

  it("keeps the owner's own blocks", () => {
    expect(ics).toContain("SUMMARY:Blocked");
    expect(ics).toContain("DTSTART;VALUE=DATE:20260601");
    expect(ics).toContain("DTEND;VALUE=DATE:20260605");
  });

  it("orders events by arrival", () => {
    const starts = logical(ics)
      .filter((line) => line.startsWith("DTSTART"))
      .map((line) => line.split(":")[1]);

    expect(starts).toEqual(["20260601", "20260804"]);
  });

  it("names the calendar after the house and asks to be refreshed", () => {
    expect(ics).toContain("X-WR-CALNAME:Çeşme evi");
    expect(ics).toContain("NAME:Çeşme evi");
    expect(ics).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT1H");
    expect(ics).toContain("X-PUBLISHED-TTL:PT1H");
  });

  it("is a valid empty calendar when nothing is confirmed", () => {
    const empty = houseFeed(HOUSE, [ROWS[1]], { now: FIXED_NOW });

    expect(empty).toContain("BEGIN:VCALENDAR");
    expect(empty).toContain("END:VCALENDAR");
    expect(empty).not.toContain("BEGIN:VEVENT");
  });

  it("does not mutate the array it was handed", () => {
    const rows = [...ROWS];
    houseFeed(HOUSE, rows, { now: FIXED_NOW });
    expect(rows).toEqual(ROWS);
  });
});

/* ============================================================
   TITLES AND LINKS
   ============================================================ */

describe("titles", () => {
  it("tells the owner who is in the house", () => {
    const ics = houseFeed(HOUSE, [BOOKING], { now: FIXED_NOW });
    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:Ayşe Yılmaz · 4 guests");
  });

  it("counts one guest in the singular", () => {
    const ics = houseFeed(HOUSE, [booking({ guests: 1 })], { now: FIXED_NOW });
    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:Ayşe Yılmaz · 1 guest");
  });

  it("tells the guest where they are going", () => {
    const ics = bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW });
    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:Çeşme evi");
  });

  it("titles a block as the owner's own dates, not as a nameless guest", () => {
    const ics = houseFeed(HOUSE, [booking({ kind: "block", guestName: null, guests: 1 })], {
      now: FIXED_NOW,
    });

    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:Blocked");
    expect(ics).not.toContain("Someone");
    expect(ics).not.toContain("guest");
  });

  it("falls back to Someone for a guest row with no name", () => {
    const ics = houseFeed(HOUSE, [booking({ guestName: null })], { now: FIXED_NOW });
    expect(prop(ics, "SUMMARY")).toBe("SUMMARY:Someone · 4 guests");
  });

  it("puts the town in LOCATION, in the house's language for a guest", () => {
    const ics = bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW });
    expect(prop(ics, "LOCATION")).toBe("LOCATION:Çeşme\\, Türkiye");
  });
});

describe("links", () => {
  it("sends the guest to their own booking", () => {
    const ics = bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW, baseUrl: "https://yazlik.example" });
    expect(ics).toContain("URL:https://yazlik.example/b/tok_abc123");
  });

  it("sends the owner to the dashboard", () => {
    const ics = houseFeed(HOUSE, [BOOKING], { now: FIXED_NOW, baseUrl: "https://yazlik.example/" });
    expect(ics).toContain("URL:https://yazlik.example/app");
    expect(ics).not.toContain("tok_abc123");
  });
});

/* ============================================================
   CALENDAR HEADER
   ============================================================ */

describe("calendar header", () => {
  it("declares the version, scale and method", () => {
    const ics = bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW });

    expect(ics).toContain("VERSION:2.0");
    expect(ics).toContain("CALSCALE:GREGORIAN");
    // PUBLISH, not REQUEST: an event to keep, not an invitation to RSVP to.
    expect(ics).toContain("METHOD:PUBLISH");
    expect(prop(ics, "PRODID")).toContain("Yazlık");
  });

  it("leaves the refresh hint off a one-off invite", () => {
    const ics = bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW });

    expect(ics).not.toContain("REFRESH-INTERVAL");
    expect(ics).not.toContain("X-PUBLISHED-TTL");
  });

  it("maps the booking status onto the event", () => {
    const confirmed = stayEvent({ house: HOUSE, booking: BOOKING });
    const pending = stayEvent({ house: HOUSE, booking: booking({ status: "pending" }) });
    const cancelled = stayEvent({ house: HOUSE, booking: booking({ status: "cancelled" }) });

    expect(confirmed.status).toBe("CONFIRMED");
    expect(pending.status).toBe("TENTATIVE");
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("marks an all-day stay as free time", () => {
    const ics = bookingInvite(HOUSE, BOOKING, { now: FIXED_NOW });
    expect(ics).toContain("TRANSP:TRANSPARENT");
    expect(ics).toContain("SEQUENCE:0");
  });

  it("builds a bare calendar from raw events", () => {
    const ics = buildIcs(
      [{ uid: "one@yazlik.app", start: "2026-08-04", end: "2026-08-10", summary: "Test" }],
      { now: FIXED_NOW },
    );

    expect(logical(ics)).toContain("SUMMARY:Test");
    expect(logical(ics)).toContain("STATUS:CONFIRMED");
    expect(ics).not.toContain("X-WR-CALNAME");
  });
});

/* ============================================================
   FILENAME
   ============================================================ */

describe("icsFilename", () => {
  it("transliterates Turkish rather than emitting mojibake", () => {
    expect(icsFilename("Çeşme evi")).toBe("cesme-evi.ics");
    expect(icsFilename("Üzümlü Bağ Evi")).toBe("uzumlu-bag-evi.ics");
  });

  it("falls back when a name has nothing ASCII in it", () => {
    expect(icsFilename("— —")).toBe("stay.ics");
    expect(icsFilename("")).toBe("stay.ics");
  });
});
