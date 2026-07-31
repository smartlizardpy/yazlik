/**
 * The five emails.
 *
 * Two things here are worth more than the rest. The first is **escaping**: a
 * guest name, a note and a decline reason are the only strings in this product
 * that a stranger writes and somebody else's mail client renders, so `<script>`
 * gets its own test rather than a comment. The second is **never throwing**: an
 * approval that already committed must not be undone by a mail provider, so a
 * rejected `send`, a missing address and a row with an impossible date are all
 * asserted to resolve quietly.
 *
 * `@/lib/email` is mocked so nothing can ever reach the network, and `@/db` is
 * mocked so the owner-address lookup fails the same way on every machine —
 * which is exactly the failure the never-throw rule is about.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent = vi.hoisted(
  () =>
    [] as {
      to: string;
      subject: string;
      html: string;
      attachments?: { filename: string; content: string }[];
    }[],
);

vi.mock("@/lib/email", () => ({
  send: vi.fn(async (mail: (typeof sent)[number]) => {
    sent.push(mail);
  }),
}));

// No connection string in a unit test, and no accidental one either: the owner
// lookup fails deterministically, everywhere.
vi.mock("@/db", () => ({
  db: {
    select() {
      throw new Error("no database in a unit test");
    },
  },
}));

import { send } from "@/lib/email";
import {
  arrivalReminderMail,
  bookingConfirmedMail,
  bookingDeclinedMail,
  escapeHtml,
  guestCancelledMail,
  requestReceivedMail,
  sendArrivalReminder,
  sendBookingConfirmed,
  sendBookingDeclined,
  sendGuestCancelled,
  sendRequestReceived,
  shortRange,
  type MailBooking,
  type MailHouse,
} from "@/lib/emails";

/* ============================================================
   FIXTURES
   ============================================================ */

const TR_HOUSE: MailHouse = {
  ownerId: "owner_1",
  slug: "demo-house",
  name: "Çeşme evi",
  town: "Çeşme",
  country: "Türkiye",
  language: "tr",
};

const EN_HOUSE: MailHouse = { ...TR_HOUSE, name: "Cove House", language: "en" };

const BOOKING: MailBooking = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "guest",
  guestName: "Ayşe Yılmaz",
  guestEmail: "ayse@example.com",
  guests: 4,
  note: "We arrive late on the first night",
  startDate: "2026-08-04",
  endDate: "2026-08-10",
  status: "confirmed",
  declineReason: null,
  token: "vT3kQ9xLm2Pd7Rb1",
};

/** Everything a person can type that is also markup. */
const HOSTILE: MailBooking = {
  ...BOOKING,
  guestName: '<script>alert("xss")</script>',
  note: "Rock & roll <b>bold</b> \"quoted\"",
  declineReason: "<img src=x onerror=alert(1)>",
};

const BASE = "https://yazlik.test";

function links(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
}

/** The first paragraph — every message opens with the dates. */
function firstLine(html: string): string {
  return html.match(/<p[^>]*>(.*?)<\/p>/)?.[1] ?? "";
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  sent.length = 0;
  vi.mocked(send).mockClear();
  process.env.NEXT_PUBLIC_APP_URL = BASE;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

/* ============================================================
   ESCAPING — the one that matters
   ============================================================ */

describe("escaping", () => {
  it("turns markup into text", () => {
    expect(escapeHtml('<b>&"\'</b>')).toBe("&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;");
  });

  it("never lets a guest's name reach the owner as markup", () => {
    const { html } = requestReceivedMail(EN_HOUSE, HOSTILE);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("never lets a guest's note reach the owner as markup", () => {
    const { html } = requestReceivedMail(EN_HOUSE, HOSTILE);
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("Rock &amp; roll &lt;b&gt;bold&lt;/b&gt;");
  });

  it("never lets an owner's decline reason reach the guest as markup", () => {
    const { html } = bookingDeclinedMail(EN_HOUSE, {
      ...HOSTILE,
      status: "declined",
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes a house name too — the owner typed that as well", () => {
    const { html, subject } = bookingConfirmedMail(
      { ...EN_HOUSE, name: 'The <a href="#">House</a>' },
      BOOKING,
    );
    expect(html).not.toContain('<a href="#">');
    // The subject is plain text, not markup, and mail clients treat it as text.
    expect(subject).toContain('The <a href="#">House</a>');
  });
});

/* ============================================================
   SHAPE — written for a phone
   ============================================================ */

describe("shape", () => {
  const ALL = [
    ["request received", requestReceivedMail(EN_HOUSE, BOOKING)],
    ["confirmed", bookingConfirmedMail(EN_HOUSE, BOOKING)],
    ["declined", bookingDeclinedMail(EN_HOUSE, { ...BOOKING, declineReason: "Family week" })],
    ["reminder", arrivalReminderMail(EN_HOUSE, BOOKING)],
    ["cancelled", guestCancelledMail(EN_HOUSE, BOOKING)],
  ] as const;

  it("keeps every subject short enough to read on a lock screen", () => {
    for (const [name, mail] of ALL) {
      expect(mail.subject.length, `${name} subject is too long`).toBeLessThanOrEqual(78);
      expect(mail.subject.trim(), `${name} has no subject`).not.toBe("");
    }
  });

  it("puts the dates in every subject", () => {
    for (const [name, mail] of ALL) {
      expect(mail.subject, `${name} subject hides the dates`).toMatch(/August 2026/);
    }
  });

  it("puts the dates on the first line of every body", () => {
    for (const [name, mail] of ALL) {
      expect(firstLine(mail.html), `${name} buries the dates`).toContain("August 2026");
    }
  });

  it("gives every message exactly one link", () => {
    for (const [name, mail] of ALL) {
      expect(links(mail.html), `${name} has the wrong number of links`).toHaveLength(1);
    }
  });

  it("says who sent it", () => {
    for (const [name, mail] of ALL) {
      expect(mail.html, `${name} does not say where it came from`).toContain("Yazlık");
    }
  });

  it("never apologises", () => {
    for (const [name, mail] of ALL) {
      expect(`${mail.subject} ${mail.html}`, `${name} apologises`).not.toMatch(
        /sorry|apolog|unfortunately/i,
      );
    }
  });
});

/* ============================================================
   DATES
   ============================================================ */

describe("shortRange", () => {
  it("collapses a range inside one month", () => {
    expect(shortRange("2026-08-04", "2026-08-10", "en")).toBe("4–10 August 2026");
    expect(shortRange("2026-08-04", "2026-08-10", "tr")).toBe("4–10 Ağustos 2026");
  });

  it("writes both months when the range crosses one", () => {
    expect(shortRange("2026-07-28", "2026-08-03", "en")).toBe(
      "28 July 2026 – 3 August 2026",
    );
  });

  it("writes both years when the range crosses one", () => {
    expect(shortRange("2026-12-28", "2027-01-03", "tr")).toBe(
      "28 Aralık 2026 – 3 Ocak 2027",
    );
  });
});

/* ============================================================
   EACH MESSAGE
   ============================================================ */

describe("requestReceivedMail", () => {
  it("is English even when the house is not", () => {
    const { subject, html } = requestReceivedMail(TR_HOUSE, BOOKING);
    expect(subject).toBe("Ayşe Yılmaz asked for 4–10 August 2026");
    expect(html).toContain("asked to stay at");
    expect(html).not.toContain("Ağustos");
  });

  it("carries the note, the headcount and a way to reply", () => {
    const { html } = requestReceivedMail(EN_HOUSE, BOOKING);
    // The same line the dashboard draws, separator included.
    expect(html).toContain("4 August 2026 – 10 August 2026 · 6 nights · 4 guests");
    expect(html).toContain("We arrive late on the first night");
    expect(html).toContain("ayse@example.com");
  });

  it("links to the dashboard, with the same words as the buttons there", () => {
    const { html } = requestReceivedMail(EN_HOUSE, BOOKING);
    expect(links(html)).toEqual([`${BASE}/app`]);
    expect(html).toContain("Approve or decline");
  });

  it("calls a nameless guest what the dashboard calls them", () => {
    const { subject } = requestReceivedMail(EN_HOUSE, { ...BOOKING, guestName: "  " });
    expect(subject).toBe("Someone asked for 4–10 August 2026");
  });
});

describe("bookingConfirmedMail", () => {
  it("renders in the house's language", () => {
    const { subject, html } = bookingConfirmedMail(TR_HOUSE, BOOKING);
    expect(subject).toBe("Onaylandı: Çeşme evi, 4–10 Ağustos 2026");
    expect(html).toContain("6 gece · 4 kişi");
    expect(html).toContain("Ev sahibi Çeşme evi için konaklamanızı onayladı.");
  });

  it("links the guest to their own page and nowhere else", () => {
    const { html } = bookingConfirmedMail(TR_HOUSE, BOOKING);
    expect(links(html)).toEqual([`${BASE}/b/${BOOKING.token}`]);
  });

  it("attaches the calendar file", () => {
    const { html, attachments } = bookingConfirmedMail(TR_HOUSE, BOOKING);
    expect(attachments).toHaveLength(1);
    const [file] = attachments ?? [];
    expect(file.filename).toBe("cesme-evi.ics");
    expect(file.content).toContain("BEGIN:VCALENDAR");
    expect(file.content).toContain(`UID:${BOOKING.id}@yazlik.app`);
    // All-day, and DTEND is the exclusive checkout day — no arithmetic.
    expect(file.content).toContain("DTSTART;VALUE=DATE:20260804");
    expect(file.content).toContain("DTEND;VALUE=DATE:20260810");
    // The event points back at the guest's page, using the same base URL.
    expect(file.content).toContain(`${BASE}/b/${BOOKING.token}`);
    expect(html).toContain("Takvim dosyası ekte.");
  });
});

describe("bookingDeclinedMail", () => {
  const declined: MailBooking = { ...BOOKING, status: "declined" };

  it("quotes the owner's reason when there is one", () => {
    const { html } = bookingDeclinedMail(TR_HOUSE, {
      ...declined,
      declineReason: "O hafta ailem geliyor",
    });
    expect(html).toContain("Ev sahibinin notu");
    expect(html).toContain("O hafta ailem geliyor");
  });

  it("says nothing about a reason when the owner wrote none", () => {
    const { html } = bookingDeclinedMail(TR_HOUSE, declined);
    expect(html).not.toContain("Ev sahibinin notu");
  });

  it("treats a blank reason as no reason", () => {
    const { html } = bookingDeclinedMail(TR_HOUSE, { ...declined, declineReason: "   " });
    expect(html).not.toContain("Ev sahibinin notu");
  });

  it("sends the guest back to the calendar, using the button's own words", () => {
    const { html } = bookingDeclinedMail(TR_HOUSE, declined);
    expect(links(html)).toEqual([`${BASE}/h/demo-house`]);
    expect(html).toContain("Tarih iste");
  });
});

describe("arrivalReminderMail", () => {
  it("names the arrival day in the house's language", () => {
    const { subject, html } = arrivalReminderMail(TR_HOUSE, BOOKING);
    expect(subject).toBe("Yaklaşıyor: Çeşme evi, 4–10 Ağustos 2026");
    expect(html).toContain("4 Ağustos 2026 günü geliyorsunuz.");
  });

  it("points at the page the arrival details are actually on", () => {
    const { html } = arrivalReminderMail(TR_HOUSE, BOOKING);
    expect(links(html)).toEqual([`${BASE}/b/${BOOKING.token}`]);
  });
});

describe("guestCancelledMail", () => {
  it("says the whole thing in the subject", () => {
    const { subject } = guestCancelledMail(TR_HOUSE, BOOKING);
    expect(subject).toBe("Ayşe Yılmaz cancelled 4–10 August 2026");
  });

  it("is English, and says the dates came back", () => {
    const { html } = guestCancelledMail(TR_HOUSE, BOOKING);
    expect(html).toContain("The dates are free again.");
    expect(links(html)).toEqual([`${BASE}/app`]);
  });
});

/* ============================================================
   SENDING NEVER THROWS
   ============================================================ */

describe("sending", () => {
  it("addresses guest mail to the guest", async () => {
    await sendBookingConfirmed(TR_HOUSE, BOOKING);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ayse@example.com");
    expect(sent[0].attachments).toHaveLength(1);
  });

  it("sends nothing, and does not throw, when there is no address", async () => {
    await expect(
      sendBookingDeclined(TR_HOUSE, { ...BOOKING, guestEmail: null }),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("swallows a mail provider that is down", async () => {
    vi.mocked(send).mockRejectedValueOnce(new Error("Resend is on fire"));
    await expect(sendArrivalReminder(TR_HOUSE, BOOKING)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it("swallows a row whose dates cannot be read", async () => {
    await expect(
      sendBookingConfirmed(TR_HOUSE, { ...BOOKING, startDate: "not-a-date" }),
    ).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(error).toHaveBeenCalled();
  });

  it("swallows an owner lookup that cannot reach the database", async () => {
    // The approval has already committed by the time any of this runs, so a
    // dead database costs the owner a notification and nothing else.
    await expect(sendRequestReceived(EN_HOUSE, BOOKING)).resolves.toBeUndefined();
    await expect(sendGuestCancelled(EN_HOUSE, BOOKING)).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
    expect(error).toHaveBeenCalledTimes(2);
  });
});
