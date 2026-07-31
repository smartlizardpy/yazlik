/**
 * `/` — the only page in this product that anybody arrives at without being
 * invited.
 *
 * It is kept rather than redirected to `/sign-in` because it is the one place
 * that has to say what this *is* — and because two kinds of person land here.
 * The owner, who was told about it and needs the way in; and a cousin who
 * trimmed the house link back to the domain out of habit and now needs telling,
 * gently, that they are on the wrong side of it. A redirect answers neither.
 *
 * What was here was a 22px wordmark floating in the middle of an empty 844px
 * screen with a heading barely larger than the paragraph under it. So: the mark
 * up top, the promise at the top third in the display face, and the one action
 * down where a thumb already is. The paper between them is the page's shape,
 * not a gap left by nothing being there.
 *
 * The promise is now set at the top of the scale, 48px, which is the only place
 * in the product that asks for it. That is not decoration: at 40px the sentence
 * ran three lines and left ~330px of paper between it and the button — a third
 * of the screen doing nothing, which reads as unfinished rather than composed.
 * A poster is what fills a page with four elements on it.
 */

import Link from "next/link";

export default function Home() {
  return (
    <section className="flex flex-1 flex-col pt-8 pb-8">
      <p className="font-heading text-lg">Yazlık</p>

      <h1 className="pt-14 text-4xl text-balance">
        A house in the family, and one link that lets people in.
      </h1>

      <p className="pt-6 text-base text-pretty">
        You send the link. They ask for the week they want. You say yes, or not
        that week — and no money changes hands anywhere in it.
      </p>

      {/* `pt-16` here was a fiction: with `mt-auto` above it the block is
          already pinned to the bottom, so the padding only ever pushed the
          auto-margin around and never moved the button. `pt-12` is the honest
          number — the minimum gap that survives when the screen is short
          enough for the slack to run out, and the same one `/sign-in` uses. */}
      <div className="mt-auto flex flex-col gap-4 pt-12">
        <Link
          href="/sign-in"
          className="flex min-h-14 items-center justify-center rounded-xl bg-primary px-4 text-base text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
        >
          Sign in
        </Link>

        {/* The cousin who arrived here by deleting the end of a URL. */}
        <p className="text-sm text-muted-foreground text-pretty">
          Sent a link to somebody&rsquo;s house? Open that one instead — this
          side is for whoever owns it.
        </p>
      </div>
    </section>
  );
}
