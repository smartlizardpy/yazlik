import type { Metadata } from "next";
import { requireHouse } from "@/lib/session";
import { SettingsForm } from "./settings-form";

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
 */
export default async function SettingsPage() {
  const house = await requireHouse();

  return (
    <section className="flex flex-1 flex-col gap-6 py-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">
          How your house reads on the link you share, and the rules every
          request has to meet.
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
    </section>
  );
}
