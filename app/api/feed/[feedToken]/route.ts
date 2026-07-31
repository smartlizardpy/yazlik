/**
 * `/api/feed/[feedToken]` — the whole house as a subscribable calendar.
 *
 * One URL, no OAuth, no account. The owner pastes it into Google, Apple or
 * Outlook and every confirmed stay turns up next to their dentist appointment.
 * This is the half of the calendar story that needs no credentials at all, so
 * it is the half that has to be right.
 *
 * ### Two spellings of the same URL
 *
 * The route accepts `/api/feed/abc123` **and** `/api/feed/abc123.ics`.
 *
 * Calendar clients disagree about this and both camps are stubborn. Outlook and
 * a good number of "add by URL" fields refuse anything that does not end in
 * `.ics`; other tools helpfully strip the extension before they fetch. Betting
 * on one spelling means the other camp sees a 404 and concludes the feed is
 * broken. Serving both costs one `replace`.
 *
 * No token this app generates contains a dot — `ID_ALPHABET` in `lib/ids.ts` is
 * lowercase letters and digits — so stripping a trailing `.ics` can never eat
 * part of a real token.
 *
 * ### What is in the file
 *
 * Every **confirmed** booking, both kinds. An owner's `kind: 'block'` row is a
 * real week when nobody else can have the house, and a calendar that hides it
 * answers "is the house free?" wrongly. Pending requests stay out: two people
 * can be asking for the same week and the owner has not chosen, so drawing them
 * would show the house as full when it is not. {@link houseFeed} enforces both
 * of those; the SQL filter here is the cheap half of the same rule.
 *
 * ### The token is a credential
 *
 * Anyone holding this URL can read who is staying and when. So:
 *
 * - **Nothing logs it.** Not on success, not on failure. The 500 path logs the
 *   house id, which is useless to anyone who does not already have the database.
 * - **Nothing reflects it.** An unknown token gets the same four bytes as a
 *   malformed one, with no echo of what was asked for — a page that repeats the
 *   token back is a page that will eventually repeat it into a log, a referrer,
 *   or an error tracker.
 * - **`private` caching**, so no shared proxy keeps a copy of someone's guest
 *   list keyed on a URL that travels in plain text.
 *
 * ### Caching a feed that is polled forever
 *
 * `no-store` is wrong here — this is the one URL in the product designed to be
 * fetched over and over by a machine. Five minutes of `max-age` collapses a
 * retry storm without ever making the owner wait meaningfully longer, and a
 * weak `ETag` turns the hourly poll into a 304 with no body at all.
 *
 * The ETag is **weak** on purpose. It is computed from the rows the file is
 * built from, not from the bytes, because the bytes carry a `DTSTAMP` of "now"
 * and would differ on every request while meaning exactly the same thing. Weak
 * comparison is precisely the "semantically equivalent, not byte-identical"
 * case, which is what `W/` is for.
 */

import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";

import { db } from "@/db";
import { bookings, houses } from "@/db/schema";
import {
  ICS_CONTENT_TYPE,
  houseFeed,
  icsFilename,
  type StayBooking,
  type StayHouse,
} from "@/lib/ics";

/** The extension a client may or may not have kept. Compared case-insensitively. */
const ICS_SUFFIX = ".ics";

/**
 * Longest token this will look up. Tokens are 16 characters; the ceiling exists
 * so a multi-kilobyte path becomes a 404 without touching the database.
 */
const MAX_TOKEN_LENGTH = 128;

/** Five minutes. Long enough to absorb a client that retries, short enough to feel live. */
const MAX_AGE_SECONDS = 300;

/**
 * How often a subscriber should come back, advertised inside the file itself.
 * An hour matches what Apple and Outlook do when left alone. Google ignores it
 * and refreshes on its own slow schedule — that is Google's, not ours, and the
 * share screen says so rather than letting the owner think the feed is stuck.
 */
const REFRESH_INTERVAL = "PT1H";

/** As in `/api/ics/[token]`: whatever reaches a header must be plain ASCII. */
const SAFE_FILENAME = /^[A-Za-z0-9._-]{1,80}$/;

const FALLBACK_FILENAME = "calendar.ics";

/** One answer for an unknown token, a truncated one, and a typo. */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** `abc123.ics` → `abc123`. Leaves a bare token, and any empty result, alone. */
function stripIcsSuffix(value: string): string {
  if (value.length <= ICS_SUFFIX.length) return value;
  const tail = value.slice(-ICS_SUFFIX.length).toLowerCase();
  return tail === ICS_SUFFIX ? value.slice(0, -ICS_SUFFIX.length) : value;
}

/**
 * A weak validator over the data the file is made of.
 *
 * Hashing the *inputs* to {@link houseFeed} rather than its output means the
 * digest is complete by construction: if a column can change the file, it is in
 * here, because it is in the argument.
 */
function weakEtag(house: StayHouse, stays: StayBooking[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({ house, stays, refresh: REFRESH_INTERVAL }))
    .digest("hex")
    .slice(0, 32);
  return `W/"${digest}"`;
}

/**
 * Does the client already hold this exact version?
 *
 * `If-None-Match` is a comma-separated list and each entry may carry the `W/`
 * prefix. RFC 9110 says weak comparison ignores that prefix, so both sides are
 * stripped before they are compared. `*` matches anything the server has.
 */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  const wanted = etag.replace(/^W\//, "");
  return header
    .split(",")
    .map((entry) => entry.trim().replace(/^W\//, ""))
    .some((entry) => entry === "*" || entry === wanted);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ feedToken: string }> },
): Promise<Response> {
  const { feedToken } = await context.params;

  const token = stripIcsSuffix(feedToken);
  if (!token || token.length > MAX_TOKEN_LENGTH) return notFound();

  const [house] = await db
    .select({
      id: houses.id,
      name: houses.name,
      town: houses.town,
      country: houses.country,
      language: houses.language,
    })
    .from(houses)
    .where(eq(houses.feedToken, token))
    .limit(1);

  if (!house) return notFound();

  // Only the columns a calendar file reads, and only confirmed rows — a
  // declined request has no business crossing the wire to a public endpoint.
  // `houseFeed` filters and sorts again; this is the half Postgres does better.
  const stays = await db
    .select({
      id: bookings.id,
      kind: bookings.kind,
      guestName: bookings.guestName,
      guests: bookings.guests,
      note: bookings.note,
      startDate: bookings.startDate,
      endDate: bookings.endDate,
      status: bookings.status,
      token: bookings.token,
    })
    .from(bookings)
    .where(and(eq(bookings.houseId, house.id), eq(bookings.status, "confirmed")))
    .orderBy(asc(bookings.startDate), asc(bookings.id));

  const calendar: StayHouse = {
    name: house.name,
    town: house.town,
    country: house.country,
    language: house.language,
  };

  const etag = weakEtag(calendar, stays);

  const slugged = icsFilename(house.name, "calendar");
  const filename = SAFE_FILENAME.test(slugged) ? slugged : FALLBACK_FILENAME;

  // Repeated on the 304 as well: a response without them tells a client that
  // has just revalidated nothing about how long the answer stays good.
  const headers: Record<string, string> = {
    etag,
    "cache-control": `private, max-age=${MAX_AGE_SECONDS}`,
    // A calendar URL should never turn up in a search result.
    "x-robots-tag": "noindex, nofollow",
  };

  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers });
  }

  let body: string;
  try {
    // `baseUrl` is left to the module's own APP_URL rather than read off this
    // request: the links inside the file must not be steerable by a Host header.
    body = houseFeed(calendar, stays, { refreshInterval: REFRESH_INTERVAL });
  } catch (error) {
    // Only reachable if a `date` column stopped holding a date. The house id is
    // enough to find it; the token is a credential and never goes in a log.
    console.error(`[api/feed] could not build the feed for house ${house.id}`, error);
    return new Response("Could not build the calendar file", {
      status: 500,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return new Response(body, {
    status: 200,
    headers: {
      ...headers,
      "content-type": ICS_CONTENT_TYPE,
      // `inline`, not `attachment`. A phone that opens this URL directly should
      // be able to hand it to the calendar app; `attachment` sends it to Files
      // instead. Subscribers ignore the header entirely.
      "content-disposition": `inline; filename="${filename}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
