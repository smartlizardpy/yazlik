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
 */

import Link from "next/link";

export default function Home() {
  return (
    <section className="flex flex-1 flex-col pt-8 pb-8">
      <p className="font-heading text-lg">Yazlık</p>

      <h1 className="pt-14 text-3xl text-balance">
        A house in the family, and one link that lets people in.
      </h1>

      <p className="pt-6 text-base text-pretty">
        You send the link. They ask for the week they want. You say yes, or not
        that week — and no money changes hands anywhere in it.
      </p>

      <div className="mt-auto flex flex-col gap-4 pt-16">
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
