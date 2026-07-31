import type { Metadata } from "next";
import { and, asc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { images } from "@/db/schema";
import { requireHouse } from "@/lib/session";

import { PhotosSection } from "./photos-section";

export const metadata: Metadata = {
  title: "Photos",
};

/**
 * `/app/photos` — a screen of its own, and the reason this route exists.
 *
 * Photographs used to be one section part-way down settings, which put the
 * single most valuable thing an owner can add to their link three taps and a
 * scroll away. They are also the only colour anywhere in this product: every
 * other pixel is paper, ink and one warm border. A destination that is the only
 * colour on the phone should not be a subheading on somebody else's screen.
 *
 * The query is the one that was in `settings/page.tsx`, moved with the section
 * it feeds: gallery photos only — both foreign keys null is the schema's way of
 * saying "this hangs on the house itself" rather than on a place or a guide
 * section — and `createdAt` breaks a tie so two photos sharing a position never
 * swap places between renders.
 */
export default async function PhotosPage() {
  const house = await requireHouse();

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
      {/* The statement every screen in this product opens with, rather than the
          word on the tab that got them here. What is actually on this screen is
          the first impression a cousin forms of the house — so say that. */}
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl text-balance">What they see first</h1>
        <p className="text-base text-muted-foreground">
          {photos.length === 0
            ? "Your link has no picture of the house on it yet. One good photograph is the whole invitation."
            : "They appear in the order you add them, so put the best one first."}
        </p>
      </header>

      <PhotosSection
        houseId={house.id}
        houseName={house.name}
        photos={photos}
      />
    </section>
  );
}
