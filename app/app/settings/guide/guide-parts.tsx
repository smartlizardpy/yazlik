"use client";

/**
 * The three things a section card and a place card both need.
 *
 * Written once here because they are genuinely the same thing in both places —
 * not because two files happened to look alike. Each is small and each has one
 * rule in it that must not be decided twice.
 */

import { useCallback, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import type { ActionResult } from "@/app/_actions/house";
import { deleteImage } from "@/app/_actions/image";
import { ImageUploader } from "@/components/image-uploader";
import { PhotoStrip, type StripPhoto } from "@/components/photo-strip";
import { Button } from "@/components/ui/button";

/* ============================================================
   RUNNING AN ACTION
   ============================================================ */

/**
 * Call a guide action, then ask the server for this page again.
 *
 * Every action in `app/_actions/guide.ts` revalidates `/app` — but that clears
 * the server's cache, not the client router's copy of the screen the owner is
 * looking at, so without the `router.refresh()` a saved title stays as it was
 * on screen. The same rule as `photos-section.tsx`: one refresh, every
 * direction, and the list is never a lie.
 *
 * A refusal is shown exactly as the action wrote it. Those messages are
 * sentences aimed at the person holding the phone, not error codes.
 */
export function useGuideAction() {
  const router = useRouter();
  const [pending, startAction] = useTransition();

  const run = useCallback(
    (action: () => Promise<ActionResult>, onDone?: () => void) => {
      startAction(async () => {
        try {
          const result = await action();
          if (!result.ok) {
            toast.error(result.error);
            return;
          }
          router.refresh();
          onDone?.();
        } catch (error) {
          console.error("[guide] action failed", error);
          toast.error("That did not save. Try again in a moment.");
        }
      });
    },
    [router],
  );

  return { pending, run, refresh: () => router.refresh() };
}

/* ============================================================
   DELETING
   ============================================================ */

/**
 * Delete, asked twice, in the row rather than in a dialog.
 *
 * The same shape `PhotoStrip` uses for the same reason: a section is gone for
 * good, and a single tappable word beside a scroll gesture eventually removes
 * the wrong one. No `window.confirm` — a native dialog blocks the page and
 * looks nothing like the app around it.
 */
export function ConfirmDelete({
  what,
  onDelete,
  disabled,
}: {
  /** "section" or "place" — goes into the question and the button. */
  what: string;
  onDelete: () => void;
  disabled?: boolean;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <Button
        type="button"
        variant="ghost"
        onClick={() => setAsking(true)}
        disabled={disabled}
        // Not red yet. `--destructive` is the one non-neutral in this system
        // and it belongs on the tap that actually destroys something — the same
        // rule `PhotoStrip` follows, where the X is plain and only "Remove"
        // carries the colour.
        className="h-11 px-3 text-muted-foreground"
      >
        Delete
      </Button>
    );
  }

  return (
    <div className="flex flex-1 items-center justify-end gap-2">
      <p className="mr-auto text-sm">Delete this {what}?</p>
      <Button
        type="button"
        variant="outline"
        onClick={() => setAsking(false)}
        className="h-11 px-3"
      >
        Keep it
      </Button>
      <Button
        type="button"
        variant="destructive"
        onClick={() => {
          setAsking(false);
          onDelete();
        }}
        disabled={disabled}
        className="h-11 px-3"
      >
        Delete
      </Button>
    </div>
  );
}

/* ============================================================
   THE ONE PHOTOGRAPH
   ============================================================ */

/**
 * A section or a place holds exactly one photo — `SINGLE_LIMIT` in
 * `app/api/upload/route.ts` is the authority and refuses the second under a row
 * lock. This shows the one that is there, or offers to add it, and never both.
 *
 * `PhotoStrip` is imported rather than reimplemented: it already carries the
 * two-step confirmation, the dimming, and the alt-text rules. Its tile is 78%
 * of its own width because it is built to say "there is another one, swipe" —
 * with a single photo that leaves a sliver of paper on the right, which is the
 * price of not forking it and is cheaper than a second photo component.
 */
export function CardPhoto({
  houseId,
  houseName,
  photos,
  sectionId,
  placeId,
  label,
}: {
  houseId: string;
  houseName: string;
  photos: readonly StripPhoto[];
  sectionId?: string;
  placeId?: string;
  /** What the picker calls the thing this photo would be of. */
  label: string;
}) {
  const router = useRouter();
  const headingId = useId();

  async function removePhoto(photoId: string) {
    const result = await deleteImage(photoId);
    if (result.ok) router.refresh();
    return result;
  }

  return (
    <div className="flex flex-col gap-2">
      <p id={headingId} className="text-xs font-medium text-muted-foreground">
        {label}
      </p>
      {photos.length > 0 ? (
        <PhotoStrip
          photos={photos}
          houseName={houseName}
          onDelete={removePhoto}
        />
      ) : (
        <ImageUploader
          houseId={houseId}
          sectionId={sectionId}
          placeId={placeId}
          max={1}
          count={0}
          onUploaded={() => router.refresh()}
        />
      )}
    </div>
  );
}
