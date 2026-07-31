import type { Metadata } from "next";
import Image from "next/image";
import { ChevronRightIcon } from "lucide-react";
import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { images } from "@/db/schema";
import { t, toLang } from "@/lib/i18n";
import { requireHouse } from "@/lib/session";
import { cn } from "@/lib/utils";

import { encodeQr, qrPathData, qrViewBox } from "./qr";
import { FeedLink, ShareLink } from "./share-links";

export const metadata: Metadata = {
  title: "Share",
};

/**
 * `/app/share` — handing out the link, and showing what handing it out looks
 * like from the other end.
 *
 * The screen has a single job: get a link into a family group chat. So the
 * phone's own share sheet is the first thing on it and everything else is
 * arranged behind that.
 *
 * ### The promise is the heading
 *
 * The page used to open with "Share the house" — the words the owner had just
 * tapped in the menu, set at 34px, telling them where they already knew they
 * were. Underneath it, in 17px body text, sat the only sentence on the screen
 * worth reading: *anyone with it can ask, only you say yes*. That is the whole
 * privacy model of this product in seven words, and it was the same size as a
 * caption.
 *
 * They have swapped places. The heading is now the statement, the way
 * `/app/settings` opens on "How the house reads" rather than "Settings". A
 * screen names itself by saying something true, not by repeating the nav.
 *
 * ### What lands in the chat, shown rather than described
 *
 * The owner is about to paste something into a group of people they are
 * related to, and until now they could not see it. Two things travel with the
 * link and neither was on screen: the sentence `ShareLink` hands to the share
 * sheet, and the card WhatsApp unfurls from the URL.
 *
 * Both are here now, under the button, in the shape a chat draws them — card
 * on top, message underneath — from the same photograph, name and town that
 * `/h/[slug]/opengraph-image.tsx` renders at 1200×630. It is a picture of
 * somewhere else, so it sits inside a card of its own rather than speaking in
 * the page's voice, and it is the only colour on the screen. A house with no
 * photograph gets the paper version of the card, because that is what the
 * scraper will make of it too.
 *
 * ### Two links, and the difference between them
 *
 * - **The house link** lets anyone holding it *ask*. Nothing more. A request
 *   lands on `/app` and waits; a forwarded link costs the owner one "not that
 *   week".
 * - **The calendar link** lets anyone holding it *see* — every confirmed stay,
 *   with names on it. It is the closer thing to a password of the two, and it
 *   is the one that looks harmless because it is "just a calendar".
 *
 * That used to be three paragraphs of 15px grey prose explaining itself. It is
 * now one sentence each, because the distinction is a fact, not a lecture, and
 * a wall of caveats is how a person learns to skip the words on a screen.
 *
 * ### One of them is the screen; the other is plumbing
 *
 * They were laid out as two matching sections — button, URL, sentence, twice —
 * with a heading between them, which said they were worth the same. They are
 * not. The house link is the reason this page exists, so it gets the top of the
 * page and the only ink on it. The calendar feed is a thing an owner sets up
 * once and never opens again, so it is one closed row at the bottom, next to
 * the QR code, in a pair of ruled rows that read as a drawer rather than a
 * section.
 *
 * That pair used to be pushed apart: the QR code sat under the link and the
 * calendar row carried `mt-auto` inside a `flex-1` column, which on a desktop
 * window parked it neatly at the foot of the page and on a 390×844 phone left
 * seven hundred pixels of blank paper in the middle of the screen. Nothing here
 * needs to touch the bottom of the viewport, so nothing does: the column stacks
 * from the top and ends where the content ends.
 *
 * The sentence about what the feed gives away sits directly on top of "Replace
 * this link" for the same reason a fire alarm hangs next to the extinguisher.
 *
 * ### Where the URLs come from
 *
 * `NEXT_PUBLIC_APP_URL`, not the request's `Host` header — the same constant
 * `lib/ics.ts` uses for the links it writes inside a calendar file. If the two
 * disagreed, an owner would copy one origin off this screen while their
 * calendar quietly pointed at another. One source, so they cannot drift.
 * Setting it is a deploy step; it is in `.env.local` for development.
 *
 * ### The QR code is a third-priority feature and sits in a third slot
 *
 * It used to be a 208px black square above the fold, ahead of the buttons. It
 * is genuinely useful — a phone across a table, a fridge door — and almost
 * never the thing you came here for, so it lives inside a `<details>`. Native
 * disclosure, no state, no JavaScript shipped to open it.
 *
 * The encoder behind it (`./qr.ts`, ~600 lines, verified matrix-for-matrix
 * against a reference implementation) is here rather than in `package.json`
 * because every QR package on npm brings a canvas renderer or a React wrapper,
 * and this screen needs neither — it needs one `<path>`.
 */

const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.BETTER_AUTH_URL ??
  "http://localhost:3100"
).replace(/\/+$/, "");

/**
 * What lands in the chat next to the link.
 *
 * The most-read sentence in the whole product, and the invitation itself, so it
 * says come and stay rather than describing a booking system. Declared once:
 * the share sheet is handed it and the owner is shown it, and those must be the
 * same words.
 */
const INVITE_MESSAGE = "Come and stay — pick the week you want and I will say yes.";

export default async function SharePage() {
  const house = await requireHouse();

  const guestUrl = `${APP_URL}/h/${house.slug}`;
  const qr = encodeQr(guestUrl);

  // The house's language, not the owner's screen: the card is drawn for the
  // people receiving it.
  const lang = toLang(house.language);
  const town = t("house.town", lang, {
    town: house.town,
    country: house.country,
  });

  // The same photograph the Open Graph card uses — first gallery picture, both
  // foreign keys null. One row, because the preview is one picture.
  const [photo] = await db
    .select({ url: images.url, alt: images.alt })
    .from(images)
    .where(
      and(
        eq(images.houseId, house.id),
        isNull(images.placeId),
        isNull(images.sectionId),
      ),
    )
    .orderBy(asc(images.position), asc(images.createdAt))
    .limit(1);

  return (
    <div className="flex flex-col pt-8 pb-6">
      <h1 className="text-2xl text-balance">
        Anyone with it can ask. Only you say yes.
      </h1>

      {/* The house link ----------------------------------------------------- */}
      <div className="mt-7">
        <ShareLink
          url={guestUrl}
          title={house.name}
          message={INVITE_MESSAGE}
          sendLabel="Send the link"
          copyLabel="Copy the link"
          primary
        />
      </div>

      {/* What arrives at the other end -------------------------------------- */}
      <section className="mt-8 flex flex-col gap-2.5">
        <h2 className="font-sans text-sm font-normal text-muted-foreground">
          What lands in the chat
        </h2>

        <figure className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3">
          {/* The unfurled card, at a twentieth of the size. Same composition as
              opengraph-image.tsx: invitation, name, town, over the photograph
              on a scrim — or on paper when there is no photograph, which is the
              fallback that file draws too. */}
          <div className="relative flex aspect-[1200/630] flex-col justify-end overflow-hidden rounded-lg bg-secondary">
            {photo ? (
              <>
                <Image
                  src={photo.url}
                  alt={photo.alt?.trim() || house.name}
                  fill
                  // The figure is the column less its own padding: 334px on a
                  // 390px phone, ~500 where the column stops growing.
                  sizes="(max-width: 640px) 92vw, 520px"
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
                "relative flex flex-col gap-0.5 px-3 pb-3",
                photo && "text-white",
              )}
            >
              <p
                className={cn(
                  "text-xs",
                  photo ? "text-white/75" : "text-muted-foreground",
                )}
              >
                {t("house.invite", lang)}
              </p>
              <p className="font-heading text-lg leading-none text-balance">
                {house.name}
              </p>
              <p
                className={cn(
                  "text-xs",
                  photo ? "text-white/85" : "text-muted-foreground",
                )}
              >
                {town}
              </p>
            </div>
          </div>

          {/* The words that travel with it. In the display face because it is a
              sentence somebody says out loud, not a caption about a feature.

              `select-all` because the share sheet is the only thing that
              carries these words automatically: on a laptop the button copies
              the URL alone, and one click on this sentence is the difference
              between "here is a link" and an invitation. */}
          <figcaption className="px-1 pb-1 font-heading text-base text-pretty select-all">
            {INVITE_MESSAGE}
          </figcaption>
        </figure>
      </section>

      {/* The drawer --------------------------------------------------------- */}
      {/* Two rows, ruled, closed. Neither is why anyone opened this screen, and
          until one is opened neither costs a single line of reading. */}
      <section className="mt-9 flex flex-col divide-y divide-border border-y border-border">
        <details className="group py-1">
          <summary className="flex min-h-11 list-none items-center gap-1.5 text-base [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              className="size-4 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            QR code
          </summary>
          {/* Black on white whatever the page theme is. A scanner expects dark
              modules on a light field, and a straight neutral inversion in dark
              mode hands it the negative of that — which many phones read
              anyway, and some simply do not. */}
          <svg
            viewBox={qrViewBox(qr)}
            className="mt-2 mb-2 w-52 max-w-full rounded-lg border border-border"
            shapeRendering="crispEdges"
            role="img"
            aria-label="QR code for the house link"
          >
            <rect width="100%" height="100%" fill="#ffffff" />
            <path d={qrPathData(qr)} fill="#0a0a0a" />
          </svg>
        </details>

        <details className="group py-1">
          <summary className="flex min-h-11 list-none items-center gap-1.5 text-base [&::-webkit-details-marker]:hidden">
            <ChevronRightIcon
              className="size-4 transition-transform group-open:rotate-90"
              aria-hidden="true"
            />
            Your calendar
          </summary>

          <div className="pt-2 pb-2">
            <FeedLink
              baseUrl={APP_URL}
              feedToken={house.feedToken}
              houseName={house.name}
            >
              <div className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground text-pretty">
                  Calendars refresh on their own schedule. A stay you said yes
                  to a minute ago can take a few hours to appear.
                </p>
                {/* The consequence, in the voice this product uses for things
                    that are true rather than things you operate — and sitting
                    directly on top of the way to undo it. */}
                <p className="font-heading text-base text-pretty">
                  Whoever has this link sees every stay — who is coming, and
                  which nights.
                </p>
              </div>
            </FeedLink>
          </div>
        </details>
      </section>
    </div>
  );
}
