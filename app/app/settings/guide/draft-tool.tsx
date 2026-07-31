"use client";

/**
 * The prompt, and the reply coming back.
 *
 * ### This app never calls a model, and that is the feature
 *
 * The owner already pays for ChatGPT or Claude. Handing them one block of text
 * to paste into a window they have open costs this product nothing, needs no
 * API key, and — the part that matters — lets them read the exact words being
 * sent on their behalf. There is no AI SDK in this repo and there must never be
 * one; see the head of `lib/guide-prompt.ts` and DECISIONS.md.
 *
 * So the loop is entirely in this file: copy → paste it elsewhere → paste the
 * reply back → {@link parseGuideReply} makes a draft → the owner edits it →
 * they save it. Nothing publishes itself, and the button that writes to the
 * database is at the bottom of a draft they have already read.
 *
 * ### Three things the logic author asked for, in the markup
 *
 * 1. **Nothing is silently dropped.** When the parser cannot fit a run of text
 *    into a shape it keeps it verbatim as the last section. That section is
 *    pointed at here, by name, with a sentence saying what happened — otherwise
 *    the owner meets a card called "The rest of the reply" and assumes
 *    something broke.
 * 2. **An unknown visibility lands on guests.** Every section in the draft
 *    therefore carries a two-way control set before the eye reaches the save
 *    button, so moving one to public is a tap and not a hunt.
 * 3. **`saveGuideDraft` appends.** It never replaces. A second paste leaves two
 *    of everything, so that is said in words directly above the button, with
 *    the owner's own counts in it — not in a help page they will not read.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, ClipboardIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { saveGuideDraft } from "@/app/_actions/guide";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { GuideVisibility, PlaceCategory } from "@/db/schema";
import { parseGuideReply } from "@/lib/guide-parse";
import type { Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

import { CATEGORY_LABEL, CATEGORY_ORDER } from "./categories";
import { copyText } from "./copy-text";
import { useGuideAction } from "./guide-parts";

/** How long the button says "Copied" before it goes back to offering. */
const FEEDBACK_MS = 2000;

/* ============================================================
   THE DRAFT, WHILE IT IS BEING EDITED
   ============================================================ */

/**
 * A local key per row. The draft has no ids — nothing is in the database yet —
 * and an array index would make React reuse a card's DOM when the one above it
 * is removed, which moves what you typed up a row.
 */
let nextKey = 0;
const rowKey = () => `draft-${(nextKey += 1)}`;

type SectionRow = {
  key: string;
  title: string;
  body: string;
  visibility: GuideVisibility;
  /** True for the one section that is the parser's leftover, if there is one. */
  leftover: boolean;
};

type PlaceRow = {
  key: string;
  name: string;
  category: PlaceCategory;
  note: string;
  /** Only editable when the reply actually carried one — the prompt asks for none. */
  mapUrl: string | null;
};

type Draft = { sections: SectionRow[]; places: PlaceRow[]; leftover: boolean };

/* ============================================================
   WHO READS IT
   ============================================================ */

/**
 * Two words, one filled.
 *
 * The palette has no accent hue, so "chosen" is said the way the owner's tab
 * bar says it: a fill against a hollow. It survives greyscale, sunlight and a
 * glance, and it is the same semantic the rest of the product already uses.
 */
function WhoReads({
  value,
  onChange,
}: {
  value: GuideVisibility;
  onChange: (next: GuideVisibility) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-border p-0.5">
      {(["public", "guests"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className={cn(
            "h-11 flex-1 rounded-md text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
            value === option
              ? "bg-foreground font-medium text-background"
              : "text-muted-foreground",
          )}
        >
          {option === "public" ? "Everyone" : "Only guests"}
        </button>
      ))}
    </div>
  );
}

/* ============================================================
   THE TOOL
   ============================================================ */

export function DraftTool({
  prompt,
  language,
  sectionCount,
  placeCount,
  onReviewingChange,
}: {
  /** `buildGuidePrompt(house)`, built on the server. */
  prompt: string;
  /** The house's language — the leftover section is titled in it. */
  language: Lang;
  /** What the guide already holds, so the append warning can say it out loud. */
  sectionCount: number;
  placeCount: number;
  /**
   * Told when the draft appears and when it goes.
   *
   * The screen behind this is the guide itself, and reading twenty cards of a
   * draft with the finished article scrolling underneath them is two documents
   * at once. The parent clears itself while a draft is up; this is the only
   * thing that knows when that is.
   */
  onReviewingChange?: (reviewing: boolean) => void;
}) {
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const [reply, setReply] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const { pending, run } = useGuideAction();

  const empty = sectionCount === 0 && placeCount === 0;

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(async () => {
    const ok = await copyText(prompt);
    setCopied(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    // A failure keeps its message: the sentence asks the owner to do something,
    // and two seconds is not long enough to read it and then act on it.
    if (ok) timer.current = setTimeout(() => setCopied("idle"), FEEDBACK_MS);
  }, [prompt]);

  // The clipboard refused, so the words go on the screen instead, already
  // selected, and a long-press or a Ctrl-C takes them.
  useEffect(() => {
    if (copied !== "failed") return;
    const area = promptRef.current;
    if (!area) return;
    area.focus();
    area.select();
  }, [copied]);

  /** The one place the draft appears or goes, so the parent always hears about it. */
  function showDraft(next: Draft | null) {
    setDraft(next);
    onReviewingChange?.(next !== null);
    // The guide above has just been taken down or put back, so the page is a
    // different length than the scroll position was measured against.
    window.scrollTo({ top: 0 });
  }

  function read() {
    if (reply.trim() === "") {
      toast.error("Paste the reply first, then this turns it into a draft.");
      return;
    }

    const parsed = parseGuideReply(reply, { lang: language });

    showDraft({
      sections: parsed.sections.map((section, index) => ({
        key: rowKey(),
        title: section.title,
        body: section.body,
        visibility: section.visibility,
        // The leftover is always the last section the parser appended.
        leftover:
          parsed.leftover !== null && index === parsed.sections.length - 1,
      })),
      places: parsed.places.map((place) => ({
        key: rowKey(),
        name: place.name,
        category: place.category,
        note: place.note ?? "",
        mapUrl: place.mapUrl,
      })),
      leftover: parsed.leftover !== null,
    });
  }

  function save() {
    if (!draft) return;

    const blank = draft.sections.some((section) => section.title.trim() === "");
    if (blank) {
      toast.error("Every section needs a title. Give it one, or remove it.");
      return;
    }

    run(
      () =>
        saveGuideDraft({
          sections: draft.sections.map((section) => ({
            title: section.title,
            body: section.body,
            visibility: section.visibility,
          })),
          places: draft.places.map((place) => ({
            name: place.name,
            category: place.category,
            note: place.note.trim() === "" ? null : place.note,
            mapUrl: place.mapUrl,
          })),
        }),
      () => {
        showDraft(null);
        setReply("");
        toast.success(
          "It is in your guide. Read it through and change what you want.",
        );
      },
    );
  }

  function patchSection(key: string, patch: Partial<SectionRow>) {
    setDraft((current) =>
      current === null
        ? null
        : {
            ...current,
            sections: current.sections.map((section) =>
              section.key === key ? { ...section, ...patch } : section,
            ),
          },
    );
  }

  function patchPlace(key: string, patch: Partial<PlaceRow>) {
    setDraft((current) =>
      current === null
        ? null
        : {
            ...current,
            places: current.places.map((place) =>
              place.key === key ? { ...place, ...patch } : place,
            ),
          },
    );
  }

  /* --- Reviewing --------------------------------------------------------- */

  if (draft) {
    const willBeSections = sectionCount + draft.sections.length;
    const willBePlaces = placeCount + draft.places.length;

    return (
      <section className="flex flex-col gap-5 rounded-xl border border-border bg-card p-4">
        <header className="flex flex-col gap-2">
          <h2 className="text-lg">Read it before it is yours</h2>
          <p className="text-sm text-muted-foreground">
            None of this is saved yet. Change any of it, remove what you do not
            want, and decide who reads what.
          </p>
        </header>

        {/* The parser's promise, said out loud ------------------------------- */}
        {draft.leftover ? (
          <p className="rounded-lg border border-dashed border-foreground/40 px-3 py-2 text-sm">
            Some of that reply did not come back in the shape it was asked for.
            None of it was thrown away — it is all in the last section below,
            word for word. Keep what is useful and delete the rest.
          </p>
        ) : null}

        {/* Sections ---------------------------------------------------------- */}
        {draft.sections.length > 0 ? (
          <ul className="flex flex-col gap-5">
            {draft.sections.map((section) => (
              <li
                key={section.key}
                className={cn(
                  "flex flex-col gap-2.5 rounded-lg border p-3",
                  section.leftover
                    ? "border-dashed border-foreground/40"
                    : "border-border",
                )}
              >
                <div className="flex items-start gap-2">
                  <Input
                    value={section.title}
                    aria-label="Section title"
                    onChange={(event) =>
                      patchSection(section.key, { title: event.target.value })
                    }
                    className="h-11 flex-1 text-base"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    aria-label={`Remove ${section.title || "this section"}`}
                    onClick={() =>
                      setDraft((current) =>
                        current === null
                          ? null
                          : {
                              ...current,
                              sections: current.sections.filter(
                                (row) => row.key !== section.key,
                              ),
                            },
                      )
                    }
                    className="size-11 shrink-0"
                  >
                    <XIcon className="size-5" aria-hidden="true" />
                  </Button>
                </div>

                <Textarea
                  value={section.body}
                  aria-label="What it says"
                  onChange={(event) =>
                    patchSection(section.key, { body: event.target.value })
                  }
                  rows={3}
                  className="text-base"
                />

                <WhoReads
                  value={section.visibility}
                  onChange={(visibility) =>
                    patchSection(section.key, { visibility })
                  }
                />
              </li>
            ))}
          </ul>
        ) : null}

        {/* Places ------------------------------------------------------------ */}
        {draft.places.length > 0 ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-base font-medium">
              Places, which everyone with the link sees
            </h3>
            <ul className="flex flex-col gap-4">
              {draft.places.map((place) => (
                <li
                  key={place.key}
                  className="flex flex-col gap-2.5 rounded-lg border border-border p-3"
                >
                  <div className="flex items-start gap-2">
                    <Input
                      value={place.name}
                      aria-label="Place name"
                      onChange={(event) =>
                        patchPlace(place.key, { name: event.target.value })
                      }
                      className="h-11 flex-1 text-base"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Remove ${place.name || "this place"}`}
                      onClick={() =>
                        setDraft((current) =>
                          current === null
                            ? null
                            : {
                                ...current,
                                places: current.places.filter(
                                  (row) => row.key !== place.key,
                                ),
                              },
                        )
                      }
                      className="size-11 shrink-0"
                    >
                      <XIcon className="size-5" aria-hidden="true" />
                    </Button>
                  </div>

                  <Input
                    value={place.note}
                    aria-label="Note"
                    placeholder="One sentence, or nothing."
                    onChange={(event) =>
                      patchPlace(place.key, { note: event.target.value })
                    }
                    className="h-11 text-base"
                  />

                  {/* The prompt asks the model to leave MAP empty, so this only
                      appears when one came back anyway — an empty field on
                      every place would be eight blanks nobody was asked for. */}
                  {place.mapUrl !== null ? (
                    <Input
                      value={place.mapUrl}
                      aria-label="Map link"
                      onChange={(event) =>
                        patchPlace(place.key, { mapUrl: event.target.value })
                      }
                      className="h-11 text-base"
                    />
                  ) : null}

                  {/* A row of six words rather than a select: the category is
                      the heading this place will sit under, and on a draft the
                      owner is skimming, seeing the six at once is faster than
                      opening a menu to find out what they are. */}
                  <div className="flex flex-wrap gap-1.5">
                    {CATEGORY_ORDER.map((option) => (
                      <button
                        key={option}
                        type="button"
                        aria-pressed={place.category === option}
                        onClick={() => patchPlace(place.key, { category: option })}
                        className={cn(
                          "flex min-h-11 items-center rounded-lg border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                          place.category === option
                            ? "border-foreground bg-foreground font-medium text-background"
                            : "border-border text-muted-foreground",
                        )}
                      >
                        {CATEGORY_LABEL[option]}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* What saving does, before the button that does it ------------------- */}
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <p className="rounded-lg border border-dashed border-foreground/40 px-3 py-2.5 text-sm">
            {empty ? (
              <>
                Saving writes {draft.sections.length}{" "}
                {draft.sections.length === 1 ? "section" : "sections"} and{" "}
                {draft.places.length}{" "}
                {draft.places.length === 1 ? "place" : "places"} into your guide.
                Until then none of it exists.
              </>
            ) : (
              <>
                This is <strong className="font-medium">added</strong> to what
                you have already written — nothing of yours is changed or
                removed. You have {sectionCount}{" "}
                {sectionCount === 1 ? "section" : "sections"} and {placeCount}{" "}
                {placeCount === 1 ? "place" : "places"}; afterwards you would
                have {willBeSections} and {willBePlaces}. Bring a second reply
                back and you end up with two of everything.
              </>
            )}
          </p>

          <div className="flex gap-2">
            <Button
              type="button"
              onClick={save}
              disabled={pending}
              className="h-12 flex-1 text-base"
            >
              {pending ? "Saving…" : "Save it to the guide"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => showDraft(null)}
              disabled={pending}
              className="h-12 px-4 text-base"
            >
              Back
            </Button>
          </div>
        </div>
      </section>
    );
  }

  /* --- At rest ------------------------------------------------------------ */

  return (
    <section className="flex flex-col gap-4 rounded-xl border border-dashed border-border p-4">
      <header className="flex flex-col gap-2">
        <h2 className="text-lg">
          {empty ? "Start it somewhere else" : "Add to it from a first draft"}
        </h2>
        <p className="text-sm text-muted-foreground">
          Copy the prompt, paste it into ChatGPT or Claude, and bring the reply
          back here.
        </p>
        <p className="text-sm text-muted-foreground">
          It knows the name of the house, the town and the season, and it is
          told to leave the wifi and the boiler to you.
        </p>
        {/* Said here as well as over the save button. By the time somebody is
            reading a draft they have already spent two minutes waiting for it,
            and "this adds, it does not replace" is worth knowing before the
            prompt is even copied. */}
        {empty ? null : (
          <p className="text-sm text-muted-foreground">
            Whatever comes back is added to what you have written, never in
            place of it.
          </p>
        )}
      </header>

      <Button
        type="button"
        onClick={copy}
        variant={empty ? "default" : "outline"}
        className="h-12 w-full text-base"
      >
        {copied === "copied" ? (
          <>
            <CheckIcon className="size-5" aria-hidden="true" />
            Copied
          </>
        ) : (
          <>
            <ClipboardIcon className="size-5" aria-hidden="true" />
            Copy the prompt
          </>
        )}
      </Button>

      {/* The words under the thumb that asked for them, and the same words for
          a screen reader. A toast lands at the edge of the screen on somebody
          else's schedule. */}
      <p aria-live="polite" className="sr-only">
        {copied === "copied" ? "The prompt is on your clipboard." : ""}
      </p>

      {copied === "failed" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-destructive">
            This browser would not let the page copy for you. The prompt is
            below and already selected — copy it by hand.
          </p>
          <Textarea
            ref={promptRef}
            readOnly
            value={prompt}
            aria-label="The prompt"
            rows={6}
            className="max-h-64 text-sm"
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-2 border-t border-border pt-4">
        <Label htmlFor="guide-reply">Paste the reply here</Label>
        <Textarea
          id="guide-reply"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          rows={4}
          placeholder="Everything it wrote back, markers and all."
          className="max-h-72 text-base"
        />
        <Button
          type="button"
          variant="outline"
          onClick={read}
          className="h-12 w-full text-base"
        >
          Turn it into a draft
        </Button>
        <p className="text-sm text-muted-foreground">
          You read the draft and change it here. Nothing is saved until you say
          so.
        </p>
      </div>
    </section>
  );
}
