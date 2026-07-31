import type { Metadata } from "next";
import { ChevronRightIcon } from "lucide-react";

import { requireHouse } from "@/lib/session";

import { encodeQr, qrPathData, qrViewBox } from "./qr";
import { FeedLink, ShareLink } from "./share-links";

export const metadata: Metadata = {
  title: "Share",
};

/**
 * `/app/share` — handing out the link, and the one thing worth knowing about
 * the other one.
 *
 * The screen has a single job: get a link into a family group chat. So the
 * phone's own share sheet is the first thing on it and everything else is
 * arranged behind that.
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
 * ### Where the URLs come from
 *
 * `NEXT_PUBLIC_APP_URL`, not the request's `Host` header — the same constant
 * `lib/ics.ts` uses for the links it writes inside a calendar file. If the two
 * disagreed, an owner would copy one origin off this screen while their
 * calendar quietly pointed at another. One source, so they cannot drift.
 * Setting it is a deploy step; it is in `.env.local` for development.
 *
 * ### The QR code is a third-priority feature and now sits in a third slot
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

export default async function SharePage() {
  const house = await requireHouse();

  const guestUrl = `${APP_URL}/h/${house.slug}`;
  const qr = encodeQr(guestUrl);

  return (
    <div className="flex flex-1 flex-col gap-10 pt-5 pb-4">
      <h1 className="text-2xl text-balance">Share the house</h1>

      {/* The house link ----------------------------------------------------- */}
      <section className="flex flex-col gap-4">
        <ShareLink
          url={guestUrl}
          title={house.name}
          // What lands in the chat. This is the most-read sentence in the whole
          // product and it is the invitation itself, so it says come and stay
          // rather than describing a booking system.
          message="Come and stay — pick the week you want and I will say yes."
          sendLabel="Send the link"
          copyLabel="Copy the link"
          primary
        />

        <p className="text-base">
          Anyone with it can ask. Only you say yes.
        </p>

        {/* Useful, occasionally, and never the reason anyone opened this. */}
        <details className="group">
          <summary className="flex min-h-11 list-none items-center gap-1.5 text-sm text-muted-foreground [&::-webkit-details-marker]:hidden">
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
            className="mt-2 w-52 max-w-full rounded-lg border border-border"
            shapeRendering="crispEdges"
            role="img"
            aria-label="QR code for the house link"
          >
            <rect width="100%" height="100%" fill="#ffffff" />
            <path d={qrPathData(qr)} fill="#0a0a0a" />
          </svg>
        </details>
      </section>

      {/* The calendar link -------------------------------------------------- */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg">Your calendar</h2>

        <FeedLink
          baseUrl={APP_URL}
          feedToken={house.feedToken}
          houseName={house.name}
        >
          <div className="flex flex-col gap-2">
            <p className="text-base">
              Anyone with this one can see who is staying and when.
            </p>
            <p className="text-sm text-muted-foreground">
              Calendars refresh on their own schedule. A stay you said yes to a
              minute ago can take a few hours to appear.
            </p>
          </div>
        </FeedLink>
      </section>
    </div>
  );
}
