import type { Metadata } from "next";
import { isGoogleConfigured } from "@/lib/google/config";
import { requireHouse } from "@/lib/session";
import { GoogleSection } from "./google-section";
import { SettingsForm } from "./settings-form";
import { SignOut } from "./sign-out";

export const metadata: Metadata = {
  title: "Settings",
};

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
 */
export default async function SettingsPage() {
  const house = await requireHouse();

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

      {/* Last, and on purpose.

          Connecting a calendar is a once-ever setup step. The name, the words
          and the photos are what an owner opens this screen to change, and they
          open it more than once — so second position was going to the most
          inert block on the page. On an install with no OAuth client this is a
          heading and one sentence with nothing to press; it belongs at the foot
          of the screen, where a footnote belongs.

          Like photos, it saves on its own rather than through the form's sticky
          bar — connecting a calendar is a round trip to Google, not a field. The
          bar is `sticky bottom-0` *inside* the form, so it pins to the form's own
          box and releases at its end rather than floating over this.
          `configured` is read on the server: a client component must not be the
          thing that decides whether credentials exist. */}
      <GoogleSection
        configured={isGoogleConfigured()}
        houseName={house.name}
      />

      {/* The last thing on the last screen, ruled off from the house so it
          cannot be mistaken for one more thing about the house. */}
      <SignOut />
    </section>
  );
}
