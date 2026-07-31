"use client";

/**
 * The two answers to one ask.
 *
 * They live in one component because they are one decision, and because both of
 * them have to be able to disable the other while a tap is in flight. Splitting
 * them would mean lifting `busy` into a third component that exists only to
 * hold it.
 *
 * ### Yes is a wall. No is a line of text.
 *
 * These used to sit side by side, equal height, near-equal width, eight pixels
 * apart, under a thumb. That is a mis-tap that cancels a cousin's holiday. So
 * **Say yes** is the full width of the card and **Not that week** is a plain
 * 44px line beneath it: the same target, a fraction of the weight. Quiet is not
 * hidden — a host who has to hunt for "no" ends up saying yes to be polite,
 * which is the opposite of what this is for.
 *
 * The words matter as much as the layout. Nobody approves their cousin, and a
 * house is not declined — it is "not that week, come in September". The
 * hospitality-industry verbs are what made this feel like software for managing
 * strangers.
 *
 * ### The clash is not a surprise
 *
 * When a confirmed stay already covers these nights, `taken` is true, the yes is
 * **not rendered**, and the card says so above the row. That state is computed
 * on the server in `app/app/page.tsx` from `rangesOverlap`, so a host sees it
 * before they choose rather than after they tap.
 *
 * A tap can still lose the race — two tabs, two owners, or a block created a
 * second ago — and that is exactly what
 * {@link import("@/app/_actions/decision").approveBooking} turns into "Those
 * dates were taken while you were deciding." That message lands on this card,
 * and `router.refresh()` runs on **every** outcome, so the next paint shows the
 * house as it really is: this card loses its yes and the winning ask has moved
 * down to who is coming.
 *
 * ### The reason goes to a person
 *
 * The sheet says whose inbox it lands in and that it is copied word for word,
 * because a note written for yourself reads very differently when the person it
 * is about reads it.
 */

import { useCallback, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { XIcon } from "lucide-react";
import { toast } from "sonner";

import { approveBooking, declineBooking } from "@/app/_actions/decision";
import type { DecisionResult } from "@/app/_actions/decision";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

/** Matches `reasonSchema` in `app/_actions/decision.ts`. */
const REASON_LIMIT = 300;

export type RequestActionsProps = {
  bookingId: string;
  /** Who asked, already resolved — the sheet names the person who reads this. */
  guestName: string;
  /**
   * A confirmed stay or an owner block already covers these nights, so this one
   * cannot be approved. Computed on the server; the constraint is the authority.
   */
  taken: boolean;
};

export function RequestActions({ bookingId, guestName, taken }: RequestActionsProps) {
  const router = useRouter();
  const reasonId = useId();

  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, startDecision] = useTransition();

  // *Which* answer is in flight, not just that one is. One transition serves
  // both buttons, so without this the approve button would read "Approving…"
  // while a decline was saving.
  const [inFlight, setInFlight] = useState<"approval" | "decline" | null>(null);

  // Held past the transition's own flag. On success the server sends back a page
  // without this card; until it arrives the buttons must stay down rather than
  // springing back and inviting a second tap at the worst possible moment.
  const [settled, setSettled] = useState(false);
  const busy = working || settled;

  const run = useCallback(
    (
      label: "approval" | "decline",
      decide: () => Promise<DecisionResult>,
      done: () => void,
    ) => {
      setError(null);
      setInFlight(label);
      startDecision(async () => {
        try {
          const result = await decide();
          if (result.ok) {
            setSettled(true);
            done();
          } else {
            setError(result.error);
          }
        } catch (thrown) {
          console.error(`[RequestActions] ${label} failed`, thrown);
          setError("That did not go through. Try again in a moment.");
        }
        setInFlight(null);
        // Every outcome, refusals included. A card that just lost a race is a
        // card showing dates that are no longer what it says they are.
        router.refresh();
      });
    },
    [router],
  );

  function approve() {
    run(
      "approval",
      () => approveBooking(bookingId),
      () => toast.success(`The house is ${guestName}'s that week.`),
    );
  }

  function decline() {
    run(
      "decline",
      () => declineBooking(bookingId, reason),
      () => {
        setOpen(false);
        toast.success(`${guestName} has your answer.`);
      },
    );
  }

  const notice = error ?? (taken ? "Somebody else has those nights now." : null);

  return (
    <div className="flex w-full flex-col gap-1">
      {notice ? (
        <p
          role={error ? "alert" : undefined}
          className={
            error ? "mb-2 text-sm text-destructive" : "mb-2 text-sm text-muted-foreground"
          }
        >
          {notice}
        </p>
      ) : null}

      {taken ? null : (
        <Button
          type="button"
          onClick={approve}
          disabled={busy}
          className="h-12 w-full text-base"
        >
          {inFlight === "approval" ? "Saying yes…" : "Say yes"}
        </Button>
      )}

      {/* Same 44px target, a fraction of the visual weight — no border, no
          fill, nothing that reads as a twin of the button above it. Unless the
          nights are gone and this is the only thing left to do, in which case
          it stops whispering and becomes the button. */}
      <Button
        type="button"
        variant={taken ? "outline" : "ghost"}
        onClick={() => {
          // A message about the yes that just lost a race has no business
          // sitting above this. The card keeps the durable half of it —
          // `taken` — the moment this clears.
          setError(null);
          setOpen(true);
        }}
        disabled={busy}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={
          taken
            ? "h-12 w-full text-base"
            : "h-11 w-full text-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
        }
      >
        Not that week
      </Button>

      {/* The other answer --------------------------------------------------- */}
      <Sheet
        open={open}
        onOpenChange={(next) => {
          // Nothing closes mid-write: the answer is already on its way and the
          // sheet is where its error message is going to land.
          if (!busy) setOpen(next);
        }}
      >
        <SheetContent
          side="bottom"
          // shadcn's own close control is a 28px target and lives in a file this
          // slice does not own. Ours is in the header, at 44.
          showCloseButton={false}
          className="max-h-[92svh] gap-0 overflow-y-auto rounded-t-xl p-0"
        >
          <SheetHeader className="flex-row items-start justify-between gap-2 px-4 pt-4 pb-2">
            <div className="flex flex-col gap-1">
              <SheetTitle className="text-lg">Not that week</SheetTitle>
              <SheetDescription className="text-sm">
                {guestName} gets an email. What you write goes to them word for
                word.
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label="Close"
                className="size-11 shrink-0 p-0"
              >
                <XIcon className="size-5" aria-hidden="true" />
              </Button>
            </SheetClose>
          </SheetHeader>

          <div className="flex flex-col gap-2 px-4 pb-4">
            <Label htmlFor={reasonId} className="text-sm">
              What to tell them
            </Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setError(null);
              }}
              placeholder="Selin has that week — come in September, the water is warmer."
              maxLength={REASON_LIMIT}
              rows={3}
              disabled={busy}
              aria-describedby={`${reasonId}-hint`}
              className="min-h-24 text-base"
            />
            <p id={`${reasonId}-hint`} className="text-sm text-muted-foreground">
              Optional. Without it the email carries the dates and nothing else.
            </p>
          </div>

          <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-popover px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {/* Ink, not --destructive. Red is for a refusal the product is
                sorry about; telling a cousin to come in September is not one,
                and this is the sheet's only action either way. */}
            <Button
              type="button"
              onClick={decline}
              disabled={busy}
              className="h-12 w-full text-base"
            >
              {inFlight === "decline" ? "Sending…" : "Send it"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
