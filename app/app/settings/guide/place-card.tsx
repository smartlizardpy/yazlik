"use client";

/**
 * One place — a restaurant, a beach, a walk — as the owner sees it.
 *
 * The same card as a section, minus the one thing a place does not have:
 * `places` has no visibility column and should not grow one. A fish restaurant
 * is a public fact about a town; anything private about it — "the blue gate is
 * ours, the one before the café" — is a guests-only *section*. See the head of
 * `lib/guide.ts`.
 *
 * What a place has instead is a **category**, and it is not shown as a label on
 * the row. It is the heading the row is filed under, here and on the guest's
 * page, so the picker inside the card offers those headings rather than the
 * six enum values.
 *
 * The map link is whatever the owner pastes. There is no Maps or Places API
 * anywhere in this product — that was a cost decision — so this is a plain URL
 * field, and a place without one simply does not link anywhere.
 */

import { useId, useState } from "react";
import Image from "next/image";
import { ArrowDownIcon, ArrowUpIcon, ChevronDownIcon, MapPinIcon } from "lucide-react";

import { deletePlace, updatePlace } from "@/app/_actions/guide";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { PlaceCategory } from "@/db/schema";
import type { PlaceView } from "@/lib/guide";
import { cn } from "@/lib/utils";

import { CATEGORY_LABEL, CATEGORY_ORDER } from "./categories";
import { CardPhoto, ConfirmDelete, useGuideAction } from "./guide-parts";

export function PlaceCard({
  place,
  houseId,
  houseName,
  first,
  last,
  onMove,
}: {
  place: PlaceView;
  houseId: string;
  houseName: string;
  /** First and last **of its own group**, which is what the arrows move within. */
  first: boolean;
  last: boolean;
  onMove: (direction: -1 | 1) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(place.name);
  const [category, setCategory] = useState<PlaceCategory>(place.category);
  const [note, setNote] = useState(place.note ?? "");
  const [mapUrl, setMapUrl] = useState(place.mapUrl ?? "");
  const { pending, run } = useGuideAction();

  const nameId = useId();
  const categoryId = useId();
  const noteId = useId();
  const mapId = useId();

  const changed =
    name !== place.name ||
    category !== place.category ||
    note !== (place.note ?? "") ||
    mapUrl !== (place.mapUrl ?? "");

  const photo = place.photos[0];

  function save() {
    run(
      () =>
        updatePlace(place.id, {
          name,
          category,
          note: note.trim() === "" ? null : note,
          mapUrl: mapUrl.trim() === "" ? null : mapUrl,
        }),
      () => setOpen(false),
    );
  }

  function cancel() {
    setName(place.name);
    setCategory(place.category);
    setNote(place.note ?? "");
    setMapUrl(place.mapUrl ?? "");
    setOpen(false);
  }

  return (
    <li className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
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
          <span className="font-heading flex items-center gap-1.5 text-lg break-words">
            {place.name}
            {/* Not a label saying "has a link" — the pin is the link, said in
                the smallest mark that can say it. */}
            {place.mapUrl ? (
              <MapPinIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-label="Has a map link"
              />
            ) : null}
          </span>
          {/* Shut only, and clamped to two lines. `line-clamp-2` sets the
              display itself, so a `block` beside it is a second rule for the
              same property and the clamp loses. */}
          {open ? null : (
            <span className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
              {place.note?.trim() || "No note under it."}
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

      {open ? (
        <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-11 text-base"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={categoryId}>Filed under</Label>
            <Select
              value={category}
              onValueChange={(value) => setCategory(value as PlaceCategory)}
            >
              <SelectTrigger id={categoryId} className="h-11 w-full text-base">
                <SelectValue>{CATEGORY_LABEL[category]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {CATEGORY_ORDER.map((value) => (
                  <SelectItem key={value} value={value} className="min-h-11">
                    {CATEGORY_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={noteId}>Note</Label>
            <Textarea
              id={noteId}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              placeholder="One sentence, the way you would say it."
              className="text-base"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor={mapId}>Map link</Label>
            <Input
              id={mapId}
              type="url"
              inputMode="url"
              value={mapUrl}
              onChange={(event) => setMapUrl(event.target.value)}
              placeholder="https://…"
              className="h-11 text-base"
            />
            <p className="text-xs text-muted-foreground">
              Find it in your maps app, share it, and paste the link here. Leave
              it empty and the place simply does not link anywhere.
            </p>
          </div>

          <CardPhoto
            houseId={houseId}
            houseName={houseName}
            photos={place.photos}
            placeId={place.id}
            label="A photograph, if you have one."
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
              what="place"
              disabled={pending}
              onDelete={() => run(() => deletePlace(place.id))}
            />
          </div>
        </div>
      ) : null}
    </li>
  );
}
