"use client";

/**
 * The whole guide, on one screen, split by **who reads it**.
 *
 * ### Two lists, never one list with a badge
 *
 * `ownerGuide()` hands back the two halves in separate arrays on purpose, and
 * this screen is the reason. The promise this product makes is that the door
 * code reaches a confirmed guest and nobody else, and the owner is the person
 * who keeps it — so the split has to be the largest thing on the screen, not a
 * chip on the right-hand edge of a row. Each half opens with a heading naming
 * the people who read it and a sentence saying where they read it.
 *
 * Places sit last and belong to neither half. There is no visibility column on
 * `places` and there should not be: a fish restaurant is a public fact about a
 * town. Anything private about one is a guests-only section.
 *
 * ### The category is a heading, not a label
 *
 * A row reading "Ali'nin Yeri · eat" is a database view. The six categories are
 * the headings the places are filed under — here and, in the guest's language,
 * on the house page — so the same six sentences do the organising in both
 * places and nothing has to carry a tag.
 *
 * ### Reordering is two arrows, not a drag
 *
 * Dragging a card on a phone fights the scroll it lives inside, and building
 * that well needs a library this product does not have. Two arrows inside the
 * opened card move it one place; `reorderSections` and `reorderPlaces` want the
 * **whole** list for that half with each id exactly once, so a move is a swap
 * computed against the full array and sent complete. Within a category group
 * the swap reaches past the places filed elsewhere, so moving a beach up never
 * disturbs where the restaurants sit.
 *
 * ### Where the draft tool goes
 *
 * At the top of an empty guide, because on day one it *is* the screen. At the
 * foot of a written one, because by then it is a tool you reach for twice a
 * year and the guide itself is what you came to read.
 */

import { useState } from "react";
import { PlusIcon } from "lucide-react";

import {
  createPlace,
  createSection,
  reorderPlaces,
  reorderSections,
} from "@/app/_actions/guide";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { GuideVisibility, PlaceCategory } from "@/db/schema";
import type { GuideSectionView, PlaceView } from "@/lib/guide";
import type { Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { CATEGORY_LABEL, CATEGORY_ORDER } from "./categories";
import { DraftTool } from "./draft-tool";
import { useGuideAction } from "./guide-parts";
import { PlaceCard } from "./place-card";
import { SectionCard } from "./section-card";

/* ============================================================
   ADDING ONE BY HAND
   ============================================================ */

/**
 * A section, written from scratch.
 *
 * The visibility is not asked for. The form lives inside one half of the guide
 * and creates into that half — a picker here would be a third way to say a
 * thing the heading two inches above has already said, and it would be the one
 * a tired person gets wrong.
 */
function AddSection({ visibility }: { visibility: GuideVisibility }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const { pending, run } = useGuideAction();

  function add() {
    run(
      () => createSection({ title, body, visibility }),
      () => {
        setTitle("");
        setBody("");
        setOpen(false);
      },
    );
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-12 w-full border-dashed text-base"
      >
        <PlusIcon className="size-5" aria-hidden="true" />
        Write a section
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`new-title-${visibility}`}>Title</Label>
        <Input
          id={`new-title-${visibility}`}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="A few words"
          className="h-11 text-base"
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`new-body-${visibility}`}>What it says</Label>
        <Textarea
          id={`new-body-${visibility}`}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={4}
          className="text-base"
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          onClick={add}
          disabled={pending || title.trim() === ""}
          className="h-11 flex-1"
        >
          Add it
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(false)}
          className="h-11 px-4"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A place, written from scratch. The map link is added later, in the card. */
function AddPlace() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<PlaceCategory>("eat");
  const [note, setNote] = useState("");
  const { pending, run } = useGuideAction();

  function add() {
    run(
      () =>
        createPlace({
          name,
          category,
          note: note.trim() === "" ? null : note,
        }),
      () => {
        setName("");
        setNote("");
        setOpen(false);
      },
    );
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        className="h-12 w-full border-dashed text-base"
      >
        <PlusIcon className="size-5" aria-hidden="true" />
        Add a place
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-place-name">Name</Label>
        <Input
          id="new-place-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="The way you would say it out loud"
          className="h-11 text-base"
          autoFocus
        />
      </div>

      <fieldset className="flex flex-col gap-1.5">
        <legend className="text-sm font-medium">Filed under</legend>
        <div className="flex flex-wrap gap-1.5">
          {CATEGORY_ORDER.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={category === option}
              onClick={() => setCategory(option)}
              className={cn(
                "flex min-h-11 items-center rounded-lg border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                category === option
                  ? "border-foreground bg-foreground font-medium text-background"
                  : "border-border text-muted-foreground",
              )}
            >
              {CATEGORY_LABEL[option]}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-place-note">Note</Label>
        <Textarea
          id="new-place-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          placeholder="One sentence, or nothing."
          className="text-base"
        />
      </div>

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={add}
          disabled={pending || name.trim() === ""}
          className="h-11 flex-1"
        >
          Add it
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen(false)}
          className="h-11 px-4"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

/* ============================================================
   ONE HALF OF THE GUIDE
   ============================================================ */

function Half({
  heading,
  explanation,
  emptyLine,
  sections,
  visibility,
  houseId,
  houseName,
}: {
  heading: string;
  explanation: string;
  emptyLine: string;
  sections: GuideSectionView[];
  visibility: GuideVisibility;
  houseId: string;
  houseName: string;
}) {
  const { run } = useGuideAction();

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= sections.length) return;
    // The complete list for this half, each id once — what the action requires.
    const ids = sections.map((section) => section.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    run(() => reorderSections(visibility, ids));
  }

  return (
    <section className="flex flex-col gap-4">
      <header className="flex flex-col gap-1.5">
        <h2 className="text-lg">{heading}</h2>
        <p className="text-sm text-muted-foreground">{explanation}</p>
      </header>

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLine}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {sections.map((section, index) => (
            <SectionCard
              key={section.id}
              section={section}
              houseId={houseId}
              houseName={houseName}
              first={index === 0}
              last={index === sections.length - 1}
              onMove={(direction) => move(index, direction)}
            />
          ))}
        </ul>
      )}

      <AddSection visibility={visibility} />
    </section>
  );
}

/* ============================================================
   THE SCREEN
   ============================================================ */

export function GuideEditor({
  houseId,
  houseName,
  language,
  prompt,
  publicSections,
  guestsSections,
  places,
}: {
  houseId: string;
  houseName: string;
  language: Lang;
  prompt: string;
  publicSections: GuideSectionView[];
  guestsSections: GuideSectionView[];
  places: PlaceView[];
}) {
  const { run } = useGuideAction();

  /**
   * True while a pasted draft is on screen.
   *
   * The draft is long — six sections and eight places is a normal reply — and
   * reading it with the finished guide scrolling underneath is two documents at
   * once, with the save button somewhere in the middle of them. So while a
   * draft is up it is the whole screen, and the sentence above the button says
   * in numbers what is already there.
   */
  const [reviewing, setReviewing] = useState(false);

  const empty =
    publicSections.length === 0 &&
    guestsSections.length === 0 &&
    places.length === 0;

  /**
   * Move a place one row inside its own group.
   *
   * The stored order is one flat list — grouping is a rendering decision — so
   * the neighbour to swap with is the next place *of the same category*,
   * however many others sit between them. Everything else keeps its position,
   * which is what stops moving a beach reshuffling the restaurants.
   */
  function movePlace(index: number, direction: -1 | 1) {
    const category = places[index].category;
    let target = index + direction;
    while (
      target >= 0 &&
      target < places.length &&
      places[target].category !== category
    ) {
      target += direction;
    }
    if (target < 0 || target >= places.length) return;

    const ids = places.map((place) => place.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    run(() => reorderPlaces(ids));
  }

  const tool = (
    <DraftTool
      prompt={prompt}
      language={language}
      sectionCount={publicSections.length + guestsSections.length}
      placeCount={places.length}
      onReviewingChange={setReviewing}
    />
  );

  // `tool` keeps the same slot in both states — first on an empty guide, last
  // on a written one — whichever of them is showing. Moving it between slots
  // would be a different position in the child list, which React reconciles by
  // unmounting it, which would throw away the draft it is holding.
  return (
    <div className="flex flex-col gap-10">
      {empty ? tool : null}

      {reviewing ? null : (
        <>
          <Half
            heading="Anyone with the link"
            explanation="On the house page, under the calendar. This is what helps someone decide when to come."
            emptyLine="Nothing here yet, so your link says nothing about the town."
            sections={publicSections}
            visibility="public"
            houseId={houseId}
            houseName={houseName}
          />

          <Half
            heading="Only the people you said yes to"
            explanation="The address, the key, the wifi, the tap that has to be turned the other way. It reaches nobody until their week is confirmed."
            emptyLine="Nothing here yet. Until there is, a confirmed guest is told how to get in by email instead."
            sections={guestsSections}
            visibility="guests"
            houseId={houseId}
            houseName={houseName}
          />

          {/* Places ------------------------------------------------------------- */}
          <section className="flex flex-col gap-4">
            <header className="flex flex-col gap-1.5">
              <h2 className="text-lg">Places you would send them to</h2>
              <p className="text-sm text-muted-foreground">
                Everyone with the link sees these, under the same headings you
                file them under here.
              </p>
            </header>

            {places.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing here yet — somewhere to eat and a beach is enough to
                start.
              </p>
            ) : (
              <div className="flex flex-col gap-6">
                {CATEGORY_ORDER.map((category) => {
                  // Indices into the flat list, which is what a move works against.
                  const group = places
                    .map((place, index) => ({ place, index }))
                    .filter(({ place }) => place.category === category);
                  if (group.length === 0) return null;

                  return (
                    <div key={category} className="flex flex-col gap-3">
                      <h3 className="font-sans text-xs font-medium text-muted-foreground">
                        {CATEGORY_LABEL[category]}
                      </h3>
                      <ul className="flex flex-col gap-3">
                        {group.map(({ place, index }, within) => (
                          <PlaceCard
                            key={place.id}
                            place={place}
                            houseId={houseId}
                            houseName={houseName}
                            first={within === 0}
                            last={within === group.length - 1}
                            onMove={(direction) => movePlace(index, direction)}
                          />
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}

            <AddPlace />
          </section>
        </>
      )}

      {empty ? null : tool}
    </div>
  );
}
