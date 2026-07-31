/**
 * The calendar file builder — RFC 5545 iCalendar, by hand, no dependency.
 *
 * One builder, two callers, so they cannot drift:
 *
 * - {@link bookingInvite} — the single event attached to the confirmation email,
 *   which the guest opens once and adds to their phone.
 * - {@link houseFeed} — every confirmed stay, served from
 *   `/api/feed/[feedToken].ics` as a calendar the owner subscribes to. Same
 *   escaping, same folding, same UIDs. Fixing a bug here fixes it in both.
 *
 * Four details decide whether a real calendar app accepts the file, and all four
 * are the kind that produce "it opens in my editor, why won't Apple Calendar
 * take it" bugs:
 *
 * 1. **CRLF.** Every content line ends `\r\n`, including the last one.
 * 2. **Folding at 75 OCTETS, not characters.** `Çeşme` is multi-byte; a naive
 *    75-character fold cuts a UTF-8 sequence in half and the file is corrupt.
 *    See {@link foldLine}.
 * 3. **Escaping.** Backslash, semicolon, comma and newline inside a TEXT value.
 *    Colons are *not* escaped — escaping them is the common overcorrection and
 *    it leaks `\:` into event titles.
 * 4. **Stable UIDs.** Derived from the booking id and nothing else, so a second
 *    import updates the event a guest already has instead of duplicating it.
 */

import type { Booking, House } from "@/db/schema";
import { addDaysStr, nightsBetween, toDate, type DateStr } from "@/lib/dates";
import { t, tn, type Lang } from "@/lib/i18n";

/* ============================================================
   CONSTANTS
   ============================================================ */

const CRLF = "\r\n";

/** RFC 5545 §3.1: a content line is at most 75 octets, excluding the line break. */
const OCTET_LIMIT = 75;

/**
 * The right-hand side of every UID.
 *
 * A literal, never the request host: a UID that changed with the deployment URL
 * would duplicate every event the moment the domain moved.
 */
const UID_DOMAIN = "yazlik.app";

const PRODID = "-//Yazlık//Yazlık booking calendar//EN";

/** How often a subscribed client should re-fetch the feed. */
const DEFAULT_REFRESH = "PT1H";

/** What a block is called in a calendar. The owner holds the dates; nobody is a guest. */
const BLOCK_TITLE = "Blocked";

/** Matches `app/app/page.tsx` — a guest row with no name is still somebody. */
const UNNAMED_GUEST = "Someone";

/** Serve the feed and attach the invite as this. Both callers, one string. */
export const ICS_CONTENT_TYPE = "text/calendar; charset=utf-8";

const APP_URL =
  process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3100";

/* ============================================================
   TYPES
   ============================================================ */

export type IcsStatus = "CONFIRMED" | "TENTATIVE" | "CANCELLED";

export type IcsMethod = "PUBLISH" | "REQUEST" | "CANCEL";

/** One all-day event, already resolved to text. Dates stay `YYYY-MM-DD`. */
export type IcsEvent = {
  uid: string;
  /** Check-in day — DTSTART;VALUE=DATE. */
  start: DateStr;
  /** Check-out day — DTEND;VALUE=DATE, and exclusive. See {@link stayEvent}. */
  end: DateStr;
  summary: string;
  description?: string;
  location?: string;
  url?: string;
  status?: IcsStatus;
  /**
   * `true` marks the reader busy. All-day stays default to transparent: a week
   * in the house should not black out a week of somebody's working calendar.
   */
  opaque?: boolean;
  sequence?: number;
};

export type IcsOptions = {
  /** Calendar name — `NAME` and `X-WR-CALNAME`. Set it for a feed, skip it for an invite. */
  name?: string;
  method?: IcsMethod;
  /** ISO 8601 duration, e.g. `PT1H`. Only meaningful for a subscribed feed. */
  refreshInterval?: string;
  prodId?: string;
  /** DTSTAMP for every event. Injectable so tests are deterministic. */
  now?: Date;
};

/** Whose calendar this lands in. It decides the title and the link, nothing else. */
export type Audience = "owner" | "guest";

/** The house columns a calendar file reads. A `Pick`, so a test needs no `feedToken`. */
export type StayHouse = Pick<House, "name" | "town" | "country" | "language">;

/** The booking columns a calendar file reads. */
export type StayBooking = Pick<
  Booking,
  "id" | "kind" | "guestName" | "guests" | "note" | "startDate" | "endDate" | "status" | "token"
>;

export type StayInput = {
  house: StayHouse;
  booking: StayBooking;
  /** Default `'owner'` — the feed is the bigger caller and the safer default. */
  audience?: Audience;
  /** Absolute origin for the link in the description. Defaults to the app URL. */
  baseUrl?: string;
};

/* ============================================================
   LOW-LEVEL: ESCAPING, FOLDING, DATES
   ============================================================ */

/**
 * RFC 5545 §3.3.11. Inside a TEXT value, `\`, `;`, `,` and newlines carry
 * meaning and have to be escaped; **a colon does not**, and escaping it is
 * wrong — `\:` shows up verbatim in the event title in most clients.
 *
 * Backslash goes first, or the backslash this function introduces for `\n`
 * would be escaped a second time.
 */
export function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    // Everything else in the control range is forbidden in a TEXT value, and
    // a stray one is enough for a strict parser to reject the whole file.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

/**
 * Fold a content line to 75 **octets** per physical line, continuations
 * starting with one space.
 *
 * Counting characters instead of octets is the bug this function exists to
 * avoid. `Çeşme` is five characters and eight octets, so a 75-character fold
 * writes lines of up to 120 octets — over the limit — and, worse, a byte-level
 * reader that trims at 75 lands inside a UTF-8 sequence and the file is corrupt
 * where the mojibake starts. So: encode, cut on a code point boundary, decode.
 *
 * The continuation limit is 74, because the leading space is one of the 75.
 *
 * A cut can land next to a space in the value, so a continuation line can start
 * with two spaces. That is correct: unfolding removes the CRLF and exactly one
 * following space, and the second one is content.
 */
export function foldLine(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= OCTET_LIMIT) return line;

  const decoder = new TextDecoder();
  const parts: string[] = [];
  let offset = 0;
  let limit = OCTET_LIMIT;

  while (offset < bytes.length) {
    let end = Math.min(offset + limit, bytes.length);
    if (end < bytes.length) {
      // 10xxxxxx is a UTF-8 continuation byte. Walk back until `end` sits on
      // the first byte of a code point, so no character is cut in half.
      while (end > offset && (bytes[end] & 0xc0) === 0x80) end--;
    }
    // Unreachable — the widest code point is 4 octets and the limit is 74 —
    // but a zero-length slice here would spin forever, so it is worth a line.
    if (end === offset) end = Math.min(offset + limit, bytes.length);

    parts.push(decoder.decode(bytes.subarray(offset, end)));
    offset = end;
    limit = OCTET_LIMIT - 1;
  }

  return parts.join(`${CRLF} `);
}

/** `2026-08-04` → `20260804`. Throws on anything that is not a real day. */
function icsDate(day: DateStr): string {
  toDate(day);
  return day.replace(/-/g, "");
}

/** `20260730T221500Z`. DTSTAMP is always UTC, whatever the server's zone. */
function icsStamp(when: Date): string {
  const ms = when.getTime();
  if (Number.isNaN(ms)) throw new TypeError("Not a valid Date");
  return `${when.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

function property(name: string, value: string): string {
  return `${name}:${escapeText(value)}`;
}

/* ============================================================
   ONE STAY
   ============================================================ */

/** The one place a booking id becomes a UID. Both callers go through it. */
export function stayUid(bookingId: string): string {
  return `${bookingId}@${UID_DOMAIN}`;
}

const ICS_STATUS: Record<Booking["status"], IcsStatus> = {
  confirmed: "CONFIRMED",
  pending: "TENTATIVE",
  declined: "CANCELLED",
  cancelled: "CANCELLED",
};

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * The event title.
 *
 * A guest sees where they are going — their own name in their own calendar is
 * noise. The owner sees who is in the house, which is the entire question the
 * feed exists to answer. A `kind: 'block'` row has no guest at all, so it reads
 * as the owner's own use rather than as a guest nobody bothered to name.
 */
function stayTitle(house: StayHouse, booking: StayBooking, audience: Audience): string {
  if (audience === "guest") return house.name;
  if (booking.kind === "block") return BLOCK_TITLE;
  const name = booking.guestName?.trim();
  return `${name || UNNAMED_GUEST} · ${tn("count.guests", booking.guests, "en")}`;
}

/**
 * One confirmed stay as an **all-day** event.
 *
 * The part everyone gets wrong: an all-day event uses `VALUE=DATE`, and with
 * `VALUE=DATE` the RFC makes **DTEND exclusive** — it is the first day *not*
 * covered. That is exactly our half-open `[startDate, endDate)`, the same
 * interval the `daterange(start_date, end_date, '[)')` exclusion constraint
 * uses. So DTSTART is `startDate` and DTEND is `endDate`, unchanged, with no
 * arithmetic at all.
 *
 * The instinct is to subtract a day, because a timed event's end is inclusive
 * of the last moment and a checkout day "isn't part of the stay". That instinct
 * is wrong here: subtracting a day makes a Tuesday checkout show as Monday and
 * hides the changeover the owner needs to see. Do not add the `-1`.
 *
 * A range with no nights in it — which the availability rules refuse and the
 * database has never held — is widened to one night rather than emitted as
 * `DTEND == DTSTART`, which is invalid and which some clients drop silently.
 */
export function stayEvent(input: StayInput): IcsEvent {
  const { house, booking, audience = "owner" } = input;
  const base = trimSlash(input.baseUrl ?? APP_URL);
  const lang: Lang = audience === "guest" ? house.language : "en";

  const start = booking.startDate;
  const end = nightsBetween(start, booking.endDate) > 0 ? booking.endDate : addDaysStr(start, 1);

  const url =
    audience === "guest" && booking.token ? `${base}/b/${booking.token}` : `${base}/app`;

  const note = booking.note?.trim();
  const description = [note, url].filter(Boolean).join("\n");

  return {
    uid: stayUid(booking.id),
    start,
    end,
    summary: stayTitle(house, booking, audience),
    description,
    location: t("house.town", lang, { town: house.town, country: house.country }),
    url,
    status: ICS_STATUS[booking.status],
  };
}

function eventLines(event: IcsEvent, stamp: string): string[] {
  const lines = [
    "BEGIN:VEVENT",
    property("UID", event.uid),
    `DTSTAMP:${stamp}`,
    // No arithmetic. DTEND is the exclusive checkout day — see stayEvent.
    `DTSTART;VALUE=DATE:${icsDate(event.start)}`,
    `DTEND;VALUE=DATE:${icsDate(event.end)}`,
    property("SUMMARY", event.summary),
  ];

  if (event.description) lines.push(property("DESCRIPTION", event.description));
  if (event.location) lines.push(property("LOCATION", event.location));
  // URL is a URI value, not TEXT: it is not escaped, and must not be.
  if (event.url) lines.push(`URL:${event.url}`);

  lines.push(`STATUS:${event.status ?? "CONFIRMED"}`);
  lines.push(`TRANSP:${event.opaque ? "OPAQUE" : "TRANSPARENT"}`);
  lines.push(`SEQUENCE:${event.sequence ?? 0}`);
  lines.push("END:VEVENT");

  return lines;
}

/* ============================================================
   THE FILE
   ============================================================ */

/**
 * A complete VCALENDAR, folded, CRLF-terminated, ready to serve or attach.
 *
 * The trailing CRLF is not decoration: RFC 5545 ends *every* content line with
 * one, `END:VCALENDAR` included, and strict parsers say so.
 */
export function buildIcs(events: IcsEvent[], opts: IcsOptions = {}): string {
  const stamp = icsStamp(opts.now ?? new Date());

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    property("PRODID", opts.prodId ?? PRODID),
    "CALSCALE:GREGORIAN",
    `METHOD:${opts.method ?? "PUBLISH"}`,
  ];

  if (opts.name) {
    // NAME is RFC 7986; X-WR-CALNAME is what Google, Apple and Outlook read.
    lines.push(property("NAME", opts.name));
    lines.push(property("X-WR-CALNAME", opts.name));
  }

  if (opts.refreshInterval) {
    // Same hint twice: REFRESH-INTERVAL is the standard, X-PUBLISHED-TTL is the
    // one Outlook and older Apple builds actually honour.
    lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${opts.refreshInterval}`);
    lines.push(`X-PUBLISHED-TTL:${opts.refreshInterval}`);
  }

  for (const event of events) lines.push(...eventLines(event, stamp));

  lines.push("END:VCALENDAR");

  return lines.map(foldLine).join(CRLF) + CRLF;
}

/* ============================================================
   THE TWO CALLERS
   ============================================================ */

export type InviteOptions = { now?: Date; baseUrl?: string };

/**
 * The `.ics` attached to a confirmation email — one stay, in the guest's hands.
 *
 * `METHOD:PUBLISH`, not `REQUEST`: this is an event to keep, not an invitation
 * to reply to. `REQUEST` makes calendar clients offer accept/decline buttons
 * and mail an RSVP to an address that is not expecting one — the owner already
 * decided, and the guest already knows.
 */
export function bookingInvite(
  house: StayHouse,
  booking: StayBooking,
  opts: InviteOptions = {},
): string {
  const event = stayEvent({ house, booking, audience: "guest", baseUrl: opts.baseUrl });
  return buildIcs([event], { method: "PUBLISH", name: house.name, now: opts.now });
}

export type FeedOptions = InviteOptions & { refreshInterval?: string };

/**
 * Every confirmed stay as one subscribable calendar.
 *
 * Only `confirmed` rows. Pending requests are deliberately absent: two people
 * may ask for the same week and the owner has not chosen yet, so drawing them
 * in a calendar the owner trusts would make the house look full when it is not.
 * Blocks stay in — a block is a confirmed booking with nobody in it, and the
 * owner needs to see their own dates.
 *
 * Past stays stay in too. They cost nothing and it means the answer does not
 * depend on when the feed was fetched.
 */
export function houseFeed(
  house: StayHouse,
  bookings: StayBooking[],
  opts: FeedOptions = {},
): string {
  const events = bookings
    .filter((booking) => booking.status === "confirmed")
    .slice()
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id))
    .map((booking) => stayEvent({ house, booking, audience: "owner", baseUrl: opts.baseUrl }));

  return buildIcs(events, {
    method: "PUBLISH",
    name: house.name,
    refreshInterval: opts.refreshInterval ?? DEFAULT_REFRESH,
    now: opts.now,
  });
}

/* ============================================================
   FILENAME
   ============================================================ */

const TRANSLITERATE: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

/**
 * A filename for the attachment and for `Content-Disposition` on the feed.
 *
 * ASCII only, because a Turkish house name in a filename comes back from some
 * mail clients as `=?UTF-8?...?=` or as mojibake, and a guest should not have
 * to guess what `Ã‡eÅme.ics` is.
 */
export function icsFilename(name: string, fallback = "stay"): string {
  const slug = name
    .toLowerCase()
    .replace(/[çğıöşüâîû]/g, (c) => TRANSLITERATE[c] ?? c)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");

  return `${slug || fallback}.ics`;
}
