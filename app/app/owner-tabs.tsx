"use client";

/**
 * The owner's bottom tab bar.
 *
 * ### Why a tab bar and not the menu it replaces
 *
 * There were three screens behind a hamburger. No phone app in the world hides
 * three destinations behind a button, and the one that mattered most — the
 * photographs, the only colour anywhere in this product — was three taps deep:
 * open the menu, choose Settings, scroll past the header. Photographs are the
 * whole invitation, so they are a destination now, and everything is one thumb
 * away from everywhere.
 *
 * ### The four
 *
 * They are named after what the owner is *doing*, not after the routes:
 *
 * - **Who's coming** (`/app`) — the asks and the stays. The product's own
 *   words, and a people glyph, because that screen is a list of people.
 * - **Photos** (`/app/photos`) — promoted out of settings on its own.
 * - **Share** (`/app/share`) — the link, which is why the product exists.
 * - **The house** (`/app/settings`) — the name, the words, what you will say
 *   yes to. It wears the house glyph; the first tab does not, which is what
 *   keeps the two from reading as the same place.
 *
 * ### Current, without a colour
 *
 * This palette has no accent hue, so the usual trick — the active tab goes
 * blue — is not available. What is available is the system's own established
 * semantic: in `owner-menu.tsx` a *fill* was rejected for focus precisely
 * because "a filled row is indistinguishable from a chosen one". Here we want
 * exactly that reading, so the current tab's glyph sits in a filled ink disc
 * and its label steps from muted to ink. Filled against hollow is the largest
 * difference two shapes can have that is not a colour, and it survives
 * greyscale, sunlight and a glance.
 *
 * The disc's box is rendered on every tab and only filled on one, so nothing
 * moves by a pixel as the owner crosses the bar.
 *
 * ### Where it is not
 *
 * Guest routes never see this — it lives under `/app`, and `/h/[slug]` and
 * `/b/[token]` are for people with no account. Nor does onboarding: that flow
 * is a cover, three questions and a hand-over, and two of these tabs lead
 * nowhere until the house at the end of it exists. `hasHouse` is the same
 * guard the menu used.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { HouseIcon, ImagesIcon, Share2Icon, UsersIcon } from "lucide-react";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/app", label: "Who’s coming", Icon: UsersIcon },
  { href: "/app/photos", label: "Photos", Icon: ImagesIcon },
  { href: "/app/share", label: "Share", Icon: Share2Icon },
  { href: "/app/settings", label: "The house", Icon: HouseIcon },
] as const;

/**
 * `/app` is every owner screen's prefix, so it can only match exactly or it
 * would light up on all four. The rest own their subtrees.
 */
function isCurrent(pathname: string, href: string): boolean {
  if (href === "/app") return pathname === "/app";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function OwnerTabs({ hasHouse }: { hasHouse: boolean }) {
  const pathname = usePathname();

  if (!hasHouse || pathname.startsWith("/app/onboarding")) return null;

  return (
    <>
      {/* The bar is fixed, so it holds no space of its own — this does, at the
          end of the column, and it is why no page needs to remember to leave
          room. `--owner-tabs` is set once on the owner layout. */}
      <div aria-hidden="true" className="h-[var(--owner-tabs)] shrink-0" />

      {/* Opaque, for the same reason the header it replaces was: warm paper at
          nine-tenths with a blur behind it lets a photograph or an ink button
          read straight through as a smear under the labels. */}
      <nav
        aria-label="The house"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background pb-[env(safe-area-inset-bottom)]"
      >
        {/* `px-2` so the outer two labels keep a margin from the bezel. "Who's
            coming" is the widest label in the bar by some way and without this
            its W sat five pixels off the edge of the phone. */}
        <ul className="mx-auto flex h-16 w-full max-w-[560px] px-2">
          {TABS.map(({ href, label, Icon }) => {
            const current = isCurrent(pathname, href);
            return (
              <li key={href} className="min-w-0 flex-1">
                <Link
                  href={href}
                  aria-current={current ? "page" : undefined}
                  className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span
                    className={cn(
                      "flex size-8 items-center justify-center rounded-full transition-colors",
                      current
                        ? "bg-foreground text-background"
                        : "text-muted-foreground",
                    )}
                  >
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  {/* 13px is the floor of this type scale and the labels are
                      set at it rather than at the 10px a native tab bar uses:
                      one of them is two words, and a phone in the sun is not
                      the place to find out how small a label can get. */}
                  <span
                    className={cn(
                      "max-w-full truncate text-xs leading-none",
                      current
                        ? "font-medium text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
