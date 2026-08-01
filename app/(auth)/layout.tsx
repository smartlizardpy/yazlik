import type { ReactNode } from "react";
import Link from "next/link";

/**
 * One narrow column with the same silhouette as `/`: the name and the words at
 * the top, the single action pushed down to where the thumb already is.
 *
 * It used to be `pt-8` and nothing else. On a 390x844 phone that ended the
 * whole screen at about 380px and left ~460px of blank paper underneath it,
 * with "Email me a link" stranded in the top third of the glass. The lesson
 * from that, and the rule this file now keeps: empty paper *above* a
 * bottom-anchored action is composition, empty paper *below* the last element
 * is a page that failed to finish. So the column stretches and the children
 * are free to claim the slack with `mt-auto`.
 *
 * The stretch is a phone thing. From `sm` up the column goes back to its
 * natural height (`sm:flex-none`) — a bordered card pulled down the full height
 * of a desktop window is not a card — and with no free space left, `mt-auto`
 * inside it quietly does nothing.
 *
 * The border is deliberately absent on a phone: a boxed card inside a 390px
 * viewport is just a second frame around the frame.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col pt-8 pb-8 sm:pt-16 sm:pb-16">
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col sm:flex-none sm:rounded-lg sm:border sm:border-border sm:p-6">
        {children}

        {/* Signing in is the only moment an owner agrees to anything, so it is
            the only honest place to say what they are agreeing to. Below the
            form and quiet — a consent checkbox nobody reads would be worse
            than a sentence they can. */}
        <p className="mt-8 text-xs text-muted-foreground">
          Signing in means you accept the{" "}
          <Link href="/legal/terms" className="underline underline-offset-4">
            terms
          </Link>{" "}
          and the{" "}
          <Link href="/legal/privacy" className="underline underline-offset-4">
            privacy page
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
