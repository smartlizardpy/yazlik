"use server";

/**
 * Everything that changes a photo after it exists.
 *
 * Uploading is a route handler (`app/api/upload/route.ts`) because a multipart
 * body is not a form submit. Everything after that — deleting one, describing
 * one, putting the gallery in order — is an ordinary mutation, so it is a
 * Server Action and returns the same `{ ok }` union the house actions do.
 *
 * These take plain arguments rather than a `FormData`: they are called from a
 * button and a drag handle, not from a `<form>` with named inputs. `field` is
 * still set where there is an input to attach the message to.
 *
 * ### Ownership is never taken from the argument
 *
 * A photo id is a bare UUID in a client component's props, so every action here
 * loads the row, joins its house, and compares that house's `ownerId` to the
 * session before writing anything.
 */

import { revalidatePath } from "next/cache";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { ActionResult } from "@/app/_actions/house";
import { db } from "@/db";
import { houses, images } from "@/db/schema";
import { requireOwner } from "@/lib/session";
import { remove } from "@/lib/storage";

/* ============================================================
   SCHEMAS
   ============================================================ */

/** Ids come from Postgres. Anything that is not a UUID never reaches a query. */
const idSchema = z.uuid("That photo is not one of yours. Refresh the page and try again.");

const houseIdSchema = z.uuid("That house is not yours to change.");

/**
 * The description a screen reader reads out. Empty is a real answer — a photo
 * of the sea next to a paragraph about the sea is decorative — so it is stored
 * as NULL rather than refused.
 */
const altSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z
    .string({ error: "Describe the photo in a few words, or leave it empty." })
    .max(200, "That description is too long. Keep it to 200 characters."),
);

const orderSchema = z
  .array(idSchema, { error: "That order could not be read. Refresh the page and try again." })
  .max(64, "That is more photos than this house can hold. Refresh the page and try again.");

/* ============================================================
   HELPERS
   ============================================================ */

/** One message, one field — the same rule the house actions follow. */
function failure(error: z.ZodError, field?: string): ActionResult {
  const message =
    error.issues[0]?.message ??
    "Something about that photo is not valid. Refresh the page and try again.";
  return field ? { ok: false, error: message, field } : { ok: false, error: message };
}

/** The photo and the house it hangs on, or `null` if there is no such photo. */
async function findImage(id: string) {
  const [row] = await db
    .select({
      id: images.id,
      pathname: images.pathname,
      houseId: images.houseId,
      ownerId: houses.ownerId,
      slug: houses.slug,
    })
    .from(images)
    .innerJoin(houses, eq(images.houseId, houses.id))
    .where(eq(images.id, id))
    .limit(1);

  return row ?? null;
}

/** The owner screens all read photos; the guest page reads the gallery. */
function revalidateFor(slug: string): void {
  revalidatePath("/app", "layout");
  revalidatePath(`/h/${slug}`);
}

/* ============================================================
   ACTIONS
   ============================================================ */

/**
 * Remove a photo from the house and delete its file.
 *
 * The row goes first and the file second, deliberately. `remove()` never
 * throws, so a store that is having a bad afternoon leaves a file behind — that
 * is logged and recoverable. The reverse order would leave a row pointing at
 * nothing, which is a broken image on the guest page and much harder to notice.
 */
export async function deleteImage(id: string): Promise<ActionResult> {
  const owner = await requireOwner();

  const parsed = idSchema.safeParse(id);
  if (!parsed.success) return failure(parsed.error);

  const found = await findImage(parsed.data);
  if (!found) {
    return { ok: false, error: "That photo is already gone. Refresh the page." };
  }
  if (found.ownerId !== owner.id) {
    return { ok: false, error: "That photo is not yours to delete." };
  }

  try {
    await db.delete(images).where(eq(images.id, found.id));
  } catch (error) {
    console.error("[deleteImage] delete failed", error);
    return { ok: false, error: "The photo did not delete. Try again in a moment." };
  }

  await remove(found.pathname);

  revalidateFor(found.slug);
  return { ok: true };
}

/**
 * Change what a photo is described as. An empty description clears it.
 */
export async function updateImageAlt(id: string, alt: string): Promise<ActionResult> {
  const owner = await requireOwner();

  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return failure(parsedId.error);

  const parsedAlt = altSchema.safeParse(alt);
  if (!parsedAlt.success) return failure(parsedAlt.error, "alt");

  const found = await findImage(parsedId.data);
  if (!found) {
    return { ok: false, error: "That photo is already gone. Refresh the page." };
  }
  if (found.ownerId !== owner.id) {
    return { ok: false, error: "That photo is not yours to change." };
  }

  const text = parsedAlt.data;

  try {
    await db
      .update(images)
      .set({ alt: text === "" ? null : text })
      .where(eq(images.id, found.id));
  } catch (error) {
    console.error("[updateImageAlt] update failed", error);
    return { ok: false, error: "The description did not save. Try again in a moment." };
  }

  revalidateFor(found.slug);
  return { ok: true };
}

/**
 * Put the house gallery in the given order.
 *
 * `orderedIds` has to be every gallery photo, exactly once — not a subset. A
 * partial list would leave the photos it omits holding stale positions, and the
 * strip would come back in an order nobody chose. A list that no longer matches
 * the gallery means someone deleted or added a photo in another tab, and the
 * honest answer to that is to say so rather than write half of it.
 *
 * Place and section photos are not in scope: they are one photo each, so they
 * have nothing to order, and naming one here is what a stale list looks like.
 */
export async function reorderImages(
  houseId: string,
  orderedIds: string[],
): Promise<ActionResult> {
  const owner = await requireOwner();

  const parsedHouseId = houseIdSchema.safeParse(houseId);
  if (!parsedHouseId.success) return failure(parsedHouseId.error);

  const parsedOrder = orderSchema.safeParse(orderedIds);
  if (!parsedOrder.success) return failure(parsedOrder.error);

  const order = parsedOrder.data;

  const [house] = await db
    .select({ id: houses.id, slug: houses.slug })
    .from(houses)
    .where(and(eq(houses.id, parsedHouseId.data), eq(houses.ownerId, owner.id)))
    .limit(1);

  if (!house) return { ok: false, error: "That house is not yours to change." };

  const gallery = await db
    .select({ id: images.id })
    .from(images)
    .where(
      and(
        eq(images.houseId, house.id),
        isNull(images.placeId),
        isNull(images.sectionId),
      ),
    );

  const stale = {
    ok: false as const,
    error: "The photos changed while you were sorting them. Refresh the page and try again.",
  };

  const known = new Set(gallery.map((row) => row.id));
  const wanted = new Set(order);

  if (wanted.size !== order.length) return stale;
  if (wanted.size !== known.size) return stale;
  for (const id of order) {
    if (!known.has(id)) return stale;
  }

  if (order.length === 0) return { ok: true };

  // One statement, not one per photo. Twelve `UPDATE`s in a transaction is
  // twelve round trips to a database that is not in this building — measured at
  // roughly five seconds, for a drag that has to feel instant. A single
  // statement is also atomic on its own, so the order never half-lands.
  const pairs = sql.join(
    order.map((id, position) => sql`(${id}::uuid, ${position}::integer)`),
    sql`, `,
  );

  try {
    await db.execute(sql`
      update ${images} as i
      set "position" = v.pos
      from (values ${pairs}) as v(id, pos)
      where i.id = v.id and i.house_id = ${house.id}::uuid
    `);
  } catch (error) {
    console.error("[reorderImages] update failed", error);
    return { ok: false, error: "The new order did not save. Try again in a moment." };
  }

  revalidateFor(house.slug);
  return { ok: true };
}
