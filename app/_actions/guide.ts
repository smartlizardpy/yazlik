"use server";

/**
 * Everything that writes to `guide_sections` and `places`.
 *
 * The guide is the one part of this product with a real editor in it, so this
 * file is longer than the others — create, change, delete and reorder, twice
 * over, plus the visibility toggle and the one action that saves a whole pasted
 * draft at once.
 *
 * These take plain arguments rather than a `FormData`. They are called from an
 * editor with its own state, not from a `<form>` with named inputs, and they
 * return the same `{ ok }` union every other action here returns so a screen
 * can show one message beside one field.
 *
 * ### Ownership comes from the session, never from an argument
 *
 * Every action starts at `requireHouse()`, which is the signed-in owner's own
 * house, and every statement is scoped by that `houseId` as well as by the row
 * id. Swapping a section id for one belonging to another house does not read a
 * row, does not write a row, and does not tell the caller which of those two it
 * was: it says the section is not one of yours, exactly as it does for an id
 * that never existed.
 *
 * ### Nothing here calls a model
 *
 * {@link saveGuideDraft} takes a draft the owner has already read and edited on
 * screen. The text came from `lib/guide-prompt.ts` by way of their own ChatGPT
 * or Claude window, and `lib/guide-parse.ts` turned the reply into rows. This
 * app has no API key and no AI SDK, and this action is not the place to add
 * one — see the head of `lib/guide-prompt.ts`.
 *
 * ### A draft is added, never swapped in
 *
 * `saveGuideDraft` appends. It does not clear what is already there. A parse
 * that went sideways, or a second run of the prompt, can then only ever leave
 * the owner with too much — which is a delete away — instead of eating six
 * paragraphs they wrote by hand in July.
 */

import { revalidatePath } from "next/cache";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { ActionResult } from "@/app/_actions/house";
import { db } from "@/db";
import {
  guideSections,
  images,
  places,
  type GuideVisibility,
  type House,
  type PlaceCategory,
} from "@/db/schema";
import type { DraftPlace, DraftSection } from "@/lib/guide-parse";
import { requireHouse } from "@/lib/session";
import { remove } from "@/lib/storage";

/* ============================================================
   WHAT THE EDITOR SENDS
   ============================================================ */

/** A new section. `body` may be empty — a title with a blank body is a to-do. */
export type SectionInput = {
  title: string;
  body?: string;
  visibility?: GuideVisibility;
};

/** A change to a section. Omit a key to leave it as it is. */
export type SectionPatch = {
  title?: string;
  body?: string;
  visibility?: GuideVisibility;
};

export type PlaceInput = {
  name: string;
  category: PlaceCategory;
  note?: string | null;
  mapUrl?: string | null;
};

export type PlacePatch = {
  name?: string;
  category?: PlaceCategory;
  note?: string | null;
  mapUrl?: string | null;
};

/**
 * What {@link saveGuideDraft} takes. A `GuideDraft` from `parseGuideReply`
 * satisfies it as-is; the editor sends the same shape once the owner has
 * finished changing it.
 */
export type GuideDraftInput = {
  sections: DraftSection[];
  places: DraftPlace[];
};

/* ============================================================
   LIMITS
   ============================================================ */

/**
 * A guide is a short personal note, not a wiki. These are far above anything a
 * person would write and far below anything that would make the guest page slow
 * or a runaway paste expensive.
 */
const MAX_SECTIONS = 40;
const MAX_PLACES = 60;

/* ============================================================
   FIELDS
   ============================================================ */

const trimmed = (value: unknown) =>
  typeof value === "string" ? value.trim() : value;

/** `""` and whitespace mean "there is none", which in these columns is NULL. */
const emptyToNull = (value: unknown) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;
  const text = value.trim();
  return text === "" ? null : text;
};

const idSchema = z.uuid("That is not one of yours. Refresh the page and try again.");

const titleField = z.preprocess(
  trimmed,
  z
    .string({ error: "Give the section a title — a few words is plenty." })
    .min(1, "Give the section a title — a few words is plenty.")
    .max(200, "That title is too long. Keep it to 200 characters."),
);

/**
 * The body is allowed to be empty on purpose. The prompt asks for the
 * guests-only half as titles with nothing under them, because the wifi and the
 * boiler are things only the owner knows — an empty body is a note to self, not
 * a mistake.
 */
const bodyField = z.preprocess(
  (value) => (value === null || value === undefined ? "" : trimmed(value)),
  z
    .string({ error: "That section could not be read. Refresh the page and try again." })
    .max(5000, "That section is too long. Keep it to 5000 characters."),
);

const visibilityField = z.enum(["public", "guests"], {
  error: "Choose who reads this — everyone, or only your guests.",
});

const nameField = z.preprocess(
  trimmed,
  z
    .string({ error: "Name the place, the way you would say it out loud." })
    .min(1, "Name the place, the way you would say it out loud.")
    .max(120, "That name is too long. Keep it to 120 characters."),
);

const categoryField = z.enum(["eat", "drink", "beach", "walk", "shop", "kids"], {
  error: "Pick what kind of place this is.",
});

const noteField = z.preprocess(
  emptyToNull,
  z
    .string()
    .max(500, "That note is too long. Keep it to 500 characters.")
    .nullable(),
);

/**
 * A link the owner pastes. There is no Maps API anywhere in this product, so
 * whatever they paste is what is stored — it only has to be a link.
 */
const mapUrlField = z.preprocess(
  emptyToNull,
  z
    .url("That map link does not look like a link. Paste the whole address, starting with https.")
    .max(2000, "That map link is too long. Paste a shorter one.")
    .nullable(),
);

/* ============================================================
   SCHEMAS
   ============================================================ */

const createSectionSchema = z.object({
  title: titleField,
  body: bodyField.optional(),
  visibility: visibilityField.optional(),
});

const patchSectionSchema = z
  .object({
    title: titleField,
    body: bodyField,
    visibility: visibilityField,
  })
  .partial();

const createPlaceSchema = z.object({
  name: nameField,
  category: categoryField,
  note: noteField.optional(),
  mapUrl: mapUrlField.optional(),
});

const patchPlaceSchema = z
  .object({
    name: nameField,
    category: categoryField,
    note: noteField,
    mapUrl: mapUrlField,
  })
  .partial();

const orderSchema = z
  .array(idSchema, {
    error: "That order could not be read. Refresh the page and try again.",
  })
  .max(
    Math.max(MAX_SECTIONS, MAX_PLACES),
    "That is more than this house can hold. Refresh the page and try again.",
  );

const draftSchema = z.object({
  sections: z
    .array(
      z.object({
        title: titleField,
        body: bodyField,
        visibility: visibilityField,
      }),
    )
    .max(
      MAX_SECTIONS,
      `That draft has more than ${MAX_SECTIONS} sections. Cut some before you save it.`,
    ),
  places: z
    .array(
      z.object({
        name: nameField,
        category: categoryField,
        note: noteField,
        mapUrl: mapUrlField,
      }),
    )
    .max(
      MAX_PLACES,
      `That draft has more than ${MAX_PLACES} places. Cut some before you save it.`,
    ),
});

/* ============================================================
   ERRORS
   ============================================================ */

/** One message, one field — the same rule every other action here follows. */
function failure(error: z.ZodError, field?: string): ActionResult {
  const issue = error.issues[0];
  const message =
    issue?.message ?? "Something in that is not valid. Check it and try again.";
  const named =
    field ?? issue?.path.find((part): part is string => typeof part === "string");
  return named ? { ok: false, error: message, field: named } : { ok: false, error: message };
}

const NO_SECTION: ActionResult = {
  ok: false,
  error: "That section is not one of yours. Refresh the page and try again.",
};

const NO_PLACE: ActionResult = {
  ok: false,
  error: "That place is not one of yours. Refresh the page and try again.",
};

/* ============================================================
   HOUSEKEEPING
   ============================================================ */

/**
 * Everything a guide edit can be visible on.
 *
 * The owner's screens read it; `/h/[slug]` renders the public half; and
 * `/b/[token]` renders the guests-only half, which is why the whole route is
 * revalidated rather than one booking — the sections belong to the house, and
 * every confirmed guest is reading the same ones.
 */
function revalidateGuide(house: Pick<House, "slug">): void {
  revalidatePath("/app", "layout");
  revalidatePath(`/h/${house.slug}`);
  revalidatePath("/b/[token]", "page");
}

/**
 * The next free position at the end of a list.
 *
 * Sections are positioned within their own half, so moving one across keeps it
 * at the end of where it landed rather than dropping it into the middle of the
 * other list at whatever number it happened to hold.
 */
async function nextSectionPosition(
  houseId: string,
  visibility: GuideVisibility,
): Promise<number> {
  const [row] = await db
    .select({
      next: sql<number>`coalesce(max(${guideSections.position}), -1) + 1`,
    })
    .from(guideSections)
    .where(
      and(
        eq(guideSections.houseId, houseId),
        eq(guideSections.visibility, visibility),
      ),
    );

  return Number(row?.next ?? 0);
}

async function nextPlacePosition(houseId: string): Promise<number> {
  const [row] = await db
    .select({ next: sql<number>`coalesce(max(${places.position}), -1) + 1` })
    .from(places)
    .where(eq(places.houseId, houseId));

  return Number(row?.next ?? 0);
}

/** The photos hanging off a row, so their files can go when the row does. */
async function photoPaths(column: "sectionId" | "placeId", id: string) {
  const rows = await db
    .select({ pathname: images.pathname })
    .from(images)
    .where(eq(images[column], id));
  return rows.map((row) => row.pathname);
}

/**
 * Write a whole list's positions in one statement.
 *
 * One `UPDATE`, not one per row: a dozen round trips to a database that is not
 * in this building is seconds of latency on a drag that has to feel instant,
 * and a single statement lands atomically so an order never half-saves.
 */
async function writeOrder(
  table: typeof guideSections | typeof places,
  houseId: string,
  order: string[],
): Promise<void> {
  const pairs = sql.join(
    order.map((id, position) => sql`(${id}::uuid, ${position}::integer)`),
    sql`, `,
  );

  await db.execute(sql`
    update ${table} as r
    set "position" = v.pos
    from (values ${pairs}) as v(id, pos)
    where r.id = v.id and r.house_id = ${houseId}::uuid
  `);
}

/** "The list you were sorting is not the list that is there now." */
const STALE: ActionResult = {
  ok: false,
  error: "The guide changed while you were sorting it. Refresh the page and try again.",
};

/** Is `order` exactly `known`, each id once? */
function sameSet(order: string[], known: string[]): boolean {
  const wanted = new Set(order);
  if (wanted.size !== order.length) return false;
  if (wanted.size !== known.length) return false;
  return known.every((id) => wanted.has(id));
}

/* ============================================================
   SECTIONS
   ============================================================ */

/**
 * Add a section to the end of its half of the guide.
 *
 * A new section is **guests-only** unless the caller says otherwise. That is
 * the safe direction: a section the owner meant to be public but forgot to
 * flip is a missing paragraph on the house page, and a section they meant to
 * keep private but forgot to flip is the door code in a WhatsApp group.
 */
export async function createSection(input: SectionInput): Promise<ActionResult> {
  const house = await requireHouse();

  const parsed = createSectionSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error);

  const [held] = await db
    .select({ count: sql<number>`count(*)` })
    .from(guideSections)
    .where(eq(guideSections.houseId, house.id));

  if (Number(held?.count ?? 0) >= MAX_SECTIONS) {
    return {
      ok: false,
      error: `The guide holds ${MAX_SECTIONS} sections. Delete one before you add another.`,
    };
  }

  const visibility = parsed.data.visibility ?? "guests";

  try {
    await db.insert(guideSections).values({
      houseId: house.id,
      title: parsed.data.title,
      body: parsed.data.body ?? "",
      visibility,
      position: await nextSectionPosition(house.id, visibility),
    });
  } catch (error) {
    console.error("[createSection] insert failed", error);
    return { ok: false, error: "The section did not save. Try again in a moment." };
  }

  revalidateGuide(house);
  return { ok: true };
}

/**
 * Change a section. Whatever the patch mentions is written; the rest is left
 * alone.
 *
 * Visibility is not changeable here — {@link setSectionVisibility} owns that,
 * because moving a section across also has to move it to the end of the list it
 * lands in, and a partial update that quietly renumbers things is the kind of
 * surprise this editor does not need.
 */
export async function updateSection(
  id: string,
  patch: SectionPatch,
): Promise<ActionResult> {
  const house = await requireHouse();

  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return NO_SECTION;

  const parsed = patchSectionSchema.safeParse(patch);
  if (!parsed.success) return failure(parsed.error);

  const change: { title?: string; body?: string } = {};
  if (parsed.data.title !== undefined) change.title = parsed.data.title;
  if (parsed.data.body !== undefined) change.body = parsed.data.body;
  if (Object.keys(change).length === 0) return { ok: true };

  let written: { id: string }[];
  try {
    written = await db
      .update(guideSections)
      .set(change)
      .where(
        and(
          eq(guideSections.id, parsedId.data),
          eq(guideSections.houseId, house.id),
        ),
      )
      .returning({ id: guideSections.id });
  } catch (error) {
    console.error("[updateSection] update failed", error);
    return { ok: false, error: "The changes did not save. Try again in a moment." };
  }

  if (written.length === 0) return NO_SECTION;

  revalidateGuide(house);
  return { ok: true };
}

/**
 * Who reads a section: everyone with the link, or only a confirmed guest.
 *
 * The section moves to the end of the half it lands in. Its old position was a
 * place in a list it is no longer part of.
 */
export async function setSectionVisibility(
  id: string,
  visibility: GuideVisibility,
): Promise<ActionResult> {
  const house = await requireHouse();

  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return NO_SECTION;

  const parsed = visibilityField.safeParse(visibility);
  if (!parsed.success) return failure(parsed.error, "visibility");

  const [current] = await db
    .select({ visibility: guideSections.visibility })
    .from(guideSections)
    .where(
      and(eq(guideSections.id, parsedId.data), eq(guideSections.houseId, house.id)),
    )
    .limit(1);

  if (!current) return NO_SECTION;
  if (current.visibility === parsed.data) return { ok: true };

  try {
    await db
      .update(guideSections)
      .set({
        visibility: parsed.data,
        position: await nextSectionPosition(house.id, parsed.data),
      })
      .where(
        and(eq(guideSections.id, parsedId.data), eq(guideSections.houseId, house.id)),
      );
  } catch (error) {
    console.error("[setSectionVisibility] update failed", error);
    return { ok: false, error: "That did not save. Try again in a moment." };
  }

  revalidateGuide(house);
  return { ok: true };
}

/** The same thing said with one tap: public becomes guests-only and back. */
export async function toggleSectionVisibility(id: string): Promise<ActionResult> {
  const house = await requireHouse();

  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return NO_SECTION;

  const [current] = await db
    .select({ visibility: guideSections.visibility })
    .from(guideSections)
    .where(
      and(eq(guideSections.id, parsedId.data), eq(guideSections.houseId, house.id)),
    )
    .limit(1);

  if (!current) return NO_SECTION;

  return setSectionVisibility(
    parsedId.data,
    current.visibility === "public" ? "guests" : "public",
  );
}

/**
 * Delete a section, and the files behind any photos it carried.
 *
 * The row goes first and the files second. `remove()` never throws, so a store
 * having a bad afternoon leaves a file nobody points at — logged, recoverable.
 * The other order leaves a row pointing at nothing, which is a broken image on
 * a guest's arrival packet and much harder to notice.
 */
export async function deleteSection(id: string): Promise<ActionResult> {
  const house = await requireHouse();

  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return NO_SECTION;

  const paths = await photoPaths("sectionId", parsedId.data);

  let written: { id: string }[];
  try {
    written = await db
      .delete(guideSections)
      .where(
        and(eq(guideSections.id, parsedId.data), eq(guideSections.houseId, house.id)),
      )
      .returning({ id: guideSections.id });
  } catch (error) {
    console.error("[deleteSection] delete failed", error);
    return { ok: false, error: "The section did not delete. Try again in a moment." };
  }

  if (written.length === 0) return NO_SECTION;

  for (const pathname of paths) await remove(pathname);

  revalidateGuide(house);
  return { ok: true };
}

/**
 * Put one half of the guide in the given order.
 *
 * `orderedIds` has to be every section of that visibility, exactly once. A
 * partial list would leave the ones it omits holding stale positions and the
 * guide would come back in an order nobody chose; a list that no longer matches
 * means something changed in another tab, and the honest answer to that is to
 * say so rather than write half of it.
 */
export async function reorderSections(
  visibility: GuideVisibility,
  orderedIds: string[],
): Promise<ActionResult> {
  const house = await requireHouse();

  const parsedVisibility = visibilityField.safeParse(visibility);
  if (!parsedVisibility.success) return failure(parsedVisibility.error, "visibility");

  const parsedOrder = orderSchema.safeParse(orderedIds);
  if (!parsedOrder.success) return failure(parsedOrder.error);

  const known = await db
    .select({ id: guideSections.id })
    .from(guideSections)
    .where(
      and(
        eq(guideSections.houseId, house.id),
        eq(guideSections.visibility, parsedVisibility.data),
      ),
    );

  if (!sameSet(parsedOrder.data, known.map((row) => row.id))) return STALE;
  if (parsedOrder.data.length === 0) return { ok: true };

  try {
    await writeOrder(guideSections, house.id, parsedOrder.data);
  } catch (error) {
    console.error("[reorderSections] update failed", error);
    return { ok: false, error: "The new order did not save. Try again in a moment." };
  }

  revalidateGuide(house);
  return { ok: true };
}

/* ============================================================
   PLACES
   ============================================================ */

/** Add a place to the end of the list. */
export async function createPlace(input: PlaceInput): Promise<ActionResult> {
  const house = await requireHouse();

  const parsed = createPlaceSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error);

  const [held] = await db
    .select({ count: sql<number>`count(*)` })
    .from(places)
    .where(eq(places.houseId, house.id));

  if (Number(held?.count ?? 0) >= MAX_PLACES) {
    return {
      ok: false,
      error: `The guide holds ${MAX_PLACES} places. Delete one before you add another.`,
    };
  }

  try {
    await db.insert(places).values({
      houseId: house.id,
      name: parsed.data.name,
      category: parsed.data.category,
      note: parsed.data.note ?? null,
      mapUrl: parsed.data.mapUrl ?? null,
      position: await nextPlacePosition(house.id),
    });
  } catch (error) {
    console.error("[createPlace] insert failed", error);
    return { ok: false, error: "The place did not save. Try again in a moment." };
  }

  revalidateGuide(house);
  return { ok: true };
}

/** Change a place. Whatever the patch mentions is written. */
export async function updatePlace(
  id: string,
  patch: PlacePatch,
): Promise<ActionResult> {
  const house = await requireHouse();

  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return NO_PLACE;

  const parsed = patchPlaceSchema.safeParse(patch);
  if (!parsed.success) return failure(parsed.error);

  if (Object.keys(parsed.data).length === 0) return { ok: true };

  let written: { id: string }[];
  try {
    written = await db
      .update(places)
      .set(parsed.data)
      .where(and(eq(places.id, parsedId.data), eq(places.houseId, house.id)))
      .returning({ id: places.id });
  } catch (error) {
    console.error("[updatePlace] update failed", error);
    return { ok: false, error: "The changes did not save. Try again in a moment." };
  }

  if (written.length === 0) return NO_PLACE;

  revalidateGuide(house);
  return { ok: true };
}

/** Delete a place, and the files behind any photos it carried. */
export async function deletePlace(id: string): Promise<ActionResult> {
  const house = await requireHouse();

  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return NO_PLACE;

  const paths = await photoPaths("placeId", parsedId.data);

  let written: { id: string }[];
  try {
    written = await db
      .delete(places)
      .where(and(eq(places.id, parsedId.data), eq(places.houseId, house.id)))
      .returning({ id: places.id });
  } catch (error) {
    console.error("[deletePlace] delete failed", error);
    return { ok: false, error: "The place did not delete. Try again in a moment." };
  }

  if (written.length === 0) return NO_PLACE;

  for (const pathname of paths) await remove(pathname);

  revalidateGuide(house);
  return { ok: true };
}

/** Put the places in the given order. Every place, exactly once. */
export async function reorderPlaces(orderedIds: string[]): Promise<ActionResult> {
  const house = await requireHouse();

  const parsedOrder = orderSchema.safeParse(orderedIds);
  if (!parsedOrder.success) return failure(parsedOrder.error);

  const known = await db
    .select({ id: places.id })
    .from(places)
    .where(eq(places.houseId, house.id));

  if (!sameSet(parsedOrder.data, known.map((row) => row.id))) return STALE;
  if (parsedOrder.data.length === 0) return { ok: true };

  try {
    await writeOrder(places, house.id, parsedOrder.data);
  } catch (error) {
    console.error("[reorderPlaces] update failed", error);
    return { ok: false, error: "The new order did not save. Try again in a moment." };
  }

  revalidateGuide(house);
  return { ok: true };
}

/* ============================================================
   THE PASTED DRAFT
   ============================================================ */

/**
 * Save a draft the owner has already read.
 *
 * It **appends**: the sections and places arrive at the end of what is already
 * written, in the order they are given. Nothing existing is touched. A second
 * run of the prompt therefore leaves the owner with two of everything — one
 * delete each — rather than with a model's second opinion in place of their own
 * first one.
 *
 * Empty in, nothing done. That is not an error: the parser hands back an empty
 * draft for an empty paste, and there is nothing to tell anybody about.
 */
export async function saveGuideDraft(
  draft: GuideDraftInput,
): Promise<ActionResult> {
  const house = await requireHouse();

  const parsed = draftSchema.safeParse(draft);
  if (!parsed.success) return failure(parsed.error);

  const { sections, places: spots } = parsed.data;
  if (sections.length === 0 && spots.length === 0) return { ok: true };

  const [sectionCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(guideSections)
    .where(eq(guideSections.houseId, house.id));

  const [placeCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(places)
    .where(eq(places.houseId, house.id));

  if (Number(sectionCount?.count ?? 0) + sections.length > MAX_SECTIONS) {
    return {
      ok: false,
      error: `That would take the guide past ${MAX_SECTIONS} sections. Cut some of the draft, or delete a few first.`,
    };
  }

  if (Number(placeCount?.count ?? 0) + spots.length > MAX_PLACES) {
    return {
      ok: false,
      error: `That would take the guide past ${MAX_PLACES} places. Cut some of the draft, or delete a few first.`,
    };
  }

  // Each half keeps its own run of positions, so a draft that is all public
  // does not leave a gap in the guests-only list.
  const [nextPublic, nextGuests, nextPlace] = await Promise.all([
    nextSectionPosition(house.id, "public"),
    nextSectionPosition(house.id, "guests"),
    nextPlacePosition(house.id),
  ]);

  const cursor: Record<GuideVisibility, number> = {
    public: nextPublic,
    guests: nextGuests,
  };

  const sectionRows = sections.map((section) => ({
    houseId: house.id,
    title: section.title,
    body: section.body,
    visibility: section.visibility,
    position: cursor[section.visibility]++,
  }));

  const placeRows = spots.map((spot, index) => ({
    houseId: house.id,
    name: spot.name,
    category: spot.category,
    note: spot.note,
    mapUrl: spot.mapUrl,
    position: nextPlace + index,
  }));

  try {
    if (sectionRows.length > 0) {
      await db.insert(guideSections).values(sectionRows);
    }
    if (placeRows.length > 0) {
      await db.insert(places).values(placeRows);
    }
  } catch (error) {
    console.error("[saveGuideDraft] insert failed", error);
    return { ok: false, error: "The draft did not save. Try again in a moment." };
  }

  revalidateGuide(house);
  return { ok: true };
}

