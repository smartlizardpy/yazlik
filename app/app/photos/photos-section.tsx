"use client";

/**
 * The house gallery, on the settings screen.
 *
 * Two components that already exist, wired to the one action that already
 * exists: `PhotoStrip` in owner mode shows what is there and removes one,
 * `ImageUploader` adds more, `deleteImage` does the deleting. Nothing about
 * photos is reimplemented here — this file is the wiring and the copy.
 *
 * ### Why a client component
 *
 * Uploading goes through `POST /api/upload`, a route handler. Its
 * `revalidatePath` clears the server's cache but cannot reach into the client
 * router's copy of this page, so without a `router.refresh()` the photo would
 * land in the database and the strip above would keep showing the old set.
 * Deleting is a Server Action and revalidates through its own channel, but it
 * is refreshed the same way rather than relying on that difference: one rule,
 * both directions, and the strip is never a lie.
 *
 * The gallery rows are loaded in `page.tsx` and passed in, the same way
 * `SettingsForm` is handed its house.
 *
 * ### Confirming a delete
 *
 * There is no confirmation dialog in this file because `PhotoStrip` already
 * asks: tapping the X turns the tile into "Remove this photo?" with **Keep it**
 * and **Remove**. That is deliberate — a photo is gone for good, and a single
 * 44px X beside a scroll gesture eventually deletes the wrong one. No
 * `window.confirm`: a native dialog blocks the page and looks nothing like the
 * app around it.
 */

import { useId } from "react";
import { useRouter } from "next/navigation";

import { deleteImage } from "@/app/_actions/image";
import { ImageUploader } from "@/components/image-uploader";
import { PhotoStrip, type StripPhoto } from "@/components/photo-strip";

/**
 * How many photos the strip on `/h/[slug]` holds.
 *
 * The authority is `GALLERY_LIMIT` in `app/api/upload/route.ts`, which refuses
 * the thirteenth under a row lock. This copy only shapes the hint and stops the
 * picker offering room that is not there — if the two ever disagree, the server
 * still wins and says so.
 */
const GALLERY_MAX = 12;

export type PhotosSectionProps = {
  houseId: string;
  /** The strip's accessible name, and the alt fallback for a photo with none. */
  houseName: string;
  /** Gallery photos only, in `position` order. */
  photos: StripPhoto[];
};

export function PhotosSection({ houseId, houseName, photos }: PhotosSectionProps) {
  const router = useRouter();
  const headingId = useId();

  /**
   * Hands the id to the action and, on success, asks the server for this page
   * again. `PhotoStrip` keeps the tile dimmed until that arrives, so the photo
   * fades and then leaves rather than blinking back first.
   *
   * A failure is returned untouched: the action's message is written for the
   * person holding the phone, and the strip shows it and restores the tile.
   */
  async function removePhoto(photoId: string) {
    const result = await deleteImage(photoId);
    if (result.ok) router.refresh();
    return result;
  }

  return (
    <section
      aria-labelledby={headingId}
      className="flex scroll-mt-20 flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className="text-lg">
          Photos
        </h2>
        <p className="text-sm text-muted-foreground">
          The first thing anyone sees on your link. They appear in the order you
          add them, so put the best one first.
        </p>
      </div>

      {/* Nothing to show yet, so nothing is shown. The strip's own empty panel
          is a dashed box that says "no photos" and cannot be tapped, sitting
          directly above a button that can — two things where the uploader's
          panel is one, and that one opens the camera roll. */}
      {photos.length > 0 ? (
        <PhotoStrip
          photos={photos}
          houseName={houseName}
          onDelete={removePhoto}
          // The strip has no gutter of its own: cancel the page's and put it
          // back inside, so photos run to the edge of the screen.
          className="-mx-4 px-4"
        />
      ) : null}

      <ImageUploader
        houseId={houseId}
        max={GALLERY_MAX}
        count={photos.length}
        // With no photos above it, the picker is the whole block and looks like
        // one: a dashed panel the size of the strip it is about to become.
        variant={photos.length === 0 ? "panel" : "button"}
        // Every photo that lands. The uploader sends them one at a time, so the
        // strip grows a photo at a time rather than all at once at the end.
        onUploaded={() => router.refresh()}
      />
    </section>
  );
}
