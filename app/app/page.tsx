/**
 * `/app` — the host's home screen.
 *
 * Not a dashboard. The person opening this is not administering a property;
 * they are finding out who wants the house and saying yes. So the screen is
 * built out of **people**, in this order:
 *
 * 1. **A headline that is the news.** Who is asking, or who arrives next. It is
 *    the largest thing on screen and it changes with the state of the house,
 *    because "Mehmet is asking" is worth more than a static word like
 *    "Dashboard" ever is.
 * 2. **The summer, laid out.** A scrolling strip of the open months with the
 *    weeks filled in — the model every house owner already holds in their head
 *    and the one thing two stacked lists cannot show: *shape*. One shelf per
 *    month, ink across the weeks that are spoken for, and lanes underneath —
 *    on the same shelf, not floating below it — carrying a dashed outline for
 *    each week somebody has asked about. Two people asking for one week is two
 *    outlines on two lines; see {@link dealIntoLanes}.
 * 3. **The asks**, each one a card with a face on it.
 * 4. **Who is coming**, in exactly the same card.
 * 5. **The link**, which is the whole reason the product exists.
 *
 * ### One card, twice
 *
 * A pending ask and a confirmed stay are the same object at two moments, so
 * they are the same card: circle, name in the display face, the dates spoken
 * out loud. The only difference is a firmer ring on the one that wants an
 * answer, and the fact that it carries a decision. Two containers for the same
 * thing is how a screen starts to look like a database browser.
 *
 * ### The clash is computed here, before anybody taps
 *
 * Two asks on the same week is a *correct* state — the host should see the
 * clash and choose. What would not be correct is finding out by tapping yes and
 * reading an error. So every pending request is compared with
 * {@link rangesOverlap} against two things:
 *
 * - **the other pending requests** → `clashes`, gathered into groups by
 *   {@link clashGroups}. The rule — you can only say yes to one — is a fact
 *   about the pair, so it is stated once above them, and each card carries only
 *   the name of who it is up against. Printing the whole sentence on both cards
 *   made two identical dashed boxes inside one scroll, which reads as a
 *   template rather than as a person telling you something;
 * - **every confirmed range** (`busyRanges`, stays and owner blocks alike) →
 *   `taken`, which removes the yes entirely.
 *
 * `approveBooking` revalidates this route, so approving one of a clashing pair
 * repaints the loser as taken in the same round trip — the card resolves itself
 * rather than sitting there stale, offering an approval the database will refuse.
 *
 * That is a *display* of the constraint, never a substitute for it. The race
 * between this render and the tap that follows belongs to `bookings_no_overlap`,
 * and the sentence it produces lands on the card.
 */

import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";
import { and, asc, eq, gte } from "drizzle-orm";

import { db } from "@/db";
import { bookings, type Booking } from "@/db/schema";
import { disabledDates } from "@/lib/availability";
import { busyRanges, houseRules } from "@/lib/bookings";
import { nightsBetween, rangesOverlap, toStr, type DateStr } from "@/lib/dates";
import { humanDay, humanRange } from "@/lib/i18n";
import { requireHouse } from "@/lib/session";

import { BlockDates, UnblockButton } from "./block-dates";
import { RequestActions } from "./request-actions";

/**
 * The owner's screens are English only in v1, so this is a formatter call, not
 * a translation call — `humanRange` is where the "Tue 18 – Sun 23 Aug" shape
 * lives and reimplementing it here so it could avoid a `lang` argument would
 * be two date formatters and one of them wrong.
 */
const LANG = "en" as const;

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** Counting words. People say "five nights", not "5 nights". */
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
] as const;

function spell(n: number): string {
  return WORDS[n] ?? String(n);
}

function plural(n: number, one: string, many = `${one}s`) {
  return n === 1 ? one : many;
}

function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "five nights" / "one night" — the phrase, uncapitalised. */
function nightsPhrase(n: number): string {
  return `${spell(n)} ${plural(n, "night")}`;
}

/** "Ayşe" · "Ayşe and Can" · "Ayşe, Can and Deniz". A comma before "and" is not how anyone says it. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Blocks are the owner holding the house — no guest, no headcount. */
function nameOf(b: Booking): string {
  if (b.kind === "block") return b.note?.trim() || "Yours";
  return b.guestName?.trim() || "Someone";
}

/** The letter in the circle. Blocks get no letter: nobody is in them. */
function initial(b: Booking): string | null {
  if (b.kind === "block") return null;
  const name = b.guestName?.trim();
  if (!name) return null;
  return (Array.from(name)[0] ?? "").toUpperCase() || null;
}

/* ============================================================
   THE SUMMER, LAID OUT

   A month is `days * DAY_PX` wide and every stay is a slice of it, so the
   strip is to scale: a fortnight looks twice a week. Ten pixels a day puts one
   whole August on a 390px screen with the edge of September showing — enough
   to say "there is more, push it" — and leaves a week 70px, which is a first
   name. A week that is wide enough carries its name; one that is not stays
   silent. Names used to step onto the shelf beside a block too narrow to hold
   them, which reads as a label for whatever it is standing next to rather than
   for the block behind it — a stray word floating on bare paper. This is a
   picture of the shape of the summer, and every one of these people is named
   in full on a card a thumb's length below.
   ============================================================ */

const DAY_PX = 10;

/** Below this a name inside a block would be two letters and an ellipsis. */
const NAME_FITS_PX = 56;

/** One lane of the shelf: the ink row of stays, and each row of asks. */
const STAY_LANE_PX = 36;
const ASK_LANE_PX = 26;

/**
 * A month with fewer days left than this, and nothing in them, is not worth
 * opening on. Otherwise a host looking at this on the 31st gets a blank shelf
 * labelled July as the first thing on the screen, and has to scroll to find
 * the summer.
 */
const WORTH_OPENING_ON = 8;

/** How far the strip looks ahead when nothing else sets a horizon. */
const HORIZON_MONTHS = 5;

/** A stray block in 2031 must not draw a mile of empty months. */
const MAX_MONTHS = 12;

type StripMonth = {
  key: string;
  label: string;
  days: number;
  /** `YYYY-MM-01` of this month, and of the one after it. */
  first: DateStr;
  next: DateStr;
};

type StripSpan = {
  key: string;
  startDate: DateStr;
  endDate: DateStr;
  label: string;
  /** `true` when the host is holding the nights themselves. */
  held: boolean;
  /** Which row of its lane the span is drawn on. See {@link dealIntoLanes}. */
  lane: number;
};

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function firstOfMonth(year: number, month0: number): DateStr {
  return `${year}-${pad2(month0 + 1)}-01`;
}

/** `YYYY-MM-DD` sorts lexicographically, so plain string compare is date compare. */
function later(a: DateStr, b: DateStr): DateStr {
  return a > b ? a : b;
}

function daysInMonth(year: number, month0: number): number {
  // Day zero of the following month is the last day of this one.
  return new Date(year, month0 + 1, 0).getDate();
}

/**
 * Which month the strip opens on: the one holding `from`, unless its last few
 * days are empty, in which case the one after. The question a host actually
 * asks of this thing is *where do my weeks start*, and the honest answer on the
 * 31st of July is August.
 */
function openingMonth(from: DateStr, spans: StripSpan[]): DateStr {
  const year = Number(from.slice(0, 4));
  const month = Number(from.slice(5, 7)) - 1;
  const thisMonth = firstOfMonth(year, month);
  const nextMonth = firstOfMonth(month === 11 ? year + 1 : year, (month + 1) % 12);

  const left = daysInMonth(year, month) - Number(from.slice(8, 10)) + 1;
  if (left >= WORTH_OPENING_ON) return thisMonth;

  // Somebody is in the house over those last days, so they are not empty.
  const busy = spans.some((s) => s.startDate < nextMonth && s.endDate > from);
  return busy ? thisMonth : nextMonth;
}

function monthsFrom(first: DateStr, last: DateStr): StripMonth[] {
  const out: StripMonth[] = [];
  let year = Number(first.slice(0, 4));
  let month = Number(first.slice(5, 7)) - 1;
  const lastKey = last.slice(0, 7);

  while (out.length < MAX_MONTHS) {
    const key = `${year}-${pad2(month + 1)}`;
    const nextYear = month === 11 ? year + 1 : year;
    const nextMonth = (month + 1) % 12;
    out.push({
      key,
      label: MONTH_NAMES[month],
      days: daysInMonth(year, month),
      first: firstOfMonth(year, month),
      next: firstOfMonth(nextYear, nextMonth),
    });
    if (key >= lastKey) break;
    year = nextYear;
    month = nextMonth;
  }

  return out;
}

/**
 * Deal spans into rows so that two of them are never drawn on top of each
 * other.
 *
 * This is not decoration. Two cousins asking for the same week in August is the
 * single state this screen exists to resolve, and it is exactly the state a
 * one-row lane cannot draw: identical dates give identical `left` and `width`,
 * one dashed outline lands precisely on the other, and under a headline reading
 * "Two people are asking" the picture says one. So a span takes the first row
 * whose previous occupant has already left, and a clash pushes down a line.
 *
 * The rows are dealt once for the whole season rather than per month, for two
 * reasons: a stay that crosses into September stays on the line it was on in
 * August, and every month's shelf is the same height, so the strip scrolls as
 * one shelf instead of a skyline.
 */
function dealIntoLanes(spans: readonly Omit<StripSpan, "lane">[]): StripSpan[] {
  // The last night each row is spoken for. `YYYY-MM-DD` compares as a date.
  const ends: DateStr[] = [];

  return [...spans]
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : 0))
    .map((span) => {
      const found = ends.findIndex((end) => end <= span.startDate);
      const lane = found === -1 ? ends.length : found;
      // Chosen because it was free at `startDate`, so this end is the later one.
      ends[lane] = span.endDate;
      return { ...span, lane };
    });
}

/** How many rows {@link dealIntoLanes} ended up needing. */
function laneCount(spans: readonly StripSpan[]): number {
  return spans.reduce((most, span) => Math.max(most, span.lane + 1), 0);
}

/** One span, clipped to one month and measured for drawing. */
type Piece = {
  key: string;
  label: string;
  held: boolean;
  lane: number;
  /** Percentages of the month's width. */
  left: string;
  width: string;
  /** Wide enough to hold its own name. Narrower than that, it says nothing. */
  named: boolean;
};

/** Every span that touches `month`, measured against that month's width. */
function placeInMonth(spans: readonly StripSpan[], month: StripMonth): Piece[] {
  const pct = (days: number) => `${(days / month.days) * 100}%`;
  const pieces: Piece[] = [];

  for (const span of spans) {
    const start = later(span.startDate, month.first);
    const end = span.endDate < month.next ? span.endDate : month.next;
    if (end <= start) continue;

    const from = Number(start.slice(8, 10)) - 1;
    const to = end === month.next ? month.days : Number(end.slice(8, 10)) - 1;
    if (to <= from) continue;

    const nights = to - from;
    pieces.push({
      key: span.key,
      label: span.label,
      held: span.held,
      lane: span.lane,
      left: pct(from),
      width: pct(nights),
      named: nights * DAY_PX >= NAME_FITS_PX,
    });
  }

  return pieces;
}

/* ============================================================
   PIECES

   One card treatment, used by an ask and by a confirmed stay alike. Written
   here rather than lifted into `components/` because nothing else in the
   product renders a person, and a shared component would be a second place to
   look for the answer to "what does a stay look like".
   ============================================================ */

const CARD = "rounded-xl bg-card p-4 ring-1 ring-foreground/10";

function Face({ letter }: { letter: string | null }) {
  if (!letter) {
    // Nobody is in an owner block, so the circle is empty and dashed — the same
    // shape the calendar uses for nights that are spoken for but not slept in.
    return (
      <span
        aria-hidden="true"
        className="size-12 shrink-0 rounded-full border border-dashed border-foreground/30"
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-12 shrink-0 items-center justify-center rounded-full bg-secondary font-heading text-lg text-foreground"
    >
      {letter}
    </span>
  );
}

function Who({ booking }: { booking: Booking }) {
  return (
    <div className="flex items-center gap-3">
      <Face letter={initial(booking)} />
      <div className="min-w-0">
        {/* A size below the headline on purpose. Six names all set at the size
            of the news is a screen with no news on it. */}
        <h3 className="font-heading text-xl leading-none break-words">
          {nameOf(booking)}
        </h3>
        <p className="num mt-1.5 text-base">
          {humanRange(booking.startDate, booking.endDate, LANG)}
        </p>
      </div>
    </div>
  );
}

/** One pending request, with everything the host needs before they choose. */
type PendingCard = {
  booking: Booking;
  /** Other asks wanting the same nights. Saying yes to one rules them out. */
  clashes: Booking[];
  /** A confirmed stay or an owner block already holds these nights. */
  taken: boolean;
};

/**
 * The asks that are competing, gathered into the sets that resolve together.
 *
 * Walked transitively rather than pairwise: three asks over one fortnight can
 * clash A–B and B–C without A and C sharing a night, and they are still one
 * decision. Almost always there is one group of two, and that is the sentence
 * above the pair.
 */
function clashGroups(cards: readonly PendingCard[]): Booking[][] {
  const byId = new Map(cards.map((card) => [card.booking.id, card]));
  const seen = new Set<string>();
  const groups: Booking[][] = [];

  for (const card of cards) {
    if (card.clashes.length === 0 || seen.has(card.booking.id)) continue;

    const group = [card.booking];
    seen.add(card.booking.id);
    // `group` grows as it is walked — a queue that keeps its own answer.
    for (let i = 0; i < group.length; i++) {
      for (const other of byId.get(group[i].id)?.clashes ?? []) {
        if (seen.has(other.id)) continue;
        seen.add(other.id);
        group.push(other);
      }
    }
    groups.push(group);
  }

  return groups;
}

export default async function DashboardPage() {
  const house = await requireHouse();
  const today = toStr(new Date());

  const [pending, upcoming, busy] = await Promise.all([
    db
      .select()
      .from(bookings)
      .where(and(eq(bookings.houseId, house.id), eq(bookings.status, "pending")))
      .orderBy(asc(bookings.startDate)),
    db
      .select()
      .from(bookings)
      .where(
        and(
          eq(bookings.houseId, house.id),
          eq(bookings.status, "confirmed"),
          gte(bookings.endDate, today),
        ),
      )
      .orderBy(asc(bookings.startDate)),
    // Every confirmed range, past ones included — a pending request can sit
    // anywhere, and `upcoming` has already dropped what is behind us.
    busyRanges(house.id),
  ]);

  const cards: PendingCard[] = pending.map((booking) => ({
    booking,
    clashes: pending.filter(
      (other) =>
        other.id !== booking.id &&
        rangesOverlap(
          booking.startDate,
          booking.endDate,
          other.startDate,
          other.endDate,
        ),
    ),
    taken: busy.some((range) =>
      rangesOverlap(booking.startDate, booking.endDate, range.startDate, range.endDate),
    ),
  }));

  // What the host's own picker may not touch. `gapDays: 0` on purpose: the gap
  // is a rule about guests arriving on each other's heels, and the host may
  // block the morning after a stay ends. The season is dropped for the same
  // reason — `min` is today and there is no `max`.
  const rules = { ...houseRules(house), gapDays: 0 };
  const takenNights = disabledDates(rules, busy, today);
  const pendingNights = disabledDates(
    rules,
    pending.map((b) => ({ startDate: b.startDate, endDate: b.endDate })),
    today,
  );

  /* --- The headline is the news --------------------------------------- */

  const arriving = upcoming.find((b) => b.kind === "guest");
  const headline = (() => {
    if (pending.length === 1) {
      const only = pending[0];
      const name = only.guestName?.trim();
      return name ? `${name} is asking` : "Someone is asking";
    }
    if (pending.length > 1) return `${sentence(spell(pending.length))} people are asking`;
    if (arriving) {
      const name = arriving.guestName?.trim() || "Someone";
      if (arriving.startDate === today) return `${name} arrives today`;
      if (arriving.startDate < today) return `${name} is here`;
      return `${name} arrives ${humanDay(arriving.startDate, LANG)}`;
    }
    return "Nobody has asked yet";
  })();

  /* --- The summer, laid out -------------------------------------------- */

  const staying = dealIntoLanes(
    upcoming.map((b) => ({
      key: b.id,
      startDate: b.startDate,
      endDate: b.endDate,
      label: nameOf(b),
      held: b.kind === "block",
    })),
  );
  const asked = dealIntoLanes(
    pending.map((b) => ({
      key: b.id,
      startDate: b.startDate,
      endDate: b.endDate,
      label: nameOf(b),
      held: false,
    })),
  );

  // `bookings_no_overlap` keeps confirmed nights to one row, so the ink lane is
  // dealt for symmetry and stays a single line in practice. The asks are where
  // the rows are earned.
  const stayLanes = Math.max(1, laneCount(staying));
  const askLanes = laneCount(asked);

  const seasonFrom = openingMonth(later(house.bookableFrom ?? today, today), [
    ...staying,
    ...asked,
  ]);
  const bookedTo = [...pending, ...upcoming].reduce(
    (furthest, b) => later(furthest, b.endDate),
    seasonFrom,
  );
  const horizon = (() => {
    if (house.bookableTo) return later(house.bookableTo, bookedTo);
    const months = Number(seasonFrom.slice(5, 7)) - 1 + HORIZON_MONTHS;
    const ahead = firstOfMonth(
      Number(seasonFrom.slice(0, 4)) + Math.floor(months / 12),
      months % 12,
    );
    return later(ahead, bookedTo);
  })();

  const months = monthsFrom(seasonFrom, horizon);

  /* --- The clash, said once --------------------------------------------- */

  const groups = clashGroups(cards);
  const clash =
    groups.length === 1
      ? `${listOf(groups[0].map(nameOf))} asked for the same week. You can only say yes to one.`
      : groups.length > 1
        ? "Some of these asks want the same nights. Each week can only go to one of them."
        : null;

  return (
    <div className="flex flex-1 flex-col gap-10 pt-5 pb-4">
      {/* Headline + the summer ---------------------------------------------- */}
      <section className="flex flex-col gap-5">
        {/* The news, and the largest thing on the screen — a step above the
            names on the cards, which are the second-largest. */}
        <h1 className="text-3xl text-balance">{headline}</h1>

        {/* Everything drawn here is also written out in the lists below, so the
            strip is a picture and nothing else. Announcing it twice would make
            it worse to listen to, not better.

            It runs off the right-hand edge on any phone, so it says so: the
            last month fades into the paper instead of being sliced through the
            middle of "September", and a flick settles on a month. A word cut in
            half reads as a broken layout; a fade reads as more. */}
        <div
          aria-hidden="true"
          className="-mx-4 snap-x snap-proximity scroll-px-4 overflow-x-auto px-4 [-ms-overflow-style:none] [mask-image:linear-gradient(to_right,#000_calc(100%_-_3rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="flex w-max gap-2 pb-1">
            {months.map((month) => {
              const now = today >= month.first && today < month.next;
              const stays = placeInMonth(staying, month);
              const asks = placeInMonth(asked, month);
              return (
                <div
                  key={month.key}
                  className="shrink-0 snap-start"
                  style={{ width: month.days * DAY_PX }}
                >
                  <p className="font-heading mb-1.5 text-base leading-none">
                    {month.label}
                  </p>

                  {/* A filled shelf, not an outlined box. Bordered white on
                      warm paper reads as an empty text field, which is the last
                      thing this should look like.

                      One shelf per month, and everything about that month is on
                      it. The asks used to sit in a strip of their own below,
                      which on a quiet month drew a lone dashed pill floating in
                      the paper with nothing to belong to. Same shelf, one lane
                      lower: spoken for on top, asked about underneath, and the
                      today line crossing both. */}
                  <div className="relative overflow-hidden rounded-md bg-secondary">
                    {now ? (
                      <span
                        className="absolute inset-y-0 z-10 w-px bg-foreground/35"
                        style={{
                          left: `${((Number(today.slice(8, 10)) - 1) / month.days) * 100}%`,
                        }}
                      />
                    ) : null}

                    <div
                      className="relative"
                      style={{ height: stayLanes * STAY_LANE_PX }}
                    >
                      {stays.map((piece) => (
                        <span
                          key={piece.key}
                          style={{
                            left: piece.left,
                            width: piece.width,
                            top: piece.lane * STAY_LANE_PX,
                            height: STAY_LANE_PX,
                          }}
                          className={
                            piece.held
                              ? "absolute flex items-center overflow-hidden rounded-sm bg-foreground/25 px-1.5 text-xs"
                              : "absolute flex items-center overflow-hidden rounded-sm bg-foreground px-1.5 text-xs text-background"
                          }
                        >
                          {piece.named ? (
                            <span className="truncate">{piece.label}</span>
                          ) : null}
                        </span>
                      ))}
                    </div>

                    {/* The lanes only exist when somebody has asked, so a house
                        with no unanswered requests keeps a single-height shelf
                        rather than a strip of empty gutter. One row per clashing
                        ask: two people on one week are two outlines, stacked,
                        never one pill drawn twice. */}
                    {askLanes > 0 ? (
                      <div
                        className="relative bg-foreground/5"
                        style={{ height: askLanes * ASK_LANE_PX }}
                      >
                        {asks.map((piece) => (
                          <span
                            key={piece.key}
                            style={{
                              left: piece.left,
                              width: piece.width,
                              top: piece.lane * ASK_LANE_PX + 3,
                              height: ASK_LANE_PX - 6,
                            }}
                            className="absolute flex items-center overflow-hidden rounded-sm border border-dashed border-foreground/55 px-1.5 text-xs"
                          >
                            {piece.named ? (
                              <span className="truncate">{piece.label}</span>
                            ) : null}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      {/* The asks ----------------------------------------------------------- */}
      {cards.length > 0 ? (
        <section className="flex flex-col gap-4">
          {/* Said once, above the pair it is about. It used to sit inside both
              cards, word for word, which is a template talking — and the second
              one taught the host nothing the first had not. */}
          {clash ? (
            <p className="rounded-lg border border-dashed border-foreground/40 px-3 py-2 text-sm">
              {clash}
            </p>
          ) : null}

          <ul className="flex flex-col gap-4">
            {cards.map(({ booking, clashes, taken }) => {
              const nights = nightsBetween(booking.startDate, booking.endDate);
              return (
                <li key={booking.id}>
                  <article className={`${CARD} ring-foreground/25`}>
                    <Who booking={booking} />

                    <p className="mt-3 text-sm text-muted-foreground">
                      {sentence(nightsPhrase(nights))}, {spell(booking.guests)}{" "}
                      {plural(booking.guests, "person", "people")}
                    </p>

                    {/* Only who, not the rule — that is already stated above the
                        pair, and a host reading down the cards needs to know
                        which of them this one is up against. */}
                    {clashes.length > 0 ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        Same week as {listOf(clashes.map(nameOf))}.
                      </p>
                    ) : null}

                    {/* Their own words, at a size a person can read. */}
                    {booking.note ? (
                      <p className="mt-3 border-l border-border pl-3 text-base break-words">
                        {booking.note}
                      </p>
                    ) : null}

                    <div className="mt-4">
                      <RequestActions
                        bookingId={booking.id}
                        guestName={nameOf(booking)}
                        taken={taken}
                      />
                    </div>
                  </article>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* Who is coming ------------------------------------------------------ */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">Who is coming</h2>

        {upcoming.length === 0 ? (
          <p className="text-base text-muted-foreground">
            Nobody yet. Every week is open.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {upcoming.map((b) => {
              const nights = nightsBetween(b.startDate, b.endDate);
              return (
                <li key={b.id}>
                  <article className={CARD}>
                    <Who booking={b} />

                    <p className="mt-3 text-sm text-muted-foreground">
                      {sentence(nightsPhrase(nights))}
                      {b.kind === "guest" ? (
                        <>
                          , {spell(b.guests)}{" "}
                          {plural(b.guests, "person", "people")}
                        </>
                      ) : null}
                    </p>

                    {/* A block's note is already its name up there. A guest's is
                        the sentence they wrote when they asked, and it stays on
                        the card after the yes — it is the reason you remember
                        the week. */}
                    {b.kind === "guest" && b.note ? (
                      <p className="mt-3 border-l border-border pl-3 text-base break-words">
                        {b.note}
                      </p>
                    ) : null}

                    {/* Only the host's own nights come back this way. A guest's
                        confirmed stay has no undo here — see decision.ts. The
                        rule above it is there so the control cannot be mistaken
                        for one more line of prose. */}
                    {b.kind === "block" ? (
                      <div className="mt-3 -mb-2 border-t border-border pt-1">
                        <UnblockButton bookingId={b.id} />
                      </div>
                    ) : null}
                  </article>
                </li>
              );
            })}
          </ul>
        )}

        <BlockDates
          today={today}
          takenDates={[...takenNights]}
          pendingDates={[...pendingNights]}
        />
      </section>

      {/* The link ----------------------------------------------------------- */}
      {/* The mechanism the whole product exists to deliver, so it is a target
          you could hit with your eyes shut. It takes the ink only when there is
          no ask waiting: exactly one primary action per screen, and an unanswered
          request outranks everything.

          It is set in Inter, not the display face. It sits a thumb-width under
          "Block dates", and while it wore Fraunces the two of them were the same
          rectangle in two typefaces — which reads as a pair of equals rather
          than a rank. One face for the things you tap, and the rank carried
          where it belongs: this one is a filled or outlined row, blocking dates
          is a quiet line of housekeeping with no box around it at all. */}
      <Link
        href="/app/share"
        className={
          cards.length === 0
            ? "flex min-h-14 items-center justify-between gap-3 rounded-xl bg-primary px-4 py-3 text-base font-medium text-primary-foreground"
            : "flex min-h-14 items-center justify-between gap-3 rounded-xl border border-foreground/25 px-4 py-3 text-base font-medium"
        }
      >
        <span>Share the house</span>
        <ArrowRightIcon className="size-5 shrink-0" aria-hidden="true" />
      </Link>
    </div>
  );
}
