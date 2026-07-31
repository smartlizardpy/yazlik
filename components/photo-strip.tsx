"use client";

/**
 * The photo strip. One component, both sides of the product.
 *
 * A horizontal scroll-snap row of photos — `overflow-x-auto` plus `snap-x
 * snap-mandatory`, no carousel library. It scrolls inside itself, so the page
 * body never scrolls sideways no matter how many photos there are.
 *
 * Pass `onDelete` and every photo gets a remove control: that is the owner's
 * view. Leave it off and the strip is purely presentational: that is the
 * guest's. The privacy split in the plan is done by *not passing* the photos a
 * guest may not see — never by hiding them here.
 *
 * ### Where the padding lives
 *
 * The strip has no horizontal padding of its own, because the page it sits on
 * already has some and photos should run to the edge of the screen. Inside the
 * standard 560px column, that means:
 *
 * ```tsx
 * <PhotoStrip photos={photos} houseName={house.name} className="-mx-4 px-4" />
 * ```
 *
 * The negative margin cancels the page gutter; the padding keeps the first and
 * last photo off the glass.
 */

import { useState, useTransition } from "react";
import Image from "next/image";
import { ImageIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DEFAULT_LANG, t, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/* ============================================================
   TYPES
   ============================================================ */

/** The columns of an `images` row this component actually renders. */
export type StripPhoto = {
  id: string;
  url: string;
  alt: string | null;
};

/** The `{ ok }` shape every Server Action in this app returns. */
export type PhotoDeleteResult = { ok: true } | { ok: false; error: string };

/**
 * Removes one photo, by id.
 *
 * Written to take a Server Action directly — `deletePhoto` bound to nothing,
 * called with the id. It is expected to revalidate the page it belongs to: on
 * success the tile stays dimmed until the parent re-renders without it, which
 * is what makes the removal look final rather than optimistic.
 *
 * Returning `{ ok: false, error }` shows the message and restores the tile.
 * Throwing does the same with a generic message, so a Server Action that
 * redirects or a network blip cannot wedge the button.
 */
export type DeletePhoto = (
  photoId: string,
) => void | Promise<PhotoDeleteResult | void>;

export type PhotoStripProps = {
  photos: readonly StripPhoto[];
  /** Used for the strip's accessible name and as the honest alt fallback. */
  houseName: string;
  /** Owner view when present, guest view when absent. */
  onDelete?: DeletePhoto;
  /** Overrides the empty-state line. */
  emptyMessage?: string;
  /**
   * Language for the accessible names. The guest page passes the house's
   * language; the owner's settings screen is English only, so it can omit this.
   * Without it a screen reader announces a Turkish house in English.
   */
  language?: Lang;
  className?: string;
};

/* ============================================================
   ALT TEXT
   ============================================================ */

/**
 * The row's own alt, or something true about the picture.
 *
 * Never "image": a screen reader already says "image". The house name and the
 * photo's place in the strip are the two things we genuinely know.
 */
function altFor(
  photo: StripPhoto,
  index: number,
  total: number,
  houseName: string,
  language: Lang,
) {
  const own = photo.alt?.trim();
  if (own) return own;
  return total > 1
    ? t("photos.altNth", language, {
        name: houseName,
        index: String(index + 1),
        total: String(total),
      })
    : houseName;
}

/* ============================================================
   COMPONENT
   ============================================================ */

export function PhotoStrip({
  photos,
  houseName,
  onDelete,
  emptyMessage,
  language = DEFAULT_LANG,
  className,
}: PhotoStripProps) {
  // Which tile is asking "are you sure?", and which is mid-delete. One at a
  // time: two open confirmations on a 390px screen is a way to delete the
  // wrong photo.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [, startRemoval] = useTransition();

  const total = photos.length;

  if (total === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center",
          className,
        )}
      >
        <ImageIcon className="size-5 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-[36ch] text-sm text-muted-foreground">
          {emptyMessage ??
            (onDelete
              ? "No photos yet. Add a few and guests will see the house before they ask about it."
              : "No photos yet.")}
        </p>
      </div>
    );
  }

  function handleDelete(photo: StripPhoto) {
    if (!onDelete) return;
    setConfirming(null);
    setRemoving(photo.id);

    startRemoval(async () => {
      try {
        const result = await onDelete(photo.id);
        if (result && result.ok === false) {
          toast.error(result.error);
          setRemoving(null);
        }
        // On success the tile stays dimmed. The action revalidates and the
        // parent re-renders one photo shorter, which reads as the photo
        // leaving rather than a row blinking back to normal first.
      } catch (error) {
        console.error("[PhotoStrip] delete failed", error);
        toast.error("The photo did not delete. Try again in a moment.");
        setRemoving(null);
      }
    });
  }

  return (
    <ul
      // Focusable so the strip can be scrolled with a keyboard: the scrollbar
      // is hidden, and in the guest view there is nothing inside to tab to.
      tabIndex={0}
      aria-label={t("photos.aria", language, { name: houseName })}
      className={cn(
        "flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain rounded-lg",
        "scroll-p-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
    >
      {photos.map((photo, index) => {
        const isConfirming = confirming === photo.id;
        const isRemoving = removing === photo.id;
        const alt = altFor(photo, index, total, houseName, language);

        return (
          <li
            key={photo.id}
            className="relative w-[78%] max-w-[420px] shrink-0 snap-center"
          >
            <div className="relative aspect-[4/3] overflow-hidden rounded-lg bg-muted">
              <Image
                src={photo.url}
                alt={alt}
                fill
                // 390px first: a tile is 78% of the strip, and the strip is the
                // column, which stops growing at 560px.
                sizes="(max-width: 640px) 80vw, 420px"
                // The first tile is on screen the moment the strip is, so it
                // does not lazy-load; the rest are a swipe away. `priority` is
                // deprecated in Next 16 — `loading` says this plainly.
                //
                // No `fetchPriority="high"` here, though it was here until the
                // demo house had photographs in it to prove otherwise. A strip
                // is never the first thing on a screen: on the invitation it
                // sits below the hero, which is the one image someone is
                // actually waiting for and the only one that gets to jump the
                // queue. Two `high` images on mobile data means the hero
                // arrives second.
                loading={index === 0 ? "eager" : "lazy"}
                className={cn(
                  "object-cover transition-opacity",
                  (isRemoving || isConfirming) && "opacity-40",
                )}
              />
            </div>

            {onDelete && !isRemoving && !isConfirming ? (
              <button
                type="button"
                onClick={() => setConfirming(photo.id)}
                aria-label={t("photos.remove", language, { alt })}
                className="absolute top-2 right-2 flex size-11 items-center justify-center rounded-full bg-background/85 text-foreground backdrop-blur transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <XIcon className="size-5" aria-hidden="true" />
              </button>
            ) : null}

            {isRemoving ? (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg">
                <p className="rounded-lg bg-background/85 px-3 py-2 text-sm backdrop-blur">
                  Removing…
                </p>
              </div>
            ) : null}

            {isConfirming ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-lg bg-background/85 p-3 backdrop-blur">
                <div className="text-center">
                  <p className="text-sm font-medium">Remove this photo?</p>
                  <p className="text-xs text-muted-foreground">
                    It is deleted for good — you would have to upload it again.
                  </p>
                </div>
                <div className="flex w-full gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setConfirming(null)}
                    className="h-11 flex-1"
                  >
                    Keep it
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => handleDelete(photo)}
                    className="h-11 flex-1"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
