/**
 * `/b/[token]` — the one page a guest owns.
 *
 * They land here the second they ask, and they come back to it from the email.
 * It is **public**: there is no session in this file and there must never be
 * one. The token is the whole credential, which is why it is sixteen characters
 * of unguessable alphabet and why a wrong one gets `notFound()` with nothing in
 * the response to say whether it was close.
 *
 * ### What this page is
 *
 * Somebody has just been given a summer house for a week. That is the news, and
 * for a while this page buried it under a five-row table — Arrive / Leave /
 * Nights / Guests / Booked by — which is the layout of an order confirmation.
 * The table is gone. **The sentence is the page**: "The house is yours", at the
 * largest size in the display face, then the week said out loud, then the house,
 * then what you need to get in. Nothing else competes with it.
 *
 * "Booked by: Selin" was shown *to Selin*. Cut, along with the rest of the `dl`.
 *
 * ### The privacy split is enforced here
 *
 * The plan's promise is that a forwarded link leaks an ignorable request, never
 * a door code. That is kept by {@link arrivalPacket}, which runs **only** when
 * `status === 'confirmed'`. On a pending, declined or cancelled booking the
 * guests-only sections and their photos are not selected at all — not fetched
 * and hidden, not rendered behind a CSS class. There is no markup to reveal
 * because there is no data in the process.
 *
 * ### Four states, one page
 *
 * Each says what is true and what happens next; none of them apologise, and
 * none of them shout. The state is carried by the **headline and the date
 * block**, not by a chip: the block is a white card when the week is yours, a
 * dashed outline while it is a question, and flat grey once it is over — the
 * calendar's own vocabulary, at the size of the thing it describes. A 190px
 * status pill sitting next to the title, which is what used to say this, said it
 * in the voice of a ticketing system and out-shouted the title while it did.
 *
 * A decline is not a system rejection. It is someone you know saying not that
 * week, so if the owner wrote a reason it *is* the content of the page, in their
 * words, at the size of a sentence a person meant.
 */

import { cache } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRightIcon } from "lucide-react";
import { and, asc, eq, inArray } from "drizzle-orm";

import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { guideSections, images, type BookingStatus } from "@/db/schema";
import { bookingByToken } from "@/lib/bookings";
import { nightsBetween, toStr } from "@/lib/dates";
import {
  DEFAULT_LANG,
  humanRange,
  t,
  tn,
  toLang,
  type Lang,
} from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { CancelButton } from "./cancel-button";

/**
 * `generateMetadata` and the page both need the booking, and they run in the
 * same request. One query, not two.
 */
const loadBooking = cache(async (token: string) => bookingByToken(token));

/**
 * An owner blocking dates for themselves is a `kind: 'block'` row with a token
 * of its own — generated because the column is `NOT NULL UNIQUE`, never sent to
 * anybody. It has no guest, and its note ("Roof repair") is the owner talking
 * to themselves. So it is not a page; it is a 404.
 */
function guestBooking(found: Awaited<ReturnType<typeof bookingByToken>>) {
  return found && found.booking.kind === "guest" ? found : null;
}

/* ============================================================
   METADATA
   ============================================================ */

/**
 * **noindex**, and nothing in the description.
 *
 * This URL is a credential. A booking turning up in a search result is not a
 * bad ranking, it is a leak. The title carries the house name — the guest
 * already knows it — but the dates, the guest's name and the status stay off
 * the tab and out of any link preview a forwarded message might build.
 */
export async function generateMetadata(
  props: PageProps<"/b/[token]">,
): Promise<Metadata> {
  const { token } = await props.params;
  const found = guestBooking(await loadBooking(token));

  const robots = {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false },
  } as const;

  // Same title for a token that never existed and one that was deleted. There
  // is no house to ask for a language yet either, so English.
  if (!found) {
    return { title: t("house.notFound.title", DEFAULT_LANG), robots };
  }

  const lang = toLang(found.house.language);
  return { title: `${t("booking.title", lang)} — ${found.house.name}`, robots };
}

/* ============================================================
   THE ARRIVAL PACKET
   ============================================================ */

type PacketSection = {
  id: string;
  title: string;
  body: string;
  photos: { id: string; url: string; alt: string | null }[];
};

/**
 * The guests-only half of the guide, with its photos.
 *
 * **Only ever called on a confirmed booking.** The `visibility` filter is the
 * privacy split and the caller's status check is the lock on it; neither is
 * optional. Photos come from a second query keyed on the section ids, so a
 * photo can only be selected if its section already was — the image rows never
 * get a chance to disagree with the sections about what a guest may see.
 *
 * Phase 7 builds the editor that writes these. Until then this returns an empty
 * array on every house, and the page renders no heading rather than an empty
 * shell promising details that do not exist.
 */
async function arrivalPacket(houseId: string): Promise<PacketSection[]> {
  const sections = await db
    .select({
      id: guideSections.id,
      title: guideSections.title,
      body: guideSections.body,
    })
    .from(guideSections)
    .where(
      and(
        eq(guideSections.houseId, houseId),
        eq(guideSections.visibility, "guests"),
      ),
    )
    .orderBy(asc(guideSections.position), asc(guideSections.title));

  if (sections.length === 0) return [];

  const photos = await db
    .select({
      id: images.id,
      url: images.url,
      alt: images.alt,
      sectionId: images.sectionId,
    })
    .from(images)
    .where(
      and(
        eq(images.houseId, houseId),
        inArray(
          images.sectionId,
          sections.map((section) => section.id),
        ),
      ),
    )
    .orderBy(asc(images.position), asc(images.createdAt));

  return sections.map((section) => ({
    ...section,
    photos: photos
      .filter((photo) => photo.sectionId === section.id)
      .map(({ id, url, alt }) => ({ id, url, alt })),
  }));
}

/* ============================================================
   COPY
   ============================================================ */

/**
 * The headline, which is the whole page.
 *
 * One sentence per state, and it is the thing the reader came for: whether the
 * week is theirs. "Your stay" — the old title — is a filing label, true of all
 * four states and news in none of them.
 */
const TITLE_KEY: Record<BookingStatus, string> = {
  pending: "booking.pending.title",
  confirmed: "booking.yours",
  declined: "booking.declined.title",
  cancelled: "booking.cancelled.title",
};

/**
 * The state, in the calendar's language rather than in colour.
 *
 * A white card for a week that is yours, a dashed outline while it is still a
 * question, a flat grey fill once it is over — the same three treatments the
 * grid on `/h/[slug]` and the summer strip on `/app` use for the same three
 * things. Nothing here is red or green, so the page reads in greyscale and
 * survives a colourblind eye without a legend.
 */
const DATE_BLOCK: Record<BookingStatus, string> = {
  pending: "border border-dashed border-foreground/40",
  confirmed: "bg-card ring-1 ring-foreground/10",
  declined: "bg-secondary",
  cancelled: "bg-secondary",
};

/**
 * How long they have been waiting, said the way a person would.
 *
 * Waiting with no sense of time is the worst part of a pending request: the
 * page said the owner would answer "soon" and gave the reader no way to judge
 * whether soon had already been and gone. Two days is patience; six days is a
 * nudge, and the guest is the one who gets to decide which.
 */
function waitingLine(createdAt: Date, lang: Lang): string {
  const days = nightsBetween(toStr(createdAt), toStr(new Date()));
  if (days <= 0) return t("booking.waiting.today", lang);
  if (days === 1) return t("booking.waiting.yesterday", lang);
  return t("booking.waiting.days", lang, {
    days: tn("count.days", days, lang),
  });
}

/* ============================================================
   PAGE
   ============================================================ */

export default async function BookingPage(props: PageProps<"/b/[token]">) {
  const { token } = await props.params;
  const found = guestBooking(await loadBooking(token));

  // Nothing about the response distinguishes a typo from a real token that has
  // since been deleted. That is what stops the URL being guessable by probing.
  if (!found) notFound();

  const { booking, house } = found;
  const lang: Lang = toLang(house.language);
  const status = booking.status;

  // THE PRIVACY SPLIT. Any status other than confirmed and the guides-only
  // sections are never selected — see arrivalPacket above.
  const packet = status === "confirmed" ? await arrivalPacket(house.id) : [];

  const nights = nightsBetween(booking.startDate, booking.endDate);
  const reason = status === "declined" ? booking.declineReason?.trim() : null;
  const note = booking.note?.trim();

  // Over, one way or the other. The week is not coming back on this page, so
  // the dates go quiet and the house stops being a place you are going and
  // becomes one you could ask about again.
  const over = status === "declined" || status === "cancelled";

  // A guest may cancel while there is something to cancel. Declined and
  // cancelled are already over, and a button that only ever explains why it
  // cannot work is worse than no button.
  const cancellable = status === "pending" || status === "confirmed";

  return (
    // The root layout is `lang="en"`; this subtree may not be. Saying so here is
    // what makes a screen reader pronounce a Turkish house in Turkish.
    <article lang={house.language} className="flex flex-col gap-6 pt-10 pb-12">
      {/* The news ----------------------------------------------------------- */}
      {/* Forty points, display face, and the only thing above the fold that is
          not a date. Somebody has been given a house for a week; the page has
          one job and this is it. */}
      <h1 className="text-3xl text-balance">{t(TITLE_KEY[status], lang)}</h1>

      {/* The owner's own words, on a decline, before anything else. Not quoted
          in a grey box at 13px like an error detail — this is a person who
          knows the reader saying no, and it is the content of the page. */}
      {status === "declined" ? (
        reason ? (
          <section aria-labelledby="reason-heading" className="flex flex-col gap-2">
            <h2
              id="reason-heading"
              className="font-sans text-xs font-medium text-muted-foreground"
            >
              {t("booking.declineReason", lang)}
            </h2>
            <p className="font-heading text-lg text-pretty whitespace-pre-line">
              {reason}
            </p>
          </section>
        ) : (
          <p className="text-base">{t("booking.declined.body", lang)}</p>
        )
      ) : null}

      {/* The week ------------------------------------------------------------ */}
      {/* Said, not filed: "Tue 4 – Mon 10 Aug", the way it would be said out
          loud in the group chat. `rangeLabel` — "4 August 2026 – 10 August
          2026" — belongs in the .ics and the emails, where a date has to
          survive being read out of context six months later. */}
      <div className={cn("rounded-xl px-4 py-5", DATE_BLOCK[status])}>
        <p
          className={cn(
            "num font-heading text-2xl text-balance",
            over && "text-muted-foreground",
          )}
        >
          {humanRange(booking.startDate, booking.endDate, lang)}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {tn("count.nights", nights, lang)},{" "}
          {tn("count.people", booking.guests, lang)}
        </p>
      </div>

      {/* Still a question ---------------------------------------------------- */}
      {status === "pending" ? (
        <div className="flex flex-col gap-1">
          {/* The one thing a waiting guest actually wants to know: it arrived,
              and they will not have to keep checking. */}
          <p className="text-base">{t("status.pending.body", lang)}</p>
          <p className="text-sm text-muted-foreground">
            {waitingLine(booking.createdAt, lang)}
          </p>
        </div>
      ) : null}

      {status === "cancelled" ? (
        <p className="text-base">{t("booking.cancelled.body", lang)}</p>
      ) : null}

      {/* Onwards ------------------------------------------------------------- */}
      {/* The week is yours, so the useful thing is to put it where the rest of
          your life is. Ink, full width, and the only primary action on the
          page — `/api/ics/[token]` serves the file and 404s on anything that is
          not a confirmed guest stay, so this button cannot exist without one. */}
      {status === "confirmed" ? (
        <Button asChild className="h-12 w-full text-base">
          <a href={`/api/ics/${booking.token}`}>{t("booking.calendar", lang)}</a>
        </Button>
      ) : null}

      {/* The house ----------------------------------------------------------- */}
      {/* Its name in the display face, because the name is the point — this is
          somewhere, not a listing. Once the week is over the second line stops
          being an address and becomes the way back in. */}
      <Link
        href={`/h/${house.slug}`}
        className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-foreground/25 px-4 py-3"
      >
        <span className="min-w-0">
          <span className="font-heading block text-lg break-words">
            {house.name}
          </span>
          <span className="block text-sm text-muted-foreground">
            {over
              ? t("booking.askAgain", lang)
              : t("house.town", lang, {
                  town: house.town,
                  country: house.country,
                })}
          </span>
        </span>
        <ArrowRightIcon className="size-5 shrink-0" aria-hidden="true" />
      </Link>

      {/* Getting in ---------------------------------------------------------- */}
      {/* Confirmed only, and only when the owner has actually written some. An
          empty "Before you arrive" heading promises a door code that is not
          there. */}
      {packet.length > 0 ? (
        <section aria-labelledby="packet-heading" className="flex flex-col gap-5">
          <h2 id="packet-heading" className="text-lg">
            {t("booking.packet", lang)}
          </h2>
          {packet.map((section) => (
            <div key={section.id} className="flex flex-col gap-2">
              <h3 className="text-base font-medium">{section.title}</h3>
              {section.body.trim() ? (
                <p className="text-base whitespace-pre-line">
                  {section.body.trim()}
                </p>
              ) : null}
              {/* Stacked full width, not a scroll strip: "the gate looks like
                  this" is read in sequence with the sentence above it, and
                  there is at most one or two per section. */}
              {section.photos.map((photo) => (
                <div
                  key={photo.id}
                  className="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted"
                >
                  <Image
                    src={photo.url}
                    alt={photo.alt?.trim() || section.title}
                    fill
                    // The column is 560px wide at most, less the 16px gutters.
                    sizes="(max-width: 592px) 100vw, 528px"
                    className="object-cover"
                  />
                </div>
              ))}
            </div>
          ))}
        </section>
      ) : status === "pending" ? (
        // Answers the question a waiting guest actually has — where the address
        // and the key will turn up — without fetching a single guests-only row.
        <p className="text-sm text-muted-foreground">
          {t("booking.packet.locked", lang)}
        </p>
      ) : null}

      {/* What they wrote when they asked. Theirs, so they get to see it — and
          on a decline or a cancellation it is a sentence about a week that is
          not happening, which is not worth re-reading. */}
      {note && cancellable ? (
        <section aria-labelledby="note-heading" className="flex flex-col gap-1">
          <h2
            id="note-heading"
            className="font-sans text-xs font-medium text-muted-foreground"
          >
            {t("booking.note", lang)}
          </h2>
          <p className="border-l border-border pl-3 text-base whitespace-pre-line">
            {note}
          </p>
        </section>
      ) : null}

      {/* Last of all --------------------------------------------------------- */}
      {/* Cancelling used to sit directly under "See the house", which made the
          most visually available thing to do on a holiday confirmation cancel
          it. It is a real door and it stays unlocked, but it is at the bottom,
          below a rule, at the size of a footnote. */}
      {cancellable ? (
        <div className="mt-2 border-t border-border pt-4">
          <CancelButton token={booking.token} language={lang} />
        </div>
      ) : null}
    </article>
  );
}
