"use server";

/**
 * One action, for the one thing the share screen changes: the feed token.
 *
 * It lives here rather than in `app/_actions/house.ts` because it is not a
 * settings edit. `updateHouse` is a partial patch driven by a form, and the
 * feed token is never a field on a form — it has no value the owner could type,
 * and the only sensible instruction is "make me a new one".
 *
 * ### Rotating is destructive on purpose
 *
 * The moment this runs, every calendar that was subscribed to the old URL stops
 * updating. Most clients will not say so — a subscribed calendar that starts
 * 404ing usually just goes quiet and keeps showing whatever it fetched last,
 * which is the worst possible failure to hide. So the button that calls this
 * asks first, and the screen tells the owner they will have to hand the new URL
 * to anyone who was using the old one.
 *
 * There is no undo. The old token is not stored anywhere after the update, and
 * that is the point: a leaked credential that can be reinstated is not revoked.
 */

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { houses } from "@/db/schema";
import { newToken } from "@/lib/ids";
import { requireHouse } from "@/lib/session";

/**
 * The result the button reads. On success it carries the new token so the
 * screen can show the new URL immediately, rather than waiting for a refresh to
 * come back with it.
 */
export type RotateFeedTokenResult =
  | { ok: true; feedToken: string }
  | { ok: false; error: string };

/**
 * Give the house a new feed token and forget the old one.
 *
 * Owner-only, and it takes no id: {@link requireHouse} resolves the house from
 * the session, so there is no parameter a caller could swap to rotate somebody
 * else's feed.
 */
export async function rotateFeedToken(): Promise<RotateFeedTokenResult> {
  const house = await requireHouse();
  const feedToken = newToken();

  try {
    await db.update(houses).set({ feedToken }).where(eq(houses.id, house.id));
  } catch (error) {
    // `feedToken` is UNIQUE, so a collision would land here. At 31^16 that is
    // not the case worth writing a retry for — the owner taps again.
    console.error(`[rotateFeedToken] update failed for house ${house.id}`, error);
    return { ok: false, error: "The link did not change. Try again in a moment." };
  }

  // The share screen is the only page that renders the token, and it reads it
  // from the house row. Nothing else on /app changes, so nothing else is told.
  revalidatePath("/app/share");

  return { ok: true, feedToken };
}
