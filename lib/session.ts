/**
 * The only way the rest of the app touches auth.
 *
 * Four helpers, all server-side. Nothing else should import `auth` directly or
 * reach for `headers()` to work out who is signed in — if a rule about access
 * ever changes, it changes here and nowhere else.
 *
 * `cache()` is React's per-request memo: a layout and the page inside it both
 * call `requireOwner()`, and that must cost one session read, not two.
 */

import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { houses, type House } from "@/db/schema";
import { auth } from "@/lib/auth";

/** What better-auth hands back: `{ session, user }`, or null when signed out. */
export type Session = NonNullable<Awaited<ReturnType<typeof auth.api.getSession>>>;

/** The signed-in owner. Derived from better-auth so extra fields stay typed. */
export type OwnerUser = Session["user"];

/**
 * Reads the better-auth session from the request cookies.
 * Returns null when nobody is signed in — this one never redirects, so it is
 * safe on pages that render differently for guests.
 */
export const getSession = cache(async (): Promise<Session | null> => {
  return auth.api.getSession({ headers: await headers() });
});

/** The signed-in owner, or a redirect to /sign-in. Never returns null. */
export async function requireOwner(): Promise<OwnerUser> {
  const session = await getSession();
  if (!session) redirect("/sign-in");
  return session.user;
}

/**
 * The signed-in owner's house, or null if they have not made one yet.
 * One house per owner in v1; `createdAt` ordering keeps the answer stable if a
 * second row ever appears.
 */
export const getOwnerHouse = cache(async (): Promise<House | null> => {
  const session = await getSession();
  if (!session) return null;

  const [house] = await db
    .select()
    .from(houses)
    .where(eq(houses.ownerId, session.user.id))
    .orderBy(asc(houses.createdAt))
    .limit(1);

  return house ?? null;
});

/** The owner's house, or a redirect: /sign-in if signed out, onboarding if unbuilt. */
export async function requireHouse(): Promise<House> {
  await requireOwner();
  const house = await getOwnerHouse();
  if (!house) redirect("/app/onboarding");
  return house;
}
