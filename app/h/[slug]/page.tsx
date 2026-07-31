/**
 * `/h/[slug]` — the link that gets pasted into a family WhatsApp group.
 *
 * It is an **invitation**, not a listing. A listing sells a property to a
 * stranger, which is why it opens with a town, a headcount and a minimum-night
 * policy; an invitation lets someone in, which is why this opens with the
 * house's name at forty points and the fact that they are being asked to come.
 * A host does not answer the door by reciting the rules. The calendar enforces
 * them quietly and the guest finds out when they pick.
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
 * the server, into a single sentence. It never travels as data.
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
import Image from "next/image";
import { notFound } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";

import { PhotoStrip } from "@/components/photo-strip";
import { db } from "@/db";
import { bookings, images, type House } from "@/db/schema";
import {
  bookableWindow,
  disabledDates,
  type BusyRange,
  type HouseRules,
} from "@/lib/availability";
import {
  busyRanges,
  houseBySlug,
  houseRules,
  pendingRanges,
} from "@/lib/bookings";
import { compareDates, eachDayInRange, toStr, type DateStr } from "@/lib/dates";
import { DEFAULT_LANG, t, tn, toLang, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { RequestSheet } from "./request-sheet";

/**
 * `generateMetadata`, the Open Graph image and the page all need the house, and
 * they run in the same request. One query, not three.
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
 *
 * The Open Graph block is what a phone unfurls in the group chat. The picture
 * itself comes from `opengraph-image.tsx` next door — file-based metadata wins
 * over anything named here, so this only has to supply the words.
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
  const town = t("house.town", lang, {
    town: house.town,
    country: house.country,
  });
  // The blurb is the owner's own words and the only description we have.
  const blurb = house.blurb?.trim() || undefined;

  return {
    title: `${house.name} — ${town}`,
    description: blurb,
    openGraph: {
      title: house.name,
      description: blurb ?? town,
      type: "website",
      locale: lang === "tr" ? "tr_TR" : "en_GB",
    },
    twitter: {
      card: "summary_large_image",
      title: house.name,
      description: blurb ?? town,
    },
    robots,
  };
}

/* ============================================================
   COPY
   ============================================================ */

/** `2026-08-01` → `August`. The month a person says, not the date they file. */
function monthName(day: DateStr, lang: Lang): string {
  return t(`month.${Number(day.slice(5, 7))}`, lang);
}

/**
 * The house in one line, in place of a spec sheet.
 *
 * What was here — "Sleeps 6 guests · Shortest stay 2 nights · Longest stay 21
 * nights · Open 1 May 2026 – 15 October 2026" — is metadata about a database
 * row, in the vocabulary of a rules engine, aimed at a stranger. Two of those
 * four facts are only ever relevant *while picking dates*, and the calendar
 * already refuses to let anyone break them.
 *
 * What is left is what a host would actually say at the door: how many of you
 * there is room for, and roughly when the place is open. Months, not dates:
 * nobody plans a summer around the 15th of October.
 */
function welcomeLine(rules: HouseRules, lang: Lang): string {
  const guests = rules.maxGuests;
  const { bookableFrom, bookableTo } = rules;

  if (bookableFrom && bookableTo) {
    return t("house.welcome.season", lang, {
      guests,
      from: monthName(bookableFrom, lang),
      to: monthName(bookableTo, lang),
    });
  }
  if (bookableFrom) {
    return t("house.welcome.season.from", lang, {
      guests,
      from: monthName(bookableFrom, lang),
    });
  }
  if (bookableTo) {
    return t("house.welcome.season.to", lang, {
      guests,
      to: monthName(bookableTo, lang),
    });
  }
  return t("house.welcome.season.any", lang, { guests });
}

/**
 * Who else is coming, as a sentence — or nothing at all.
 *
 * This replaces a table of "4 August 2026 – 10 August 2026 · Selin", which was
 * the coldest thing in a product about family: a list of ranges with a person's
 * name filed in the right-hand column. The dates are already on the calendar,
 * struck through, so the only information that list carried and the grid does
 * not is *who*. That is one sentence.
 *
 * `showGuestNames` is the owner's call, read as a column. Off, `named` is empty
 * and this returns `null` — no fallback row saying "Taken", because the grid
 * has said that already.
 */
function whoElseLine(
  house: House,
  busy: readonly BusyRange[],
  named: Map<string, string>,
  today: DateStr,
  lang: Lang,
): string | null {
  if (!house.showGuestNames) return null;

  const names: string[] = [];
  for (const range of busy) {
    if (compareDates(range.endDate, today) <= 0) continue;
    const who = named.get(`${range.startDate}|${range.endDate}`);
    // Someone with two weeks booked is still one person in this sentence.
    if (who && !names.includes(who)) names.push(who);
    if (names.length >= 6) break;
  }
  if (names.length === 0) return null;

  // "Selin, Mehmet and Ayşe" in English, "Selin, Mehmet ve Ayşe" in Turkish —
  // the platform knows where the comma and the conjunction go in each. `en-GB`
  // rather than `en`, which would resolve American and put a serial comma in
  // front of "and"; the rest of the product is British — `enGB` on the
  // calendar, "18 August 2026" on a written date — and one list should not be
  // the exception.
  const list = new Intl.ListFormat(lang === "en" ? "en-GB" : lang, {
    style: "long",
    type: "conjunction",
  }).format(names);

  return tn("house.taken.who", names.length, lang, { names: list });
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
   HERO
   ============================================================ */

/**
 * The front of the invitation card.
 *
 * Full-bleed, bottom-anchored, and the same block whether or not there is a
 * photograph in it — that is the point. The page used to begin with a bare
 * `<h1>` at 22px, which meant a house with no photos opened on a heading
 * against nothing. An empty state should get quieter, not disappear: with no
 * picture the block keeps its height and turns into paper one shade deeper than
 * the page, and the name does the work at forty points in the display face.
 *
 * `black/70` and `white` are the only colours in this file that are not tokens,
 * and they are on the scrim over a photograph, where the contrast has to hold
 * regardless of which way the theme goes.
 */
function Hero({
  house,
  lang,
  photo,
}: {
  house: House;
  lang: Lang;
  photo: { url: string; alt: string | null } | null;
}) {
  const town = t("house.town", lang, {
    town: house.town,
    country: house.country,
  });

  return (
    <header
      className={cn(
        "relative -mx-4 flex h-[52svh] max-h-[460px] min-h-[300px] flex-col justify-end overflow-hidden",
        photo ? null : "border-b border-border bg-secondary",
      )}
    >
      {photo ? (
        <>
          <Image
            src={photo.url}
            alt={photo.alt?.trim() || house.name}
            fill
            sizes="(max-width: 640px) 100vw, 560px"
            // The first thing on the page and the thing someone is waiting for.
            loading="eager"
            fetchPriority="high"
            className="object-cover"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-linear-to-t from-black/70 via-black/25 to-transparent"
          />
        </>
      ) : null}

      <div
        className={cn(
          "relative flex flex-col gap-1 px-4 pb-8",
          photo ? "text-white" : null,
        )}
      >
        {/* The first words. Not the town, not the rules — the invitation. */}
        <p
          className={cn(
            "text-sm",
            photo ? "text-white/75" : "text-muted-foreground",
          )}
        >
          {t("house.invite", lang)}
        </p>
        <h1 className="text-3xl text-balance">{house.name}</h1>
        <p
          className={cn(
            "text-sm",
            photo ? "text-white/85" : "text-muted-foreground",
          )}
        >
          {town}
        </p>
      </div>
    </header>
  );
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

  const blurb = house.blurb?.trim();
  const whoElse = whoElseLine(house, busy, named, today, lang);

  // The first photograph is the invitation itself; the rest are a strip further
  // down. Showing it twice would be the same picture twice.
  const [cover, ...rest] = photos;

  return (
    // The root layout is `lang="en"`; this subtree may not be. Saying so here is
    // what makes a screen reader pronounce a Turkish house in Turkish.
    <article
      lang={house.language}
      className={cn(
        // No top padding: the hero runs to the top of the glass, which is what
        // makes it read as the front of a card rather than a banner on a page.
        "flex flex-col gap-8 pb-10",
        // Clears the pinned bar in request-sheet.tsx. Keep the two in step: the
        // bar must never cover the last row of the calendar.
        open && "pb-[calc(7.5rem+env(safe-area-inset-bottom))]",
      )}
    >
      <Hero house={house} lang={lang} photo={cover ?? null} />

      {/* The host's voice ---------------------------------------------------- */}
      {/* "Five minutes from Ilıca beach, up the hill behind the bakery" is the
          best content in this product and it was 17px of body text. It is the
          sentence that makes someone want to come, so it gets the display face
          and the room. */}
      <section className="flex flex-col gap-4">
        {blurb ? (
          <p className="font-heading text-lg text-pretty whitespace-pre-line">
            {blurb}
          </p>
        ) : null}
        <p className="text-base text-muted-foreground">
          {welcomeLine(rules, lang)}
        </p>
      </section>

      {/* The rest of the photos ---------------------------------------------- */}
      {rest.length > 0 ? (
        // The negative margin cancels the layout's gutter so photos run to the
        // edge of the glass; the padding keeps the first one off it.
        <PhotoStrip
          photos={rest}
          houseName={house.name}
          language={house.language}
          className="-mx-4 px-4"
        />
      ) : null}

      {/* When you could come -------------------------------------------------- */}
      {/* No heading and no instructions. A month, a grid of numbers and one
          line in the calendar's own footer telling you where to start; the
          three separate explanations that used to sit on top of it said the
          same thing three times to somebody who had already worked it out. */}
      <section className="flex flex-col gap-4">
        {open ? (
          <RequestSheet
            slug={house.slug}
            houseName={house.name}
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
        ) : (
          <p className="text-base">{t("house.closed", lang)}</p>
        )}

        {whoElse ? <p className="text-sm">{whoElse}</p> : null}
      </section>
    </article>
  );
}
