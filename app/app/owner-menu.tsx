"use client";

import { useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MenuIcon } from "lucide-react";
import { signOut } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

/**
 * Focus is a ring, never a fill.
 *
 * The sheet opens with focus already somewhere inside it, and a filled row is
 * indistinguishable from a chosen one — so the menu opened with "Sign out", the
 * only irreversible thing in it, looking as though the owner had already picked
 * it. A ring says "your keyboard is here"; beige says "this one".
 */
const ROW =
  "flex touch-target items-center rounded-lg px-3 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * The owner's menu. A bottom sheet rather than a dropdown: on a 390px screen a
 * sheet puts every row inside thumb reach and gives each one a real 44px target.
 *
 * Settings and Share only appear once a house exists — before that they lead
 * nowhere, and a menu item that goes nowhere is worse than an absent one.
 */
export function OwnerMenu({ hasHouse }: { hasHouse: boolean }) {
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
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="-mr-2 size-11 shrink-0"
          aria-label="Open menu"
        >
          <MenuIcon className="size-5" />
        </Button>
      </SheetTrigger>

      {/* The built-in close button is a 28px target. A bottom sheet closes by
          tapping outside it or pressing Escape, so drop it rather than ship a
          control too small to hit. */}
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-0 rounded-t-xl pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Menu</SheetTitle>
          <SheetDescription>Settings, sharing, and signing out.</SheetDescription>
        </SheetHeader>

        <nav className="flex flex-col gap-1 px-3 pt-2">
          {hasHouse ? (
            <>
              <SheetClose asChild>
                <Link href="/app/settings" className={ROW}>
                  Settings
                </Link>
              </SheetClose>
              <SheetClose asChild>
                <Link href="/app/share" className={ROW}>
                  Share
                </Link>
              </SheetClose>
            </>
          ) : null}

          <button
            type="button"
            onClick={handleSignOut}
            disabled={signingOut}
            className={`${ROW} w-full text-left disabled:opacity-50`}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
