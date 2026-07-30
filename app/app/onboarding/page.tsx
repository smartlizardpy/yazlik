import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getOwnerHouse } from "@/lib/session";
import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = {
  title: "Add your house",
};

/**
 * The gap between signing in and having something to share.
 *
 * It asks for the three things nobody can guess and nothing else. Nights, gaps,
 * season, language and the rest all have defaults, and defaults are a better
 * first impression than a wizard: the owner gets a link now and tunes the rules
 * when a real request makes them care.
 *
 * The owner layout already established there is a session. This only checks
 * whether that owner has got as far as a house.
 */
export default async function OnboardingPage() {
  if (await getOwnerHouse()) redirect("/app");

  return (
    <section className="flex flex-1 flex-col gap-6 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Add your house</h1>
        <p className="text-sm text-muted-foreground">
          Three answers and it&rsquo;s ready. You get one link to send your
          family — they ask for the dates they want, and you approve or decline.
        </p>
      </header>

      <OnboardingForm />
    </section>
  );
}
