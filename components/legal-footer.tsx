import Link from "next/link";

import { t, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The three legal links, small, at the foot of whatever page will have them.
 *
 * A guest reaches this product through a link in a group chat, having never
 * seen a sign-up page and never agreed to anything. So the pages that say what
 * is stored and who is responsible have to be reachable from where they
 * actually are — the house and their own booking — rather than only from a
 * landing page they will never visit.
 *
 * Localised, because both of those are guest surfaces. The owner's side passes
 * nothing and gets English, matching every other owner screen.
 */
export function LegalFooter({
  language = "en",
  className,
}: {
  language?: Lang;
  className?: string;
}) {
  return (
    <footer
      className={cn(
        "mt-12 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-5",
        className,
      )}
    >
      <Link
        href="/legal/privacy"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        {t("legal.privacy", language)}
      </Link>
      <Link
        href="/legal/terms"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        {t("legal.terms", language)}
      </Link>
      <Link
        href="/legal/contact"
        className="text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        {t("legal.contact", language)}
      </Link>
    </footer>
  );
}
