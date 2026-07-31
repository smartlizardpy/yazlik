import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRightIcon } from "lucide-react";

import { ownerGuide } from "@/lib/guide";
import { requireHouse } from "@/lib/session";
import { SettingsForm } from "./settings-form";
import { SignOut } from "./sign-out";

export const metadata: Metadata = {
  title: "Settings",
};

/** One line about the guide, said in what is in it rather than in a count. */
function guideLine(
  publicCount: number,
  guestsCount: number,
  placeCount: number,
): string {
  if (publicCount + guestsCount + placeCount === 0) {
    return "Nothing written yet. The town, the walk to the water, and the key code for the people you say yes to.";
  }

  const parts: string[] = [];
  if (publicCount > 0) {
    parts.push(
      `${publicCount} ${publicCount === 1 ? "section" : "sections"} anyone can read`,
    );
  }
  if (guestsCount > 0) {
    parts.push(`${guestsCount} only your guests see`);
  }
  if (placeCount > 0) {
    parts.push(`${placeCount} ${placeCount === 1 ? "place" : "places"}`);
  }

  const written =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

  return `${written.charAt(0).toUpperCase()}${written.slice(1)}.`;
}

/**
 * The owner's own screen: what the house is called, what a request has to meet,
 * and how much the link gives away.
 *
 * `requireHouse()` is the whole guard — the owner layout already established
 * there is a session, and this redirects to onboarding if there is no house to
 * configure yet.
 *
 * The row is narrowed before it crosses to the client. The form has no use for
 * the slug, the feed token, or the Google calendar id, and the feed token is
 * the private subscribe URL — it should not travel in a payload that does not
 * need it.
 *
 * ### Photos left, and sign out arrived
 *
 * The gallery is `/app/photos` now — its own tab, because adding a photograph
 * of the house is one of the two things an owner most wants to do and it was
 * buried here. Sign out came the other way: it was the third row of the
 * hamburger, and when that went it needed a home. This is the screen that is
 * about *your* end of the product rather than the guest's, so it ends here, at
 * the foot of everything, where a phone app puts it.
 *
 * ### The guide is a row, not a section
 *
 * `/app/settings/guide` is a child of this route so that the "The house" tab
 * stays lit while the owner is writing in it — see the head of that page for
 * why it is a room in here rather than a fifth tab. This screen only holds the
 * door to it, at the top, where two taps from the tab bar is the whole argument.
 */
export default async function SettingsPage() {
  const house = await requireHouse();
  const guide = await ownerGuide(house.id);

  return (
    <section className="flex flex-1 flex-col gap-6 pt-8 pb-6">
      {/* A statement, at the size every other h1 in the product is. "Settings"
          named the panel rather than the screen — what is actually here is the
          house as everyone else meets it, and what you have already agreed to.

          `pt-8`, not `pt-6`: a screen that starts hard against the top of the
          phone looks cropped. The `scroll-mt-20` on the sections below is left
          in place: it costs nothing and it is still what keeps a jumped-to
          field off the very edge of the viewport. */}
      <header className="flex scroll-mt-20 flex-col gap-2">
        <h1 className="text-2xl text-balance">How the house reads</h1>
        <p className="text-base text-muted-foreground">
          The words on your link, and what you will say yes to when someone
          asks.
        </p>
      </header>

      {/* The guide ----------------------------------------------------------
          First thing under the header, and above the form, because it is the
          only thing on this screen that is *writing* rather than settling a
          number — and because two taps from the tab bar is the whole argument
          for it not being a fifth tab. It is a row, not a section: the words
          themselves live on their own screen, and repeating any of them here
          would be a second place to look for them. */}
      <Link
        href="/app/settings/guide"
        className="flex min-h-14 items-center gap-3 rounded-xl border border-foreground/25 px-4 py-3"
      >
        <span className="min-w-0 flex-1">
          <span className="font-heading block text-lg">
            What you would tell them
          </span>
          <span className="mt-0.5 block text-sm text-muted-foreground">
            {guideLine(
              guide.publicSections.length,
              guide.guestsSections.length,
              guide.places.length,
            )}
          </span>
        </span>
        <ArrowRightIcon className="size-5 shrink-0" aria-hidden="true" />
      </Link>

      <SettingsForm
        house={{
          id: house.id,
          name: house.name,
          town: house.town,
          country: house.country,
          language: house.language,
          blurb: house.blurb,
          minNights: house.minNights,
          maxNights: house.maxNights,
          gapDays: house.gapDays,
          maxGuests: house.maxGuests,
          bookableFrom: house.bookableFrom,
          bookableTo: house.bookableTo,
          showGuestNames: house.showGuestNames,
        }}
      />


      {/* The last thing on the last screen, ruled off from the house so it
          cannot be mistaken for one more thing about the house. */}
      <SignOut />
    </section>
  );
}
