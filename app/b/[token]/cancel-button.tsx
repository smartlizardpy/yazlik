"use client";

/**
 * Self-cancel, in two taps that are nowhere near each other.
 *
 * A mis-tap here cancels a family holiday, so the first tap only ever asks a
 * question. It is deliberately **not** `window.confirm`: that dialog is
 * unstyled, untranslatable, and on iOS it can be suppressed entirely — three
 * ways for a destructive action to either look broken or fire unannounced.
 *
 * The confirm row splits in two and puts "Keep it" on the left, so a thumb that
 * was already moving lands on the safe button. Focus moves there too, which
 * makes the question the first thing a screen reader hears rather than the last.
 *
 * ### It is a footnote, not a button
 *
 * The trigger is small, quiet and last on the page — it used to be a full-width
 * control sitting directly under "See the house", which made cancelling the most
 * visually available thing to do on a holiday confirmation. It keeps a 44px
 * target because a small tap target is a different sin from a small label, and
 * the *question* it opens is full size: once you have said you mean it, the two
 * answers should be easy to hit and impossible to confuse.
 *
 * ### After it works
 *
 * `cancelBooking` revalidates `/b/[token]`, so the page re-renders as
 * *Cancelled* and this component stops being rendered at all — the guest never
 * has to refresh. The buttons stay disabled through that gap rather than
 * springing back to "Yes, cancel it", which would invite a second tap at
 * exactly the wrong moment. `router.refresh()` runs on every outcome, including
 * refusals: a page telling you to cancel something already cancelled is a page
 * that needs new data.
 */

import { useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { cancelBooking } from "@/app/_actions/booking";
import { Button } from "@/components/ui/button";
import { t, type Lang } from "@/lib/i18n";

export type CancelButtonProps = {
  /** The booking's own token — the entire credential for the cancellation. */
  token: string;
  /** The house's language. Everything a guest reads is in it. */
  language: Lang;
  /**
   * The owner's first name, or null for an account that never filled one in.
   *
   * The question used to end "The owner will be told", which is the one voice
   * this product does not use: giving a week back is telling *Ayşe*, and the
   * page above this row already names her twice.
   */
  owner: string | null;
};

/**
 * A line that names the owner, or the `.anon` wording that names nobody. Same
 * contract as `ownerLine` on the page — kept local rather than imported so this
 * client component pulls in nothing but the dictionary.
 */
function ownerLine(key: string, owner: string | null, language: Lang): string {
  return owner ? t(key, language, { owner }) : t(`${key}.anon`, language);
}

export function CancelButton({ token, language, owner }: CancelButtonProps) {
  const router = useRouter();
  const baseId = useId();
  const keepId = `${baseId}-keep`;

  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startCancel] = useTransition();

  // The safe button, not the destructive one. Focusing by id rather than a ref
  // keeps this working whichever way `Button` forwards its ref.
  useEffect(() => {
    if (!confirming) return;
    document.getElementById(keepId)?.focus();
  }, [confirming, keepId]);

  // Held past the action's own flag: on success the row must stay disabled
  // until the server sends back a page without it.
  const [done, setDone] = useState(false);
  const busy = pending || done;

  function confirm() {
    setError(null);
    startCancel(async () => {
      try {
        const result = await cancelBooking(token);

        if (result.ok) {
          setDone(true);
          // The page will say "Cancelled" on its own; this acknowledges the tap.
          toast.success(ownerLine("booking.cancel.done", owner, language));
        } else {
          setError(result.error);
          setConfirming(false);
        }
      } catch (thrown) {
        console.error("[CancelButton] cancel failed", thrown);
        setError(t("booking.cancel.failed", language));
        setConfirming(false);
      }

      router.refresh();
    });
  }

  if (!confirming) {
    return (
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setConfirming(true)}
          className="h-11 self-start px-0 text-sm font-normal text-muted-foreground underline underline-offset-4 hover:bg-transparent hover:text-foreground"
        >
          {t("booking.cancel.link", language)}
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
    <div
      role="group"
      aria-labelledby={`${baseId}-ask`}
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
    >
      <p id={`${baseId}-ask`} className="text-sm">
        {ownerLine("booking.cancel.ask", owner, language)}
      </p>
      <div className="flex gap-2">
        <Button
          id={keepId}
          type="button"
          variant="outline"
          onClick={() => setConfirming(false)}
          disabled={busy}
          className="h-11 flex-1 text-base"
        >
          {t("booking.cancel.no", language)}
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={confirm}
          disabled={busy}
          className="h-11 flex-1 text-base"
        >
          {busy
            ? t("booking.cancel.working", language)
            : t("booking.cancel.yes", language)}
        </Button>
      </div>
    </div>
  );
}
