"use client";

/**
 * The owner keeping dates for themselves — and giving them back.
 *
 * Both halves live here because they are one idea from two directions, and
 * because "unblock" only ever undoes what "block" made.
 *
 * ### It is the guest's calendar, reused exactly
 *
 * {@link StayCalendar} is already built, already localised, and already
 * understands that one cell is one night and check-out is the morning after the
 * last one. Writing a second date picker for the owner would mean two places
 * where the half-open `[start, end)` convention could drift apart from the
 * `daterange(start_date, end_date, '[)')` the database enforces. So the owner
 * gets the guest's grid, with three differences the page computes for it:
 *
 * - **No gap padding.** `gapDays` is a rule about strangers arriving on each
 *   other's heels. The owner may block the day after a stay ends.
 * - **No season window.** Roof repairs happen in February. The season bounds a
 *   guest's request, not the owner's own use of their house.
 * - **Pending nights stay tappable.** A block outranks a request nobody has
 *   answered; blocking over one is how an owner says "actually, no" to a week
 *   without answering each request in it. The dashboard then shows that request
 *   as taken, with only decline left on it.
 *
 * ### The refusal comes from the constraint, not from a pre-check
 *
 * The grid will not let a selection span a night that is already held, which
 * covers the honest mistake. The dishonest one — a second tab, a guest approved
 * a second ago — is `bookings_no_overlap` refusing the insert, and
 * {@link import("@/app/_actions/decision").blockDates} turns that into "Those
 * dates are already taken." on the sheet. `router.refresh()` runs on every
 * outcome so the grid repaints with whatever is actually true.
 */

import { useCallback, useEffect, useId, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { XIcon } from "lucide-react";
import { toast } from "sonner";

import { blockDates, unblockDates } from "@/app/_actions/decision";
import { StayCalendar, type StayRange } from "@/components/stay-calendar";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { formatDay, nightsBetween, type DateStr } from "@/lib/dates";

/** Matches `noteSchema` in `app/_actions/decision.ts`. */
const NOTE_LIMIT = 300;

function nightWord(n: number) {
  return n === 1 ? "1 night" : `${n} nights`;
}

/* ============================================================
   BLOCK
   ============================================================ */

export type BlockDatesProps = {
  /** The server's day. The grid starts here — the owner cannot block the past. */
  today: DateStr;
  /**
   * Nights a confirmed stay or an existing block already holds. Arrays in, a
   * Set here: the payload stays small and the component wants membership.
   */
  takenDates: readonly DateStr[];
  /** Nights somebody has asked for. Drawn dashed, and still tappable. */
  pendingDates: readonly DateStr[];
};

export function BlockDates({ today, takenDates, pendingDates }: BlockDatesProps) {
  const router = useRouter();
  const noteId = useId();

  const taken = useMemo(() => new Set(takenDates), [takenDates]);
  const pendingNights = useMemo(() => new Set(pendingDates), [pendingDates]);

  const [open, setOpen] = useState(false);
  const [range, setRange] = useState<StayRange | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [working, startBlock] = useTransition();

  const nights = range?.end != null ? nightsBetween(range.start, range.end) : 0;
  const ready = nights > 0;

  const reset = useCallback(() => {
    setRange(null);
    setNote("");
    setError(null);
  }, []);

  function submit() {
    if (!range || range.end == null) return;
    const { start, end } = range;

    setError(null);
    startBlock(async () => {
      try {
        const result = await blockDates(start, end, note);
        if (result.ok) {
          setOpen(false);
          reset();
          toast.success("Dates blocked.");
        } else {
          setError(result.error);
        }
      } catch (thrown) {
        console.error("[BlockDates] block failed", thrown);
        setError("The block did not go through. Try again in a moment.");
      }
      router.refresh();
    });
  }

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        // Not while the insert is in flight — the sheet is where its answer goes.
        if (working) return;
        setOpen(next);
        // A half-picked range left behind would reopen as a selection the owner
        // has no memory of making.
        if (!next) reset();
      }}
    >
      {/* Housekeeping, and it should look like it. As a full-width outlined
          button it was the same rectangle as "Share the house" sitting eight
          pixels above it, and a host scanning the foot of the page found two
          equals where one of them is the reason the product exists. So it drops
          to the weight of "Unblock" in the same section — same 44px target,
          none of the furniture — and aligns with the section's own heading. */}
      <SheetTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          className="-ml-3 h-11 self-start px-3 text-base font-normal text-muted-foreground"
        >
          Block dates
        </Button>
      </SheetTrigger>

      <SheetContent
        side="bottom"
        // shadcn's own close control is a 28px target and lives in a file this
        // slice does not own. Ours is in the header, at 44.
        showCloseButton={false}
        className="max-h-[92svh] gap-0 overflow-y-auto rounded-t-xl p-0"
      >
        <SheetHeader className="flex-row items-start justify-between gap-2 px-4 pt-4 pb-2">
          <div className="flex flex-col gap-0.5">
            <SheetTitle>Block dates</SheetTitle>
            <SheetDescription>
              Nobody can request these nights while they are blocked. Tap the night
              you arrive, then the last night you stay.
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

        <div className="flex flex-col gap-4 px-4 pb-4">
          <StayCalendar
            disabledDates={taken}
            pendingDates={pendingNights}
            min={today}
            // No season bound: the owner's own use of the house is not a request.
            max={null}
            value={range}
            onChange={(next) => {
              setRange(next);
              setError(null);
            }}
            // The dashboard is English in v1, whatever language the guests read.
            language="en"
          />

          <div className="flex flex-col gap-2">
            <Label htmlFor={noteId}>Note</Label>
            <Textarea
              id={noteId}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setError(null);
              }}
              placeholder="Roof repair."
              maxLength={NOTE_LIMIT}
              rows={2}
              disabled={working}
              aria-describedby={`${noteId}-hint`}
              className="min-h-16 text-base"
            />
            <p id={`${noteId}-hint`} className="text-xs text-muted-foreground">
              Optional, and only you ever read it.
            </p>
          </div>
        </div>

        <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-popover px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <p className="num text-xs text-muted-foreground">
            {ready && range?.end != null
              ? `${nightWord(nights)} · ${formatDay(range.start)} – ${formatDay(range.end)}`
              : "Pick the nights to hold."}
          </p>
          <Button
            type="button"
            onClick={submit}
            disabled={working || !ready}
            className="h-11 w-full text-base"
          >
            {working ? "Blocking…" : "Block dates"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/* ============================================================
   UNBLOCK
   ============================================================ */

/**
 * Give the dates back, in two taps that are not in the same place.
 *
 * One tap would be enough for the owner — they can always block again — but the
 * dates go back on the public calendar the moment this lands, and a mis-tap in a
 * list of stays should not be what opens a week to requests. The safe button
 * sits on the left, under where the trigger's centre was, so a thumb already
 * moving lands on "Keep them".
 */
export function UnblockButton({ bookingId }: { bookingId: string }) {
  const router = useRouter();
  const baseId = useId();
  const keepId = `${baseId}-keep`;

  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [working, startUnblock] = useTransition();
  const busy = working || done;

  // The safe button, not the destructive one, and by id rather than a ref so it
  // keeps working whichever way `Button` forwards its ref.
  useEffect(() => {
    if (!confirming) return;
    document.getElementById(keepId)?.focus();
  }, [confirming, keepId]);

  function confirm() {
    setError(null);
    startUnblock(async () => {
      try {
        const result = await unblockDates(bookingId);
        if (result.ok) {
          setDone(true);
          toast.success("Dates are free again.");
        } else {
          setError(result.error);
          setConfirming(false);
        }
      } catch (thrown) {
        console.error("[UnblockButton] unblock failed", thrown);
        setError("The block did not lift. Try again in a moment.");
        setConfirming(false);
      }
      router.refresh();
    });
  }

  if (!confirming) {
    return (
      <div className="flex flex-col items-start gap-1">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setConfirming(true)}
          disabled={busy}
          className="-ml-3 h-11 px-3 text-muted-foreground"
        >
          Unblock
        </Button>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div role="group" aria-labelledby={`${baseId}-ask`} className="flex flex-col gap-2">
      <p id={`${baseId}-ask`} className="text-sm">
        Open these nights to requests again?
      </p>
      <div className="flex gap-2">
        <Button
          id={keepId}
          type="button"
          variant="outline"
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="h-11 flex-1"
        >
          Keep them
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={confirm}
          disabled={busy}
          className="h-11 flex-1"
        >
          {working ? "Unblocking…" : "Unblock"}
        </Button>
      </div>
    </div>
  );
}
