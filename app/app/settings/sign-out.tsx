"use client";

/**
 * Sign out, rehoused.
 *
 * It was the third row of the hamburger. The hamburger became a tab bar, and a
 * tab bar is for places you go rather than things that happen to you — so this
 * could not be a fifth tab. It went to the foot of `/app/settings` instead,
 * which is where a phone app puts it and the only owner screen that is about
 * the owner rather than about the house.
 *
 * Quiet on purpose: a rule above it, muted ink, no box. Nothing else on this
 * screen logs you out, so it does not need to shout, and the one irreversible
 * control in the product should not sit under a fill that reads as chosen.
 * Focus is a ring, the way it is everywhere else here.
 */

import { useTransition } from "react";
import { useRouter } from "next/navigation";

import { signOut } from "@/lib/auth-client";

export function SignOut() {
  const [signingOut, startSignOut] = useTransition();
  const router = useRouter();

  function handleSignOut() {
    startSignOut(async () => {
      await signOut();
      router.push("/sign-in");
      router.refresh();
    });
  }

  return (
    <div className="mt-2 border-t border-border pt-2">
      <button
        type="button"
        onClick={handleSignOut}
        disabled={signingOut}
        className="flex touch-target w-full items-center rounded-lg text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
      >
        {signingOut ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}
