"use client";

/**
 * Approve and decline, on one pending request.
 *
 * The two live in one component because they are one decision with two answers,
 * and because both of them have to be able to disable the other while a tap is
 * in flight. Splitting them would mean lifting `busy` into a third component
 * that exists only to hold it.
 *
 * ### Approve is the primary action on this screen
 *
 * It carries the one accent; decline is an outline button next to it, the same
 * height and roughly the same width. Quiet, not hidden — an owner who has to
 * hunt for "no" ends up saying yes to be polite, which is the opposite of what
 * the product is for.
 *
 * ### The clash is not a surprise
 *
 * When a confirmed stay already covers these nights, `taken` is true, the
 * approve button is **not rendered**, and the card says so above the row. That
 * state is computed on the server in `app/app/page.tsx` from `rangesOverlap`, so
 * an owner sees it before they choose rather than after they tap.
 *
 * A tap can still lose the race — two tabs, two owners, or a block created a
 * second ago — and that is exactly what
 * {@link import("@/app/_actions/decision").approveBooking} turns into "Those
 * dates were taken while you were deciding." That message lands on this card,
 * and `router.refresh()` runs on **every** outcome, so the next paint shows the
 * calendar as it really is: this card loses its approve button and the winning
 * request has moved to upcoming stays.
 *
 * ### The reason goes to a person
 *
 * The decline sheet says whose inbox it lands in and that it is copied word for
 * word, because a reason written for a private note reads very differently when
 * the guest reads it. "Decline" is the word on the trigger, on the sheet, and on
 * the button that commits — it never becomes "reject" or "say no" on the way.
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
          setError(`The ${label} did not go through. Try again in a moment.`);
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
      () => toast.success(`Approved. ${guestName} has the confirmation.`),
    );
  }

  function decline() {
    run(
      "decline",
      () => declineBooking(bookingId, reason),
      () => {
        setOpen(false);
        toast.success(`Declined. ${guestName} has your answer.`);
      },
    );
  }

  const notice = error ?? (taken ? "A confirmed stay covers these nights." : null);

  return (
    <div className="flex w-full flex-col gap-2">
      {notice ? (
        <p
          role={error ? "alert" : undefined}
          className={error ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
        >
          {notice}
        </p>
      ) : null}

      <div className="flex gap-2">
        {taken ? null : (
          <Button
            type="button"
            onClick={approve}
            disabled={busy}
            className="h-11 flex-1 text-base"
          >
            {inFlight === "approval" ? "Approving…" : "Approve"}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            // A message about the approval that just lost a race has no business
            // sitting above a decline button. The card keeps the durable half of
            // it — `taken` — the moment this clears.
            setError(null);
            setOpen(true);
          }}
          disabled={busy}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={taken ? "h-11 w-full text-base" : "h-11 flex-1 text-base"}
        >
          Decline
        </Button>
      </div>

      {/* Decline sheet ------------------------------------------------------ */}
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
            <div className="flex flex-col gap-0.5">
              <SheetTitle>Decline</SheetTitle>
              <SheetDescription>
                {guestName} gets an email with your answer. Whatever you write here
                goes to them word for word.
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
            <Label htmlFor={reasonId}>Reason</Label>
            <Textarea
              id={reasonId}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
                setError(null);
              }}
              placeholder="The house is full that week — try the week after."
              maxLength={REASON_LIMIT}
              rows={3}
              disabled={busy}
              aria-describedby={`${reasonId}-hint`}
              className="min-h-24 text-base"
            />
            <p id={`${reasonId}-hint`} className="text-xs text-muted-foreground">
              Optional. Leave it empty and the email carries the dates and nothing
              else.
            </p>
          </div>

          <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-popover px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              onClick={decline}
              disabled={busy}
              className="h-11 w-full text-base"
            >
              {inFlight === "decline" ? "Declining…" : "Decline"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
