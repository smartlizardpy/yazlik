import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeftIcon } from "lucide-react";

import { ownerGuide } from "@/lib/guide";
import { buildGuidePrompt } from "@/lib/guide-prompt";
import { toLang } from "@/lib/i18n";
import { requireHouse } from "@/lib/session";

import { GuideEditor } from "./guide-editor";

export const metadata: Metadata = {
  title: "The guide",
};

/**
 * `/app/settings/guide` — where the owner writes what a guest reads.
 *
 * ### Why it is a room inside "The house" and not a fifth tab
 *
 * The bar holds four. On a 390px phone a fifth leaves each tab 74px, and the
 * one that has to survive it is "Who's coming" — the widest label in the bar,
 * the screen an owner opens every day, and the one that would come back as
 * "Who's comi…". Paying for that with the daily screen's own name is a bad
 * trade for a destination that is used twice: once when the house is set up,
 * and again in July when the wifi password changes. Photographs earned their
 * promotion because adding one is frequent, one-tap and the only colour in the
 * product; writing a guide is a sit-down job.
 *
 * So it lives where it already belongs. `/app/settings` is "The house" — the
 * name, the words, what you will say yes to — and the guide is more of the
 * words. As a child route the tab stays lit while the owner is in here, which
 * is the whole reason it is under that path rather than at `/app/guide`, where
 * no tab would be current and the bar would read as broken.
 *
 * It is two taps from anywhere and neither of them is a scroll: the tab, then
 * the first row of the screen it opens. That is one tap more than photographs
 * and one fewer than the hamburger this product got rid of.
 *
 * ### What crosses to the client
 *
 * `ownerGuide()` — both halves and the places, which is the only function in
 * `lib/guide.ts` a screen under `/app` should reach for — and the prompt,
 * built here rather than in the browser so that `buildGuidePrompt` and the
 * house row it reads stay on the server.
 */
export default async function GuidePage() {
  const house = await requireHouse();
  const { publicSections, guestsSections, places } = await ownerGuide(house.id);

  return (
    <section className="flex flex-1 flex-col gap-6 pt-5 pb-6">
      {/* There is no header anywhere under /app, so a nested screen has to
          carry its own way back. It names the screen it returns to rather than
          saying "Back", which is the same word on every page in the world. */}
      <Link
        href="/app/settings"
        className="-ml-1 inline-flex h-11 w-fit items-center gap-1 rounded-lg pr-2 text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <ChevronLeftIcon className="size-4" aria-hidden="true" />
        The house
      </Link>

      <header className="flex flex-col gap-2">
        <h1 className="text-2xl text-balance">What you would tell them</h1>
        <p className="text-base text-muted-foreground">
          Half of this is on your link for anyone to read. The other half only
          reaches someone whose week is already theirs.
        </p>
      </header>

      <GuideEditor
        houseId={house.id}
        houseName={house.name}
        language={toLang(house.language)}
        prompt={buildGuidePrompt(house)}
        publicSections={publicSections}
        guestsSections={guestsSections}
        places={places}
      />
    </section>
  );
}
