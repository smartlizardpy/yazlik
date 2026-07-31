import type { Metadata } from "next";

import { requireHouse } from "@/lib/session";

import { encodeQr, qrPathData, qrViewBox } from "./qr";
import { CopyLink, FeedLink } from "./share-links";

export const metadata: Metadata = {
  title: "Share",
};

/**
 * `/app/share` — the two links, and the difference between them.
 *
 * The screen exists because that difference is not obvious and getting it wrong
 * is the one privacy mistake this product makes easy:
 *
 * - **The guest link** lets anyone holding it *ask*. Nothing more. A request
 *   lands on `/app` and waits; a forwarded link costs the owner a decline.
 * - **The calendar link** lets anyone holding it *see* — every confirmed stay,
 *   with names on it. It is the closer thing to a password of the two, and it
 *   is the one that looks harmless because it is "just a calendar".
 *
 * So each link says in one sentence what it lets a person do, and the calendar
 * one has a way to replace itself when it reaches somebody it should not have.
 *
 * ### Where the URLs come from
 *
 * `NEXT_PUBLIC_APP_URL`, not the request's `Host` header — the same constant
 * `lib/ics.ts` uses for the links it writes inside a calendar file. If the two
 * disagreed, an owner would copy one origin off this screen while their
 * calendar quietly pointed at another. One source, so they cannot drift.
 * Setting it is a deploy step; it is in `.env.local` for development.
 *
 * ### The QR code has no dependency behind it
 *
 * `./qr.ts` is the encoder, ~600 lines, verified matrix-for-matrix against a
 * reference implementation. It is here rather than in `package.json` because
 * every QR package on npm brings a canvas renderer or a React wrapper, and this
 * screen needs neither — it needs one `<path>`, server-rendered, no JavaScript
 * shipped to draw it.
 */

const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.BETTER_AUTH_URL ??
  "http://localhost:3100"
).replace(/\/+$/, "");

/** Rendered width of the QR block. Big enough for a second phone across a table. */
const QR_SIZE_CLASS = "w-52 max-w-full";

export default async function SharePage() {
  const house = await requireHouse();

  const guestUrl = `${APP_URL}/h/${house.slug}`;
  const qr = encodeQr(guestUrl);

  return (
    <section className="flex flex-1 flex-col gap-8 py-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Share</h1>
        <p className="text-sm text-muted-foreground">
          Two links, and they do different things. One lets people ask for dates.
          The other shows who is coming.
        </p>
      </header>

      {/* Guest link --------------------------------------------------------- */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Guest link</h2>
          <p className="text-sm text-muted-foreground">
            Send this to family and friends. They pick dates on their phone and
            the request lands on your screen.
          </p>
        </div>

        <CopyLink url={guestUrl} label="Copy guest link" primary />

        {/* The QR keeps its own black-on-white regardless of the page theme.
            A scanner expects dark modules on a light field, and a straight
            neutral inversion in dark mode hands it the negative of that —
            which many phones read anyway, and some simply do not. */}
        <figure className="flex flex-col items-center gap-2 pt-1">
          <svg
            viewBox={qrViewBox(qr)}
            className={`${QR_SIZE_CLASS} rounded-lg border border-border`}
            shapeRendering="crispEdges"
            role="img"
            aria-label="QR code for the guest link"
          >
            <rect width="100%" height="100%" fill="#ffffff" />
            <path d={qrPathData(qr)} fill="#0a0a0a" />
          </svg>
          <figcaption className="text-center text-xs text-muted-foreground">
            Point a camera at this to open the same page.
          </figcaption>
        </figure>

        <p className="text-sm text-muted-foreground">
          Anyone with this link can <strong className="font-medium text-foreground">ask</strong>.
          Only you confirm, so a link that gets forwarded costs you a request to
          decline and nothing else.
        </p>
      </section>

      {/* Calendar feed ------------------------------------------------------ */}
      <section className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-sm font-medium">Calendar link</h2>
          <p className="text-sm text-muted-foreground">
            Add this in Apple Calendar, Outlook, or Google Calendar and every
            confirmed stay shows up in the calendar you already use — your own
            blocked dates too. It updates on its own; nothing to install.
          </p>
        </div>

        <FeedLink baseUrl={APP_URL} feedToken={house.feedToken} />

        <p className="text-sm text-muted-foreground">
          Anyone with this link can{" "}
          <strong className="font-medium text-foreground">see who is staying</strong>{" "}
          and when. That is the difference: the guest link lets people ask, this
          one lets them look.
        </p>

        <p className="text-sm text-muted-foreground">
          Google refreshes calendars it does not own on its own schedule — hours,
          not minutes. A stay you approved a minute ago will not be there yet,
          and that is Google, not a broken link. Apple and Outlook check about
          once an hour.
        </p>
      </section>
    </section>
  );
}
