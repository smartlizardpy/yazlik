/**
 * `/` — the only screen in this product that meets a stranger.
 *
 * Every other page serves somebody who was already invited, so it can be
 * purely functional. This one has to make a person *want* the thing, and it has
 * to do that without ever sounding like software being sold — the moment it
 * does, it stops being the same product as the invitation behind the button.
 *
 * The way out of that is to stop claiming and start showing. The most
 * convincing thing about Yazlık is what the link actually looks like when it
 * opens on somebody's phone, so the middle of this page is that: the
 * photograph, the house's name, and August with Selin's week struck through
 * and Mehmet's week still dashed because nobody has answered him yet. The copy
 * around it does two things only — hands off to the picture ("It opens on
 * their phone like this."), and names what the owner does next in the two words
 * the button on `/app` actually says. No benefit statements, because the
 * specific is more persuasive than the general and it is also the voice.
 *
 * ### The card is a depiction, not a live listing
 *
 * The name, the town, the month, the two runs and Selin's sentence are fixed
 * strings. They are the seed house, which is the house this product was written
 * around, and they are deliberately not read from the database: half a card of
 * live data next to a hard-coded "Selin" is incoherent the moment anybody edits
 * the demo. The **photograph** is the one exception, because a landing page
 * that hard-codes an upload path is a landing page that breaks on a fresh
 * clone. It is looked up, and when it is not there the card falls back to the
 * same paper-and-hairline block the real hero falls back to — one code path
 * shown honestly rather than a picture that failed to load.
 *
 * ### Copy lives here, not in i18n
 *
 * This page is owner-facing, and every owner-facing screen in the app —
 * `/sign-in`, `/app`, `/app/settings` — is English-only with its strings in the
 * markup. The dictionaries carry the *guest* side, which is the side that has a
 * language column to obey. Adding forty landing-page keys to both files would
 * have made this the one owner screen that pretends to be translated.
 *
 * ### Who lands here, and what each of them gets
 *
 * **An owner, cold**, who has four seconds and has never heard of this. The
 * page is built for them, and the one loud thing on it offers them the thing
 * the page just showed: a link for their own house.
 *
 * **An owner who already has one** and is only signed out. The masthead carries
 * a quiet "Sign in" for them, because the button at the bottom offers to make
 * something they made last summer. Both go to `/sign-in` — there is one door
 * and it is a magic link — but the words have to be right for whoever reads
 * them.
 *
 * **A cousin** who was sent `/h/kj39dk2` and trimmed the URL out of habit. One
 * sentence under a hairline at the bottom, because they are a confused minority
 * and not the reason this page exists.
 *
 * An owner who is *already* signed in never sees any of it — they are sent to
 * `/app`.
 */

import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { and, asc, eq, isNull } from "drizzle-orm";

import { LegalFooter } from "@/components/legal-footer";
import { db } from "@/db";
import { houses, images } from "@/db/schema";
import { getSession } from "@/lib/session";
import { cn } from "@/lib/utils";

/* ============================================================
   WHAT THE CARD SHOWS
   ============================================================ */

/** The house `pnpm db:seed` writes. Its first photograph is the only lookup. */
const DEMO_SLUG = "demo-house";

/**
 * August 2026 begins on a Saturday and the grid runs Monday-first, the same as
 * `en-GB` on the real calendar — so five blank cells, then 1.
 */
const LEADING_BLANKS = 5;
const DAYS_IN_MONTH = 31;

/**
 * The two runs, taken straight off `/h/demo-house`.
 *
 * Selin has 4–10 August and Mehmet has asked for 18–23. Both are half-open: a
 * stay ending on the 10th leaves the 10th free for the next arrival, which is
 * why the fill stops at the 9th and the dashes stop at the 22nd. Getting this
 * wrong by one day would be the page quietly contradicting the product.
 */
const TAKEN = { from: 4, to: 9 } as const;
const ASKED = { from: 18, to: 22 } as const;

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/* ============================================================
   THE PHOTOGRAPH
   ============================================================ */

/**
 * The demo house's cover photo, or nothing.
 *
 * Both foreign keys null is the same filter the invitation uses: that is a
 * photo hanging on the house itself rather than on a place or a guide section.
 * Wrapped, because a landing page is the last thing that should 500 when the
 * database is asleep — an unreachable Neon costs the picture, not the page.
 */
async function invitationPhoto(): Promise<{
  url: string;
  alt: string | null;
} | null> {
  try {
    const [photo] = await db
      .select({ url: images.url, alt: images.alt })
      .from(images)
      .innerJoin(houses, eq(images.houseId, houses.id))
      .where(
        and(
          eq(houses.slug, DEMO_SLUG),
          isNull(images.placeId),
          isNull(images.sectionId),
        ),
      )
      .orderBy(asc(images.position), asc(images.createdAt))
      .limit(1);

    return photo ?? null;
  } catch {
    return null;
  }
}

/* ============================================================
   THE MONTH
   ============================================================ */

/**
 * August, drawn the way the guest's calendar draws it.
 *
 * Same two marks, same reasons: a taken night is a fill with the number struck
 * through at a stronger contrast than the number itself, and a night somebody
 * has asked for is a dashed rule top and bottom — lighter, because "asked for"
 * must never read as "gone". The cells sit flush so a run is one continuous
 * band, and only the two ends of a run are rounded.
 *
 * It is smaller than the real grid and it is not tappable, so the 44px rule
 * does not apply: nothing here is a target. `role="img"` is what keeps a screen
 * reader from counting to thirty-one out loud — the label says what the picture
 * says, once.
 */
function MonthGrid() {
  const days = Array.from({ length: DAYS_IN_MONTH }, (_, i) => i + 1);

  return (
    <div
      role="img"
      aria-label="August 2026. The 4th to the 9th are taken. Somebody has asked for the 18th to the 22nd and is waiting on an answer."
      className="flex flex-col"
    >
      <div className="grid grid-cols-7 pb-1">
        {WEEKDAYS.map((day) => (
          <span
            key={day}
            className="flex justify-center text-xs text-muted-foreground"
          >
            {day}
          </span>
        ))}
      </div>

      <div className="num grid grid-cols-7">
        {Array.from({ length: LEADING_BLANKS }, (_, i) => (
          <span key={`blank-${i}`} className="h-9" />
        ))}

        {days.map((day) => {
          const taken = day >= TAKEN.from && day <= TAKEN.to;
          const asked = day >= ASKED.from && day <= ASKED.to;

          return (
            <span
              key={day}
              className={cn(
                "flex h-9 items-center justify-center text-sm",
                taken &&
                  "bg-taken line-through decoration-2 decoration-foreground/50",
                taken && day === TAKEN.from && "rounded-l-md",
                taken && day === TAKEN.to && "rounded-r-md",
                asked &&
                  "border-y-2 border-dashed border-muted-foreground/55",
                asked && day === ASKED.from && "rounded-l-md border-l-2",
                asked && day === ASKED.to && "rounded-r-md border-r-2",
              )}
            >
              {day}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ============================================================
   THE CARD
   ============================================================ */

/**
 * The invitation, one size down, lying on the page as an object.
 *
 * A white card with a border rather than the full-bleed composition the real
 * page uses, because here it is a picture *of* a screen and needs an edge to be
 * one. Everything inside is set a step below the page's own type — the house's
 * name is 28px against a 40px heading — so it reads as something being shown
 * rather than something competing.
 *
 * `black/70` and `white` are the only values here that are not tokens, and they
 * are the same ones the real hero uses over the same photograph: a scrim has to
 * hold its contrast whichever way the theme goes.
 */
function InvitationCard({
  photo,
}: {
  photo: { url: string; alt: string | null } | null;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      {photo ? (
        <div className="relative aspect-16/10">
          <Image
            src={photo.url}
            alt={photo.alt?.trim() || "The Çeşme house, from the terrace."}
            fill
            sizes="(max-width: 640px) 100vw, 528px"
            // The only colour on the screen and the reason anyone stays.
            loading="eager"
            fetchPriority="high"
            className="object-cover"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-linear-to-t from-black/70 via-black/25 to-transparent"
          />
          <div className="relative flex h-full flex-col justify-end gap-0.5 p-4 text-white">
            <p className="text-xs text-white/75">You&rsquo;re invited to</p>
            <p className="font-heading text-xl">The Çeşme house</p>
            <p className="text-xs text-white/85">Çeşme, Turkey</p>
          </div>
        </div>
      ) : (
        // No seed, no photograph — the same block the real hero falls back to.
        <div className="flex flex-col gap-0.5 bg-secondary px-4 pt-8 pb-6">
          <span aria-hidden="true" className="mb-5 h-px w-10 bg-foreground/25" />
          <p className="text-xs text-muted-foreground">You&rsquo;re invited to</p>
          <p className="font-heading text-xl">The Çeşme house</p>
          <p className="text-xs text-muted-foreground">Çeşme, Turkey</p>
        </div>
      )}

      <div className="flex flex-col gap-3 p-4">
        <p className="num font-heading text-lg">August 2026</p>
        <MonthGrid />
        {/* The one sentence on the real page with a person in it. */}
        <p className="font-heading text-base text-pretty">
          Selin has a week here already.
        </p>
      </div>
    </div>
  );
}

/* ============================================================
   PAGE
   ============================================================ */

export default async function Home() {
  // Both up front: an owner who is already signed in is the rarer visitor here,
  // and making the stranger — who is the whole point of the page — wait for a
  // session before the photograph is even asked for is the wrong trade.
  const [session, photo] = await Promise.all([getSession(), invitationPhoto()]);

  // Somebody who owns a house has no use for the sign that points at the door.
  if (session) redirect("/app");

  return (
    <section className="flex flex-1 flex-col pt-8 pb-8">
      {/* The mark, set exactly as it is on `/sign-in` so it does not change
          size on the way through — and next to it the quiet door, for the owner
          who already has a house and only came here to get back in. The loud
          button at the bottom is not for them: it offers to make something they
          have already made. Both go to the same place, because there is only
          one door and it is a magic link. */}
      <div className="flex items-baseline justify-between gap-4">
        <p className="font-heading text-lg">Yazlık</p>
        <Link
          href="/sign-in"
          className="-me-2 flex min-h-11 items-center px-2 text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Sign in
        </Link>
      </div>

      {/* The whole product in two sentences a person would actually say. The
          first is the owner's own summer, in their words; the second is the
          only claim on the page, and it is one line long. 40px on a phone and
          48px once there is a column wide enough to hold it in three lines. */}
      <h1 className="pt-12 text-3xl text-balance sm:text-4xl">
        Everyone asks for the house in August. You send them one link.
      </h1>

      {/* The action sits directly under the sentence that earns it.
          It used to live at the very bottom, past the whole invitation card and
          the owner's half, which on a phone is two screens of scrolling before
          the only thing there is to do. Someone convinced by the headline should
          not have to go looking. What follows is for whoever needs more than one
          sentence, and there is a quieter repeat at the end for them.

          It says what pressing it leads to rather than what the auth layer calls
          it: "Sign in" names a mechanism, and tells a first-timer they are
          missing an account nobody asked them to make. This borrows the page's
          own noun — the whole product is one link, and this is where you get
          yours. It still lands on `/sign-in`, because an email and a magic link
          is the entire signing up there is. */}
      <Link
        href="/sign-in"
        className="mt-9 flex min-h-14 items-center justify-center rounded-xl bg-primary px-4 text-center text-base text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Make a link for your house
      </Link>

      {/* Stage direction, not a label. Without it the card can be misread as a
          house being advertised rather than an invitation being shown. */}
      <figure className="flex flex-col gap-3 pt-11">
        <figcaption className="text-sm text-muted-foreground">
          It opens on their phone like this.
        </figcaption>
        <InvitationCard photo={photo} />
      </figure>

      {/* The owner's half, which is one gesture. "Say yes" and "not that week"
          are verbatim the two buttons on `/app`, so the promise made here is
          the screen they get. */}
      <p className="pt-10 font-heading text-lg text-pretty">
        Mehmet has asked for the week of the 18th. You say yes, or not that
        week.
      </p>
      {/* Muted, and the same size. Two sentences of equal weight one under the
          other is the page arguing with itself; this one is the quiet fact
          under the sentence that carries the product, the same relation the
          welcome line has to the blurb on the invitation. */}
      <p className="pt-4 text-base text-muted-foreground text-pretty">
        Nobody makes an account except you, and no money changes hands anywhere
        in it.
      </p>

      {/* The repeat, for whoever read the whole way down. Deliberately NOT a
          second ink button: two identical primary actions on one short page is
          a page shouting, and the one at the top is forty lines away. An
          underlined link in the same words is enough to act on and quiet enough
          to scroll past.

          `mt-auto` costs nothing on a phone, where the page is already longer
          than the glass. It earns its place on a tall desktop window, where
          without it the footnote would float in the middle with paper below. */}
      <div className="mt-auto flex flex-col gap-5 pt-12">
        <Link
          href="/sign-in"
          className="flex min-h-11 items-center text-base underline underline-offset-4 transition-colors hover:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Make a link for your house
        </Link>

        {/* The cousin who arrived here by deleting the end of a URL. */}
        <p className="border-t border-border pt-5 text-sm text-muted-foreground text-pretty">
          Sent a link to somebody&rsquo;s house? Open that one instead — this
          side is for whoever owns it.
        </p>
      </div>

      <LegalFooter />
    </section>
  );
}
