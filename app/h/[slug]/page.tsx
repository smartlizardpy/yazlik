/**
 * `/h/[slug]` — the page that gets pasted into a family WhatsApp group.
 *
 * It opens on a phone, on mobile data, often in a car. So: one column, one
 * request, nothing that needs a second tap to understand. It is **public** —
 * there is no session anywhere in this file and there must never be one. The
 * slug is the whole credential, which is why it is a 12-character nanoid.
 *
 * ### What crosses to the client
 *
 * Not the bookings. The page loads them, turns them into two sets of *dates*,
 * and sends only those. A guest holding this link learns which nights are gone
 * and which have someone waiting on an answer — never who else asked, for how
 * many people, or what they wrote in the note. The one exception is the owner's
 * own `showGuestNames` setting, and even then the name is rendered *here*, on
 * the server, into the taken-dates list. It never travels as data.
 *
 * ### Where the rules come from
 *
 * `lib/availability.ts`, through `houseRules()`, `busyRanges()` and
 * `disabledDates()`. This file re-derives nothing. If the calendar and the
 * Server Action ever disagree about what is bookable, it will not be because
 * one of them was reimplemented here.
 */

import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";

import { PhotoStrip } from "@/components/photo-strip";
import { db } from "@/db";
import { bookings, images, type House } from "@/db/schema";
import { bookableWindow, disabledDates, type HouseRules } from "@/lib/availability";
import {
  busyRanges,
  houseBySlug,
  houseRules,
  pendingRanges,
} from "@/lib/bookings";
import { compareDates, eachDayInRange, toStr, type DateStr } from "@/lib/dates";
import {
  DEFAULT_LANG,
  dayLabel,
  rangeLabel,
  t,
  tn,
  toLang,
  type Lang,
} from "@/lib/i18n";

import { RequestSheet } from "./request-sheet";

/**
 * `generateMetadata` and the page both need the house, and they run in the same
 * request. One query, not two.
 */
const loadHouse = cache(async (slug: string) => houseBySlug(slug));

/* ============================================================
   METADATA
   ============================================================ */

/**
 * The name and the town, and **noindex**.
 *
 * This link is private. A house turning up in a search result is not a bad
 * ranking, it is a leak: the whole privacy model is that only people who were
 * sent the link have it. `nocache` keeps the snippet out of caches too.
 */
export async function generateMetadata(
  props: PageProps<"/h/[slug]">,
): Promise<Metadata> {
  const { slug } = await props.params;
  const house = await loadHouse(slug);

  const robots = {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  } as const;

  if (!house) {
    return { title: t("house.notFound.title", DEFAULT_LANG), robots };
  }

  const lang = toLang(house.language);
  return {
    title: `${house.name} — ${t("house.town", lang, {
      town: house.town,
      country: house.country,
    })}`,
    // The blurb is the owner's own words and the only description we have. It
    // is not indexed either way; this is for the WhatsApp link preview.
    description: house.blurb?.trim() || undefined,
    robots,
  };
}

/* ============================================================
   COPY HELPERS
   ============================================================ */

/** The season as one sentence, in whichever of its four shapes applies. */
function seasonLine(rules: HouseRules, lang: Lang): string {
  const { bookableFrom, bookableTo } = rules;
  if (bookableFrom && bookableTo) {
    return t("house.season", lang, {
      from: dayLabel(bookableFrom, lang),
      to: dayLabel(bookableTo, lang),
    });
  }
  if (bookableFrom) {
    return t("house.season.from", lang, { from: dayLabel(bookableFrom, lang) });
  }
  if (bookableTo) {
    return t("house.season.to", lang, { to: dayLabel(bookableTo, lang) });
  }
  return t("house.season.any", lang);
}

/** The house rules as short phrases. A gap of zero days is not worth a line. */
function ruleLines(rules: HouseRules, lang: Lang): string[] {
  const lines = [
    t("house.rules.maxGuests", lang, {
      guests: tn("count.guests", rules.maxGuests, lang),
    }),
    t("house.rules.minNights", lang, {
      nights: tn("count.nights", rules.minNights, lang),
    }),
    t("house.rules.maxNights", lang, {
      nights: tn("count.nights", rules.maxNights, lang),
    }),
  ];
  if (rules.gapDays > 0) {
    lines.push(
      t("house.rules.gapDays", lang, {
        days: tn("count.days", rules.gapDays, lang),
      }),
    );
  }
  return lines;
}

/* ============================================================
   DATA
   ============================================================ */

/** Gallery photos: both foreign keys null means it hangs on the house itself. */
async function galleryPhotos(houseId: string) {
  return db
    .select({ id: images.id, url: images.url, alt: images.alt })
    .from(images)
    .where(
      and(
        eq(images.houseId, houseId),
        isNull(images.placeId),
        isNull(images.sectionId),
      ),
    )
    .orderBy(asc(images.position), asc(images.createdAt));
}

/**
 * Who holds which confirmed range — **only** when the owner asked for that.
 *
 * `house.showGuestNames` is read as a column, not assumed. Off, this query does
 * not run at all: a name that is never selected cannot be leaked by a later
 * mistake in the markup. On, the result annotates the ranges `busyRanges()`
 * already returned; it never decides which dates are taken.
 */
async function guestNamesByRange(house: House): Promise<Map<string, string>> {
  const named = new Map<string, string>();
  if (!house.showGuestNames) return named;

  const rows = await db
    .select({
      startDate: bookings.startDate,
      endDate: bookings.endDate,
      guestName: bookings.guestName,
    })
    .from(bookings)
    .where(
      and(
        eq(bookings.houseId, house.id),
        eq(bookings.status, "confirmed"),
        // An owner's block has nobody in it. "Roof repair" is the owner's note
        // to themselves, not something a guest is owed.
        eq(bookings.kind, "guest"),
      ),
    );

  for (const row of rows) {
    const name = row.guestName?.trim();
    // A confirmed range is unique per house — the exclusion constraint makes
    // sure of it — so this key cannot collide.
    if (name) named.set(`${row.startDate}|${row.endDate}`, name);
  }
  return named;
}

/* ============================================================
   PAGE
   ============================================================ */

export default async function HousePage(props: PageProps<"/h/[slug]">) {
  const { slug } = await props.params;
  const house = await loadHouse(slug);

  // Same 404 for a slug that never existed and one that was deleted, with no
  // message in between that could be used to test whether a guess landed.
  if (!house) notFound();

  const lang = toLang(house.language);
  const rules = houseRules(house);

  // The server's day. The calendar, the client-side check and the Server Action
  // all work from this one string, so a phone with a wrong clock changes nothing.
  const today = toStr(new Date());

  const [photos, busy, pending, named] = await Promise.all([
    galleryPhotos(house.id),
    busyRanges(house.id),
    pendingRanges(house.id),
    guestNamesByRange(house),
  ]);

  const taken = disabledDates(rules, busy, today);

  // Nights someone has asked for and nobody has answered. Days that are already
  // gone are dropped: two requests on one week is a real state, but a night
  // that is taken *and* requested is simply taken, and should read that way.
  const pendingNights = new Set<DateStr>();
  for (const range of pending) {
    for (const night of eachDayInRange(range.startDate, range.endDate)) {
      if (compareDates(night, today) < 0) continue;
      if (taken.has(night)) continue;
      pendingNights.add(night);
    }
  }

  const win = bookableWindow(rules, today);

  // A season that has already closed leaves nothing to pick. `max` is a
  // check-out day, so one bookable night needs `max` to be at least a day past
  // `min`. Below that the calendar would render an empty, confusing grid.
  const open = win.max === null || compareDates(win.max, win.min) >= 1;

  const upcoming = busy
    .filter((range) => compareDates(range.endDate, today) > 0)
    .slice(0, 8);

  return (
    // The root layout is `lang="en"`; this subtree may not be. Saying so here is
    // what makes a screen reader pronounce a Turkish house in Turkish.
    <article
      lang={house.language}
      className={
        open
          ? // Clears the pinned bar in request-sheet.tsx (~86px plus the home
            // indicator). Keep the two in step: the bar must never cover the
            // last row of the calendar.
            "flex flex-col gap-6 py-6 pb-[calc(6.5rem+env(safe-area-inset-bottom))]"
          : "flex flex-col gap-6 py-6"
      }
    >
      {/* Photos ------------------------------------------------------------- */}
      {photos.length > 0 ? (
        // The negative margin cancels the layout's gutter so photos run to the
        // edge of the glass; the padding keeps the first one off it. A house
        // with no photos gets no empty box — that placeholder is for the owner.
        <PhotoStrip
          photos={photos}
          houseName={house.name}
          language={house.language}
          className="-mx-4 px-4"
        />
      ) : null}

      {/* Name, town, blurb -------------------------------------------------- */}
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight text-balance">
          {house.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("house.town", lang, { town: house.town, country: house.country })}
        </p>
      </header>

      {house.blurb?.trim() ? (
        <p className="text-base whitespace-pre-line">{house.blurb.trim()}</p>
      ) : null}

      {/* Rules -------------------------------------------------------------- */}
      <section aria-label={t("house.rules", lang)}>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {ruleLines(rules, lang).map((line) => (
            <li key={line} className="num">
              {line}
            </li>
          ))}
          <li className="num">{seasonLine(rules, lang)}</li>
        </ul>
      </section>

      {/* Calendar and the request ------------------------------------------- */}
      <section aria-labelledby="calendar-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="calendar-heading" className="text-sm font-medium">
            {t("house.calendar", lang)}
          </h2>
          {/* Only alongside a grid to tap. `house.calendar.hint` talks about
              days; this grid is nights, and the two are out by one — see the
              note in components/stay-calendar. */}
          {open ? (
            <p className="text-xs text-muted-foreground">
              {t("house.calendar.nights", lang)}
            </p>
          ) : null}
        </div>

        {open ? (
          <>
            <RequestSheet
              slug={house.slug}
              language={lang}
              rules={rules}
              today={today}
              min={win.min}
              max={win.max}
              // Arrays, not Sets: the client rebuilds them. Dates only — no
              // booking ever crosses this boundary.
              disabledDates={[...taken]}
              pendingDates={[...pendingNights]}
            />

            {/* The four states differ by shape, so the grid reads without this.
                It is here because "dashed outline" is worth naming once, and it
                names only the states actually on screen. */}
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <li className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-3 rounded-sm bg-muted"
                />
                {t("house.legend.taken", lang)}
              </li>
              {pendingNights.size > 0 ? (
                <li className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="size-3 rounded-sm outline-2 outline-dashed -outline-offset-1 outline-muted-foreground"
                  />
                  {t("house.legend.pending", lang)}
                </li>
              ) : null}
              <li className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="size-3 rounded-sm bg-foreground"
                />
                {t("house.legend.selected", lang)}
              </li>
            </ul>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {seasonLine(rules, lang)}
          </p>
        )}
      </section>

      {/* What is already gone ------------------------------------------------ */}
      {upcoming.length > 0 ? (
        <section aria-labelledby="taken-heading" className="flex flex-col gap-2">
          <h2 id="taken-heading" className="text-sm font-medium">
            {t("house.taken", lang)}
          </h2>
          <ul className="flex flex-col">
            {upcoming.map((range) => {
              // Empty whenever showGuestNames is off, so this falls through to
              // "Taken" — the date is public, the person is the owner's call.
              const who = named.get(`${range.startDate}|${range.endDate}`);
              return (
                <li
                  key={`${range.startDate}|${range.endDate}`}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border py-2 last:border-0"
                >
                  <span className="num text-sm">
                    {rangeLabel(range.startDate, range.endDate, lang)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {who ?? t("house.legend.taken", lang)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
