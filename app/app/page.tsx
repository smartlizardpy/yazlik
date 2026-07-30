import Link from "next/link";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { bookings, type Booking } from "@/db/schema";
import { formatDay, nightsBetween, toStr } from "@/lib/dates";
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

function plural(n: number, one: string, many = `${one}s`) {
  return n === 1 ? one : many;
}

/** Blocks are the owner holding dates for themselves — no guest, no headcount. */
function stayTitle(b: Booking) {
  if (b.kind === "block") return "You blocked these dates";
  return b.guestName ?? "Someone";
}

export default async function DashboardPage() {
  const house = await requireHouse();
  const today = toStr(new Date());

  const [pending, upcoming] = await Promise.all([
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
  ]);

  return (
    <div className="flex flex-1 flex-col gap-6 py-6">
      <h1 className="sr-only">{house.name} dashboard</h1>

      {/* Pending requests --------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Pending requests</h2>
          {pending.length > 0 ? (
            <Badge variant="secondary" className="num">
              {pending.length}
            </Badge>
          ) : null}
        </div>

        {pending.length === 0 ? (
          <p className="rounded-lg border border-border bg-muted/40 px-4 py-6 text-sm text-muted-foreground">
            Nobody is waiting on you. New requests land here first.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((b) => {
              const nights = nightsBetween(b.startDate, b.endDate);
              return (
                <li key={b.id}>
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle className="truncate">{stayTitle(b)}</CardTitle>
                      <CardDescription className="num">
                        {formatDay(b.startDate)} – {formatDay(b.endDate)}
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground">
                        <span className="num">{nights}</span>{" "}
                        {plural(nights, "night")} ·{" "}
                        <span className="num">{b.guests}</span>{" "}
                        {plural(b.guests, "guest")}
                      </p>
                      {b.note ? (
                        <p className="text-sm break-words">{b.note}</p>
                      ) : null}
                    </CardContent>
                    <CardFooter>
                      <p className="text-xs text-muted-foreground">
                        Deciding on requests arrives in the next update.
                      </p>
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
                  className="rounded-lg border border-border px-4 py-3"
                >
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
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Share -------------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Your link</h2>
        <p className="text-sm text-muted-foreground">
          One link for the whole house. Send it to family and they ask for the
          dates they want from their phone.
        </p>
        <Button asChild className="h-11 w-full">
          <Link href="/app/share">Share the house</Link>
        </Button>
      </section>
    </div>
  );
}
