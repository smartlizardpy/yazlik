import Link from "next/link";
import { getOwnerHouse, requireOwner } from "@/lib/session";
import { OwnerMenu } from "./owner-menu";

/**
 * The owner shell. Every /app route is protected here and nowhere else — a page
 * under this layout can assume there is a signed-in owner.
 *
 * The house is *not* required at this level: /app/onboarding lives under /app
 * too, and redirecting to it from the layout that wraps it would loop.
 */
export default async function OwnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOwner();
  const house = await getOwnerHouse();

  return (
    <div className="flex flex-1 flex-col">
      {/* Opaque, not 90% and blurred. Warm paper at nine-tenths is not enough to
          stop the black "Say yes" button reading through as a dark band across
          the house's own name as the page scrolls under it. */}
      <header className="sticky top-0 z-20 -mx-4 flex items-center gap-2 border-b border-border bg-background px-4 py-2">
        <Link
          href="/app"
          className="min-w-0 flex-1 truncate rounded-lg py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {house?.name ?? "Yazlık"}
        </Link>
        <OwnerMenu hasHouse={house !== null} />
      </header>

      <div className="flex flex-1 flex-col pb-16">{children}</div>
    </div>
  );
}
