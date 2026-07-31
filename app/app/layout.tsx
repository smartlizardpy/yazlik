import { getOwnerHouse, requireOwner } from "@/lib/session";
import { OwnerTabs } from "./owner-tabs";

/**
 * The owner shell. Every /app route is protected here and nowhere else — a page
 * under this layout can assume there is a signed-in owner.
 *
 * The house is *not* required at this level: /app/onboarding lives under /app
 * too, and redirecting to it from the layout that wraps it would loop.
 *
 * ### There is no header any more
 *
 * There was a sticky top bar carrying the house's name and a hamburger. The
 * hamburger became {@link OwnerTabs}, and once the menu was gone what was left
 * was a strip of 15px truncated text above every screen — which is a website's
 * masthead, not a phone app's. Each screen already opens with a statement in
 * the display face at 34px, and `/app` puts the house's own name and its first
 * photograph directly under it. A native app titles its screens; it does not
 * wear one title over all of them.
 *
 * ### One number, declared once
 *
 * `--owner-tabs` is the height the fixed bar occupies, safe area included. The
 * bar draws itself that tall, the spacer at the end of the column reserves
 * exactly it, and the settings form's sticky "Save changes" bar comes to rest
 * on top of it rather than sliding underneath. Three things that must agree,
 * and one place where the value lives.
 */
export default async function OwnerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireOwner();
  const house = await getOwnerHouse();

  return (
    <div
      className="flex flex-1 flex-col"
      style={
        { "--owner-tabs": "calc(4rem + env(safe-area-inset-bottom))" } as React.CSSProperties
      }
    >
      <div className="flex flex-1 flex-col">{children}</div>
      <OwnerTabs hasHouse={house !== null} />
    </div>
  );
}
