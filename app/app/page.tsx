/**
 * `/app` — the owner's one screen.
 *
 * Pending requests first, then upcoming stays, then the link. That order is the
 * order of urgency: somebody is waiting on the first list, nobody is waiting on
 * the other two.
 *
 * ### The clash is computed here, before anybody taps
 *
 * Two pending requests on the same week is a *correct* state — the plan is
 * explicit that the owner should see the clash and choose. What would not be
 * correct is finding out by tapping approve and reading an error. So every
 * pending request is compared with {@link rangesOverlap} against two things:
 *
 * - **the other pending requests** → `clashes`, drawn on both cards, because
 *   approving either one rules the other out;
 * - **every confirmed range** (`busyRanges`, stays and owner blocks alike) →
 *   `taken`, which removes the approve button entirely and leaves decline.
 *
 * `approveBooking` revalidates this route, so approving one of a clashing pair
 * repaints the loser as taken in the same round trip — the card resolves itself
 * rather than sitting there stale, offering an approval the database will refuse.
 *
 * That is a *display* of the constraint, never a substitute for it. The race
 * between this render and the tap that follows belongs to `bookings_no_overlap`,
 * and the sentence it produces lands on the card.
 *
 * ### One primary action
 *
 * Approve carries the accent. Phase 2 gave it to "Share the house" because that
 * was the only thing to do here; with a decision on screen the share link is a
 * quiet line at the bottom. Block dates and decline are outline buttons — the
 * same 44px target, none of the colour.
 */

import Link from "next/link";
import { and, asc, eq, gte } from "drizzle-orm";

import { db } from "@/db";
import { bookings, type Booking } from "@/db/schema";
import { disabledDates } from "@/lib/availability";
import { busyRanges, houseRules } from "@/lib/bookings";
import { formatDay, nightsBetween, rangesOverlap, toStr } from "@/lib/dates";
import { shortRange } from "@/lib/emails";
import { requireHouse } from "@/lib/session";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

import { BlockDates, UnblockButton } from "./block-dates";
import { RequestActions } from "./request-actions";

function plural(n: number, one: string, many = `${one}s`) {
  return n === 1 ? one : many;
}

/** Blocks are the owner holding dates for themselves — no guest, no headcount. */
function stayTitle(b: Booking) {
  if (b.kind === "block") return "You blocked these dates";
  return b.guestName ?? "Someone";
}

/** One pending request, with everything the owner needs before they choose. */
type PendingCard = {
  booking: Booking;
  /** Other pending requests wanting the same nights. Approving one rules them out. */
  clashes: Booking[];
  /** A confirmed stay or block already holds these nights. Approval is gone. */
  taken: boolean;
};

export default async function DashboardPage() {
  const house = await requireHouse();
  const today = toStr(new Date());

  const [pending, upcoming, busy] = await Promise.all([
    db
      .select()
      .from(bookings)
      .where(and(eq(bookings.houseId, house.id), eq(bookings.status, "pending")))
      .orderBy(asc(bookings.createdAt)),
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

  // What the owner's own picker may not touch. `gapDays: 0` on purpose: the gap
  // is a rule about guests arriving on each other's heels, and the owner may
  // block the morning after a stay ends. The season is dropped for the same
  // reason — `min` is today and there is no `max`.
  const rules = { ...houseRules(house), gapDays: 0 };
  const takenNights = disabledDates(rules, busy, today);
  const pendingNights = disabledDates(
    rules,
    pending.map((b) => ({ startDate: b.startDate, endDate: b.endDate })),
    today,
  );

  return (
    <div className="flex flex-1 flex-col gap-6 py-6">
      <h1 className="sr-only">{house.name} dashboard</h1>

      {/* Pending requests --------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Pending requests</h2>
          {cards.length > 0 ? (
            <Badge variant="secondary" className="num">
              {cards.length}
            </Badge>
          ) : null}
        </div>

        {cards.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
            Nobody is waiting on you. New requests land here first.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {cards.map(({ booking, clashes, taken }) => {
              const nights = nightsBetween(booking.startDate, booking.endDate);
              return (
                <li key={booking.id}>
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle className="truncate">{stayTitle(booking)}</CardTitle>
                      <CardDescription className="num">
                        {formatDay(booking.startDate)} – {formatDay(booking.endDate)}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground">
                        <span className="num">{nights}</span>{" "}
                        {plural(nights, "night")} ·{" "}
                        <span className="num">{booking.guests}</span>{" "}
                        {plural(booking.guests, "guest")}
                      </p>
                      {booking.note ? (
                        <p className="text-sm break-words">{booking.note}</p>
                      ) : null}

                      {/* The clash, on the card, before the tap. Both requests
                          carry it — neither is the one that "came second". */}
                      {clashes.length > 0 ? (
                        <div className="flex flex-col gap-1 rounded-lg border border-dashed border-muted-foreground/60 px-3 py-2">
                          <p className="text-xs font-medium">
                            {clashes.length === 1
                              ? "Another request wants these nights."
                              : `${clashes.length} other requests want these nights.`}{" "}
                            Approving one rules the {plural(clashes.length, "other")}{" "}
                            out.
                          </p>
                          <ul className="flex flex-col gap-0.5">
                            {clashes.map((other) => (
                              <li
                                key={other.id}
                                className="num truncate text-xs text-muted-foreground"
                              >
                                {stayTitle(other)} ·{" "}
                                {shortRange(other.startDate, other.endDate, "en")}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </CardContent>
                    <CardFooter>
                      <RequestActions
                        bookingId={booking.id}
                        guestName={stayTitle(booking)}
                        taken={taken}
                      />
                    </CardFooter>
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Upcoming stays ----------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Upcoming stays</h2>

        {upcoming.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
            Nothing booked yet. Confirmed stays appear here, soonest first.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {upcoming.map((b) => {
              const nights = nightsBetween(b.startDate, b.endDate);
              return (
                <li
                  key={b.id}
                  className="flex flex-col gap-2 rounded-lg border border-border px-4 py-3"
                >
                  <div>
                    <p className="truncate text-sm font-medium">{stayTitle(b)}</p>
                    <p className="num mt-1 text-sm text-muted-foreground">
                      {formatDay(b.startDate)} – {formatDay(b.endDate)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="num">{nights}</span>{" "}
                      {plural(nights, "night")}
                      {b.kind === "guest" ? (
                        <>
                          {" · "}
                          <span className="num">{b.guests}</span>{" "}
                          {plural(b.guests, "guest")}
                        </>
                      ) : null}
                    </p>
                    {b.kind === "block" && b.note ? (
                      <p className="mt-1 text-sm break-words">{b.note}</p>
                    ) : null}
                  </div>

                  {/* Only the owner's own dates come back this way. A guest's
                      confirmed stay has no undo here — see decision.ts. */}
                  {b.kind === "block" ? <UnblockButton bookingId={b.id} /> : null}
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

      {/* Share -------------------------------------------------------------- */}
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Your link</h2>
        <p className="text-sm text-muted-foreground">
          One link for the whole house. Send it to family and they ask for the
          dates they want from their phone.
        </p>
        {/* Quiet on purpose. Approve is the primary action on this screen now,
            and the accent belongs to exactly one thing per screen — so this is
            not shadcn's `link` variant either, which paints itself `--primary`.
            Still 44px: demoted is not the same as harder to hit. */}
        <Button
          asChild
          variant="ghost"
          className="h-11 justify-start self-start px-0 text-base text-muted-foreground underline underline-offset-4 hover:bg-transparent hover:text-foreground"
        >
          <Link href="/app/share">Share the house</Link>
        </Button>
      </section>
    </div>
  );
}
