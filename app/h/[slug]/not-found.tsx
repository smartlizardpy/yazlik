/**
 * What a wrong `/h/[slug]` shows.
 *
 * It says the same thing whether the slug never existed, was mistyped, or
 * belonged to a house that has since gone. That is the point: the slug is an
 * unguessable credential, and a 404 that reads differently for a near miss is a
 * way to test guesses against it.
 *
 * English, not the house's language — there is no house to ask. `notFound()`
 * makes Next return a 404 status and inject `noindex` on its own.
 */

import { DEFAULT_LANG, t } from "@/lib/i18n";

export default function HouseNotFound() {
  return (
    <section className="flex flex-1 flex-col justify-center gap-3 py-16">
      <h1 className="text-lg font-semibold tracking-tight">
        {t("house.notFound.title", DEFAULT_LANG)}
      </h1>
      {/* No link onwards. The link they need is in the message they were sent,
          and pointing a guest at the owner's sign-in page helps nobody. */}
      <p className="text-base text-muted-foreground">
        {t("house.notFound", DEFAULT_LANG)}
      </p>
    </section>
  );
}
