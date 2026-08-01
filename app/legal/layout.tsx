import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";

/**
 * Indexable, unlike everything else in this product.
 *
 * A house link is noindex because it is private and turning up in a search
 * result would be a leak. These pages are the opposite: they exist to be found,
 * including by somebody who has not been sent anything, and there is nothing in
 * them about any particular house or guest.
 */
export const metadata: Metadata = {
  robots: { index: true, follow: true },
};

/**
 * The shell the legal pages share.
 *
 * These are the only screens in the product written for a reader rather than
 * for someone doing something. So: no pinned action, no tab bar, nothing to
 * tap except the way back. Just a column of text at a width you can read.
 *
 * They sit outside `(auth)` and `/app` on purpose — a guest who has never
 * signed in has more reason to read the privacy page than the owner does, and
 * putting it behind anything would be absurd.
 */
export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col pt-8 pb-16">
      <Link
        href="/"
        className="font-heading text-lg underline-offset-4 hover:underline"
      >
        Yazlık
      </Link>

      {/* `max-w-[62ch]`, wider than the app's 560px column: this is prose, and
          prose set to the width of a booking form is a wall. */}
      <article className="prose-legal mt-10 max-w-[62ch]">{children}</article>
    </div>
  );
}
