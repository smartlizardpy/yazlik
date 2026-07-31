"use client";

/**
 * One section of the guide, as the owner sees it.
 *
 * ### Closed, it is a line of a guide. Open, it is a form.
 *
 * A card that showed a title, a body, a photo, a visibility control, two
 * reorder arrows and a delete would be six controls per row and eight rows on
 * the screen — a table with rounded corners. So at rest a section is what it
 * is on the guest's page: a title, and the first thing it says. Tapping it
 * opens the one you meant, and everything you can do to a section is inside it.
 *
 * ### Except the flip, which stays out
 *
 * `createSection` and the parser both default an unknown visibility to
 * **guests**, deliberately: a section wrongly kept private is a missing
 * paragraph, and a section wrongly made public is the door code in a family
 * WhatsApp group. The cost of that lean is that the owner's job right after a
 * draft lands is to move several sections the other way — so that move cannot
 * be two taps deep inside a card. It is a row of its own on the outside of
 * every card, and it says what will happen rather than naming a state:
 * *Let everyone read this*, not "Public".
 */

import { useId, useState } from "react";
import Image from "next/image";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, EyeIcon, LockIcon } from "lucide-react";
import { toast } from "sonner";

import {
  deleteSection,
  toggleSectionVisibility,
  updateSection,
} from "@/app/_actions/guide";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { GuideSectionView } from "@/lib/guide";
import { cn } from "@/lib/utils";

import { CardPhoto, ConfirmDelete, useGuideAction } from "./guide-parts";

/** Enough of the body to recognise the section by, on one or two lines. */
function preview(body: string): string | null {
  const written = body.trim().replace(/\s+/g, " ");
  return written === "" ? null : written;
}

export function SectionCard({
  section,
  houseId,
  houseName,
  first,
  last,
  onMove,
}: {
  section: GuideSectionView;
  houseId: string;
  houseName: string;
  /** First and last of its own half, so the arrows can go quiet at the ends. */
  first: boolean;
  last: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(section.title);
  const [body, setBody] = useState(section.body);
  const { pending, run } = useGuideAction();

  const titleId = useId();
  const bodyId = useId();

  const changed = title !== section.title || body !== section.body;
  const line = preview(section.body);
  const photo = section.photos[0];

  function save() {
    run(() => updateSection(section.id, { title, body }), () => setOpen(false));
  }

  function cancel() {
    setTitle(section.title);
    setBody(section.body);
    setOpen(false);
  }

  return (
    <li className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      {/* Closed ------------------------------------------------------------- */}
      <button
        type="button"
        onClick={() => (open ? cancel() : setOpen(true))}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-4 py-3.5 text-left focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {photo ? (
          <Image
            src={photo.url}
            alt=""
            width={96}
            height={96}
            className="size-12 shrink-0 rounded-md object-cover"
          />
        ) : null}
        <span className="min-w-0 flex-1">
          <span className="font-heading block text-lg break-words">
            {section.title}
          </span>
          {/* Two lines, and only while the card is shut. Open, the same words
              are in the textarea a thumb below, and printing them twice made a
              card that was mostly its own echo.

              No `block` alongside `line-clamp-2`: the clamp *is* a display
              rule (`-webkit-box`), and the two utilities were fighting over the
              same property — `block` won, the clamp did nothing, and every card
              in the list stood as tall as its longest paragraph.

              A section with nothing under it is correct, not broken: the prompt
              asks for the guests-only half as titles for exactly this reason.
              So it is said plainly and quietly rather than flagged. */}
          {open ? null : (
            <span className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
              {line ?? "Nothing under it yet."}
            </span>
          )}
        </span>
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "mt-1 size-5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {/* Open --------------------------------------------------------------- */}
      {open ? (
        <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={titleId}>Title</Label>
            <Input
              id={titleId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="h-11 text-base"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={bodyId}>What it says</Label>
            <Textarea
              id={bodyId}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              className="text-base"
            />
            <p className="text-xs text-muted-foreground">
              A title with nothing under it is fine. Some of these are a note to
              yourself until you fill them in.
            </p>
          </div>

          <CardPhoto
            houseId={houseId}
            houseName={houseName}
            photos={section.photos}
            sectionId={section.id}
            label="A photograph, if it helps — the gate, the fuse box, the turning."
          />

          <div className="flex gap-2">
            <Button
              type="button"
              onClick={save}
              disabled={pending || !changed}
              className="h-11 flex-1"
            >
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={cancel}
              className="h-11 px-4"
            >
              Close
            </Button>
          </div>

          {/* The two errands that are not about the words --------------------- */}
          <div className="flex items-center gap-1 border-t border-border pt-3">
            <Button
              type="button"
              variant="ghost"
              aria-label="Move up"
              disabled={first || pending}
              onClick={() => onMove(-1)}
              className="size-11"
            >
              <ArrowUpIcon className="size-5" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              aria-label="Move down"
              disabled={last || pending}
              onClick={() => onMove(1)}
              className="size-11"
            >
              <ArrowDownIcon className="size-5" aria-hidden="true" />
            </Button>
            <ConfirmDelete
              what="section"
              disabled={pending}
              onDelete={() => run(() => deleteSection(section.id))}
            />
          </div>
        </div>
      ) : null}

      {/* Who reads it -------------------------------------------------------- */}
      {/* One tap, and then it says what it did. Moving a paragraph onto a link
          that is sitting in a family WhatsApp group is the most consequential
          thing on this screen, so it is not silent — but it is not a
          confirmation dialog either: the same button undoes it, and a section
          wrongly kept private costs a paragraph while a dialog on every flip
          costs the tap this whole row exists to be. */}
      <button
        type="button"
        onClick={() =>
          run(() => toggleSectionVisibility(section.id), () =>
            toast.success(
              section.visibility === "guests"
                ? "Anyone with the link can read this now."
                : "Only your guests see this now.",
            ),
          )
        }
        disabled={pending}
        className="flex min-h-11 w-full items-center gap-2 border-t border-border px-4 py-2 text-left text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:opacity-50"
      >
        {section.visibility === "guests" ? (
          <>
            <EyeIcon className="size-4 shrink-0" aria-hidden="true" />
            Let everyone read this
          </>
        ) : (
          <>
            <LockIcon className="size-4 shrink-0" aria-hidden="true" />
            Keep this for your guests only
          </>
        )}
      </button>
    </li>
  );
}
