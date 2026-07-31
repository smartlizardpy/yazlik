/**
 * `/b/[token]` — the one page a guest owns.
 *
 * They land here the second they send a request, and they come back to it from
 * the email. It is **public**: there is no session in this file and there must
 * never be one. The token is the whole credential, which is why it is sixteen
 * characters of unguessable alphabet and why a wrong one gets `notFound()` with
 * nothing in the response to say whether it was close.
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
 * Pending, confirmed, declined, cancelled. Each says what is true and what
 * happens next; none of them apologise, and none of them shout. The status
 * chip borrows the calendar's language rather than colour — a dashed outline is
 * "waiting", a solid black fill is "yours", a flat neutral fill is "over" —
 * so the page reads the same in greyscale.
 *
 * The `.ics` download and every email belong to Phase 5 and are deliberately
 * absent.
 */

import { cache } from "react";
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray } from "drizzle-orm";

import { Button } from "@/components/ui/button";
import { db } from "@/db";
import { guideSections, images, type BookingStatus } from "@/db/schema";
import { bookingByToken } from "@/lib/bookings";
import { nightsBetween, toStr } from "@/lib/dates";
import { DEFAULT_LANG, dayLabel, t, tn, toLang, type Lang } from "@/lib/i18n";

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
   PRESENTATION
   ============================================================ */

/**
 * The status, in the calendar's vocabulary rather than in colour.
 *
 * Waiting is a dashed outline, yours is a solid black fill, over is a flat
 * neutral — exactly what the same four states look like on `/h/[slug]`. Nothing
 * here is red or green, so the page survives colourblindness and a greyscale
 * screenshot without a legend.
 */
const STATUS_CHIP: Record<BookingStatus, string> = {
  pending:
    "border border-dashed border-muted-foreground/70 text-muted-foreground",
  confirmed: "bg-foreground text-background",
  declined: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

/** One row of the stay: label on the left, value on the right, rule underneath. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-border py-2 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="num text-sm">{value}</dd>
    </div>
  );
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
  const name = booking.guestName?.trim();

  // A guest may cancel while there is something to cancel. Declined and
  // cancelled are already over, and a button that only ever explains why it
  // cannot work is worse than no button.
  const cancellable = status === "pending" || status === "confirmed";

  return (
    // The root layout is `lang="en"`; this subtree may not be. Saying so here is
    // what makes a screen reader pronounce a Turkish house in Turkish.
    <article lang={house.language} className="flex flex-col gap-6 py-6">
      {/* Status ------------------------------------------------------------- */}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-xl font-semibold tracking-tight">
            {t("booking.title", lang)}
          </h1>
          <span
            className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${STATUS_CHIP[status]}`}
          >
            {t(`status.${status}`, lang)}
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          {house.name} · {t("house.town", lang, {
            town: house.town,
            country: house.country,
          })}
        </p>
      </header>

      <p className="text-base">{t(`status.${status}.body`, lang)}</p>

      {/* The owner's own words, quoted and not softened. Only ever written on a
          decline, so this block cannot appear anywhere it would read oddly. */}
      {reason ? (
        <section
          aria-labelledby="reason-heading"
          className="flex flex-col gap-1 border-l-2 border-border pl-3"
        >
          <h2
            id="reason-heading"
            className="text-xs font-medium text-muted-foreground"
          >
            {t("booking.declineReason", lang)}
          </h2>
          <p className="text-base whitespace-pre-line">{reason}</p>
        </section>
      ) : null}

      {/* The stay ----------------------------------------------------------- */}
      <section aria-labelledby="dates-heading" className="flex flex-col gap-2">
        <h2 id="dates-heading" className="text-sm font-medium">
          {t("booking.dates", lang)}
        </h2>
        <dl className="flex flex-col">
          <Row
            label={t("booking.arrive", lang)}
            value={dayLabel(booking.startDate, lang)}
          />
          <Row
            label={t("booking.leave", lang)}
            value={dayLabel(booking.endDate, lang)}
          />
          <Row
            label={t("booking.nights", lang)}
            value={tn("count.nights", nights, lang)}
          />
          <Row
            label={t("booking.guests", lang)}
            value={tn("count.guests", booking.guests, lang)}
          />
          {name ? <Row label={t("booking.name", lang)} value={name} /> : null}
        </dl>
      </section>

      {/* What they wrote when they asked. Theirs, so they get to see it. */}
      {note ? (
        <section aria-labelledby="note-heading" className="flex flex-col gap-1">
          <h2
            id="note-heading"
            className="text-xs font-medium text-muted-foreground"
          >
            {t("booking.note", lang)}
          </h2>
          <p className="text-base whitespace-pre-line">{note}</p>
        </section>
      ) : null}

      {/* Arrival packet ------------------------------------------------------ */}
      {/* Confirmed only, and only when the owner has actually written some. An
          empty "Before you arrive" heading promises a door code that is not
          there. */}
      {packet.length > 0 ? (
        <section aria-labelledby="packet-heading" className="flex flex-col gap-4">
          <h2 id="packet-heading" className="text-sm font-medium">
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

      {/* Onwards ------------------------------------------------------------- */}
      <div className="flex flex-col gap-3">
        <Button asChild variant="outline" className="h-11 w-full text-base">
          <Link href={`/h/${house.slug}`}>{t("booking.house.link", lang)}</Link>
        </Button>

        {cancellable ? (
          <CancelButton token={booking.token} language={lang} />
        ) : null}
      </div>

      <p className="num text-xs text-muted-foreground">
        {t("booking.requested", lang, {
          date: dayLabel(toStr(booking.createdAt), lang),
        })}
      </p>
    </article>
  );
}
