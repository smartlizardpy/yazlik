/**
 * `/app/onboarding` — the first run, and the only screen an owner sees before
 * they own anything.
 *
 * It is not a form with three fields on it. It is the moment somebody decides
 * to let their family into their house, so it is built the way a phone app is
 * built: a cover that makes a promise, then one question per screen with Back
 * and Next, then a hand-over. The dots at the top are the same
 * {@link StepDots} the guest's request flow uses, because a cousin asking for
 * a week and an owner opening the door are the same product.
 *
 * ### Onboarding ends with a link, not with an INSERT
 *
 * The last screen is the point of the whole thing: the house's link, the
 * phone's own share sheet, and a sentence telling the owner to send it to
 * someone. An owner who reaches the dashboard without ever having sent the
 * link has not finished onboarding — they have filled in a form.
 *
 * That is why this file, not the client, owns the ending. `createHouse`
 * finishes with `redirect("/app")`; the flow catches that redirect (see
 * {@link isRedirect}), the client refreshes, and this page comes back holding
 * a house — which is the hand-over. It also means the screen is idempotent: an
 * owner who lands here later gets their link again rather than a bounce.
 */

import type { Metadata } from "next";
import Link from "next/link";

import { createHouse, type ActionResult } from "@/app/_actions/house";
import { ShareLink } from "@/app/app/share/share-links";
import { StepDots } from "@/components/step-dots";
import { getOwnerHouse } from "@/lib/session";

import { OnboardingForm } from "./onboarding-form";

export const metadata: Metadata = {
  title: "Your house",
};

/**
 * The origin the link is built from. `NEXT_PUBLIC_APP_URL`, never the request's
 * `Host` header — the same constant `/app/share` and `lib/ics.ts` use, so an
 * owner cannot copy one origin off this screen while their calendar quietly
 * points at another.
 */
const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.BETTER_AUTH_URL ??
  "http://localhost:3100"
).replace(/\/+$/, "");

/** Three questions and the hand-over. Kept in step with `onboarding-form.tsx`. */
const TOTAL_STEPS = 4;

/**
 * Was this thrown by `redirect()`?
 *
 * `createHouse` ends on `redirect("/app")`, which throws — and a thrown
 * redirect is how the Server Action would drop the owner on the dashboard
 * before they have been given their link. So the wrapper below swallows that
 * one error and lets this page render the last step instead.
 *
 * The digest is matched by shape rather than imported from `next/dist/*`: a
 * deep import into the framework's internals is the thing that breaks on an
 * upgrade. If the shape ever changes, this returns `false`, the error rethrows,
 * and the owner lands on `/app` — which is exactly what happened before this
 * screen existed. A safe way to be wrong.
 */
function isRedirect(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "digest" in error &&
    typeof (error as { digest: unknown }).digest === "string" &&
    (error as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

/**
 * Make the house, and stay here.
 *
 * `createHouse` is called unchanged — same validation, same slug, same
 * `revalidatePath` — and everything it refuses comes straight back to the step
 * that asked the question.
 */
async function makeHouse(input: {
  name: string;
  town: string;
  country: string;
}): Promise<ActionResult> {
  "use server";

  try {
    // It only ever *returns* when it refused; success leaves through redirect().
    return await createHouse(null, input);
  } catch (error) {
    if (!isRedirect(error)) throw error;
    return { ok: true };
  }
}

export default async function OnboardingPage() {
  const house = await getOwnerHouse();

  /* --- The last step: the link ---------------------------------------- */

  if (house) {
    return (
      <section className="flex flex-1 flex-col gap-8 pt-5 pb-6">
        <StepDots
          total={TOTAL_STEPS}
          current={TOTAL_STEPS - 1}
          label={`Step ${TOTAL_STEPS} of ${TOTAL_STEPS}`}
        />

        <header className="flex flex-col gap-4">
          {/* The name they just chose, at the size a name deserves. This is the
              first time they see the house as a thing that exists. */}
          <h1 className="text-3xl text-balance">{house.name} is ready.</h1>
          <p className="text-base text-pretty">
            This is the link. Send it to someone — they pick the week they want,
            and you say yes.
          </p>
        </header>

        {/* The phone's own share sheet, the same control `/app/share` leads
            with. Onboarding is not finished until this button has been
            pressed, so it is the only ink on the screen. */}
        <ShareLink
          url={`${APP_URL}/h/${house.slug}`}
          title={house.name}
          message="Come and stay — pick the week you want and I will say yes."
          sendLabel="Send it to someone"
          copyLabel="Copy the link"
          primary
        />

        <p className="text-sm text-muted-foreground text-pretty">
          Anyone holding it can ask. Only you say yes, and no money changes
          hands anywhere in this.
        </p>

        <Link
          href="/app"
          className="mt-auto flex min-h-14 items-center justify-center rounded-xl border border-foreground/25 px-4 text-base focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Go to the house
        </Link>
      </section>
    );
  }

  /* --- The cover and the three questions ------------------------------ */

  return <OnboardingForm makeHouse={makeHouse} />;
}
