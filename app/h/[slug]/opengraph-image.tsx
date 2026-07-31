/**
 * The card WhatsApp draws when the link lands in the family group.
 *
 * For most people this **is** the landing page. They will see it before they
 * see anything I built next door, and until now it was a bare grey rectangle
 * with a slug in it — which is exactly what a phishing link looks like, and
 * the opposite of an invitation.
 *
 * So: the house's own first photograph, full-bleed, with its name over an ink
 * scrim — the same picture the page opens on, so tapping the card feels like
 * walking through it rather than arriving somewhere else. No photograph yet
 * gets the same card in warm paper. The page's hero degrades exactly this way,
 * on purpose.
 *
 * ### Three things that are allowed to fail, and none of them may take the card down
 *
 * A social scraper gets one shot and does not retry. So the font, the photo and
 * the database are each wrapped: a font that will not download falls back to the
 * bundled sans, a photo that will not fetch falls back to paper, and a slug that
 * matches nothing still renders something honest. The only unrecoverable case
 * is a house that does not exist, which gets a 404 — that is not a failure, it
 * is the right answer.
 *
 * ### Colours are literal here, and only here
 *
 * `next/og` renders through satori, which has no stylesheet, no Tailwind and no
 * CSS variables to read. Every value below is inlined at 1200×630 and cannot
 * reach the theme tokens. They are the same hexes `globals.css` defines and
 * they have to be kept in step by hand — there is no third option.
 */

import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { images } from "@/db/schema";
import { houseBySlug } from "@/lib/bookings";
import { t, toLang } from "@/lib/i18n";

/** Generic on purpose: `alt` is a module constant and cannot know the house. */
export const alt = "The house you have been invited to";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/* ============================================================
   PALETTE — mirrors :root in app/globals.css
   ============================================================ */

// The no-photo card is `SUBTLE` rather than the page's `PAPER`, so that it is
// pixel-for-pixel the block the page's own hero draws: tapping the card in the
// group chat lands on the same shade it just showed.
const SUBTLE = "#F0EDE6";
const INK = "#141210";
const MUTED_INK = "#6E6862";
const BORDER = "#E4DFD5";

/* ============================================================
   THE DISPLAY FACE
   ============================================================ */

/**
 * Fraunces, fetched once per server process, or nothing.
 *
 * satori reads TTF, OTF and WOFF but **not** WOFF2, and WOFF2 is all Google
 * serves a modern browser — hence the ancient user agent, which is the
 * documented way to be handed the old formats instead. `next/font` cannot help:
 * what it downloads at build time is WOFF2 under a hashed filename.
 *
 * Only a success is remembered. Caching a failure would mean one bad minute on
 * a cold boot costs the serif for the lifetime of the process, and this is the
 * one thing on the card carrying any personality at all.
 */
const FRAUNCES_CSS =
  "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500&display=swap";

// Chrome 29, which is old enough that Google Fonts stops offering WOFF2.
const OLD_BROWSER =
  "Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/29.0.1547.62 Safari/537.36";

let displayFace: ArrayBuffer | null = null;

async function loadDisplayFace(): Promise<ArrayBuffer | null> {
  if (displayFace) return displayFace;
  try {
    const response = await fetch(FRAUNCES_CSS, {
      headers: { "User-Agent": OLD_BROWSER },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return null;

    const css = await response.text();
    const url = css.match(
      /src:\s*url\((https:[^)]+)\)\s*format\('(?:truetype|opentype|woff)'\)/,
    )?.[1];
    if (!url) return null;

    const font = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!font.ok) return null;

    displayFace = await font.arrayBuffer();
    return displayFace;
  } catch {
    // Offline, blocked, slow, or Google changed the shape of its CSS. The card
    // is still a card.
    return null;
  }
}

/* ============================================================
   THE PHOTOGRAPH
   ============================================================ */

/**
 * Where the app lives, for turning a local upload path into something a
 * fetcher can reach. Same order of preference as `lib/emails.ts` and
 * `lib/ics.ts`; the blob driver returns absolute URLs and never gets here.
 */
function appUrl(): string {
  return (
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.BETTER_AUTH_URL ??
    "http://localhost:3100"
  ).replace(/\/+$/, "");
}

/** Eight megabytes is the upload ceiling; six is where a card stops being one. */
const PHOTO_LIMIT = 6_000_000;

/**
 * The first gallery photo as a data URI, or `null`.
 *
 * Fetched here rather than handed to satori as a URL so that a slow or missing
 * image degrades into the paper card instead of throwing the whole response
 * away. Both foreign keys null means the photo hangs on the house itself, which
 * is the same filter the page uses.
 */
async function coverPhoto(houseId: string): Promise<string | null> {
  const [photo] = await db
    .select({ url: images.url })
    .from(images)
    .where(
      and(
        eq(images.houseId, houseId),
        isNull(images.placeId),
        isNull(images.sectionId),
      ),
    )
    .orderBy(asc(images.position), asc(images.createdAt))
    .limit(1);

  if (!photo) return null;

  const url = /^https?:\/\//.test(photo.url)
    ? photo.url
    : `${appUrl()}${photo.url}`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;

    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > PHOTO_LIMIT) return null;

    const type = response.headers.get("content-type") ?? "image/jpeg";
    return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

/* ============================================================
   THE CARD
   ============================================================ */

export default async function Image({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const house = await houseBySlug(slug);
  if (!house) notFound();

  const lang = toLang(house.language);
  const invite = t("house.invite", lang);
  const town = t("house.town", lang, {
    town: house.town,
    country: house.country,
  });

  const [photo, face] = await Promise.all([
    coverPhoto(house.id),
    loadDisplayFace(),
  ]);

  const onPhoto = photo !== null;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "flex-end",
          width: "100%",
          height: "100%",
          position: "relative",
          // Straight on the container. An absolutely-positioned `inset: 0`
          // child with nothing in it collapses under satori — it sizes by
          // content, not by the box model a browser would use — so the paper
          // card silently rendered the wrong shade until this moved up here.
          backgroundColor: onPhoto ? INK : SUBTLE,
          borderBottom: onPhoto ? undefined : `12px solid ${BORDER}`,
        }}
      >
        {onPhoto ? (
          <>
            <img
              src={photo}
              alt=""
              width={size.width}
              height={size.height}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: "100%",
                objectFit: "cover",
              }}
            />
            {/* The scrim, without which the name is unreadable over a bright
                sky — verified against a real photograph, not assumed.
                `inset: 0` is not enough: satori sizes by content, so an empty
                box pinned to all four sides collapses to nothing and the
                gradient silently does not exist. Explicit width and height. */}
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                display: "flex",
                width: "100%",
                height: "100%",
                backgroundImage:
                  "linear-gradient(to top, rgba(20,18,16,0.86) 0%, rgba(20,18,16,0.38) 46%, rgba(20,18,16,0) 76%)",
              }}
            />
          </>
        ) : null}

        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            padding: "0 72px 68px",
          }}
        >
          <div
            style={{
              fontSize: 34,
              lineHeight: 1.2,
              color: onPhoto ? "rgba(255,255,255,0.78)" : MUTED_INK,
            }}
          >
            {invite}
          </div>
          <div
            style={{
              fontFamily: face ? "Fraunces" : undefined,
              fontSize: 92,
              lineHeight: 1.08,
              letterSpacing: "-0.02em",
              paddingTop: 10,
              paddingBottom: 12,
              color: onPhoto ? "#FFFFFF" : INK,
            }}
          >
            {house.name}
          </div>
          <div
            style={{
              fontSize: 34,
              lineHeight: 1.2,
              color: onPhoto ? "rgba(255,255,255,0.88)" : MUTED_INK,
            }}
          >
            {town}
          </div>
        </div>
      </div>
    ),
    {
      ...size,
      fonts: face
        ? [{ name: "Fraunces", data: face, style: "normal", weight: 500 }]
        : undefined,
    },
  );
}
