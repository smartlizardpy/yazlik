import type { Metadata } from "next";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { images } from "@/db/schema";
import { requireHouse } from "@/lib/session";
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
    <section className="flex flex-1 flex-col gap-6 py-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          How your house reads on the link you share, and the rules every
          request has to meet.
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
    </section>
  );
}
