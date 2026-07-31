import type { Metadata } from "next";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { images } from "@/db/schema";
import { isGoogleConfigured } from "@/lib/google/config";
import { requireHouse } from "@/lib/session";
import { GoogleSection } from "./google-section";
import { PhotosSection } from "./photos-section";
import { SettingsForm } from "./settings-form";

export const metadata: Metadata = {
  title: "Settings",
};

/**
 * The owner's own screen: what the house is called, what a request has to meet,
 * and how much the link gives away.
 *
 * `requireHouse()` is the whole guard — the owner layout already established
 * there is a session, and this redirects to onboarding if there is no house to
 * configure yet.
 *
 * The row is narrowed before it crosses to the client. The form has no use for
 * the slug, the feed token, or the Google calendar id, and the feed token is
 * the private subscribe URL — it should not travel in a payload that does not
 * need it.
 */
export default async function SettingsPage() {
  const house = await requireHouse();

  // Gallery photos only: both foreign keys null is the schema's way of saying
  // "this hangs on the house itself" rather than on a place or a guide section.
  // `createdAt` breaks a tie so two photos sharing a position never swap places
  // between renders.
  const photos = await db
    .select({ id: images.id, url: images.url, alt: images.alt })
    .from(images)
    .where(
      and(
        eq(images.houseId, house.id),
        isNull(images.placeId),
        isNull(images.sectionId),
      ),
    )
    .orderBy(asc(images.position), asc(images.createdAt));

  return (
    <section className="flex flex-1 flex-col gap-6 pt-8 pb-6">
      {/* A statement, at the size every other h1 in the product is. "Settings"
          named the panel rather than the screen — what is actually here is the
          house as everyone else meets it, and what you have already agreed to.

          `pt-8`, not `pt-6`: the owner shell's header is sticky, opaque and
          ruled, and the content underneath it scrolls right up to that hairline.
          The extra 8px is the difference between a screen that starts and one
          that looks cropped. Every section below carries `scroll-mt-20` for the
          same reason — the 60px header must never be what a jumped-to field
          lands behind. */}
      <header className="flex scroll-mt-20 flex-col gap-2">
        <h1 className="text-2xl text-balance">How the house reads</h1>
        <p className="text-base text-muted-foreground">
          The photos and words on your link, and what you will say yes to when
          someone asks.
        </p>
      </header>

      {/* Above the form, not inside it. The form ends in the sticky "Save
          changes" bar, and a primary button with more of the screen after it
          reads as belonging to whatever follows. Photos save on their own. */}
      <PhotosSection
        houseId={house.id}
        houseName={house.name}
        photos={photos}
      />

      <SettingsForm
        house={{
          id: house.id,
          name: house.name,
          town: house.town,
          country: house.country,
          language: house.language,
          blurb: house.blurb,
          minNights: house.minNights,
          maxNights: house.maxNights,
          gapDays: house.gapDays,
          maxGuests: house.maxGuests,
          bookableFrom: house.bookableFrom,
          bookableTo: house.bookableTo,
          showGuestNames: house.showGuestNames,
        }}
      />

      {/* Last, and on purpose.

          Connecting a calendar is a once-ever setup step. The name, the words
          and the photos are what an owner opens this screen to change, and they
          open it more than once — so second position was going to the most
          inert block on the page. On an install with no OAuth client this is a
          heading and one sentence with nothing to press; it belongs at the foot
          of the screen, where a footnote belongs.

          Like photos, it saves on its own rather than through the form's sticky
          bar — connecting a calendar is a round trip to Google, not a field. The
          bar is `sticky bottom-0` *inside* the form, so it pins to the form's own
          box and releases at its end rather than floating over this.
          `configured` is read on the server: a client component must not be the
          thing that decides whether credentials exist. */}
      <GoogleSection
        configured={isGoogleConfigured()}
        houseName={house.name}
      />
    </section>
  );
}
