/**
 * Reads against `guide_sections` and `places`.
 *
 * ### The split is a query, not a class name
 *
 * The guide has two halves. The public half — the town, the walk to the water,
 * where to eat — is for anyone holding the house link, and helps them decide
 * *when* to come. The guests-only half — the address, the lockbox code, the
 * wifi, which tap is temperamental — is for someone whose week is already
 * confirmed, and nobody else.
 *
 * That promise is kept by **not selecting** the guests-only rows on the public
 * path. Not by a CSS class, not by a filter in the component, not by a flag on
 * a shared object that some future page forgets to check: the rows are never in
 * the process. `app/b/[token]/page.tsx` already works this way for its arrival
 * packet, and this file exists so the rest of the app cannot do it any other
 * way.
 *
 * So there is no `guide(houseId, visibility)`. {@link publicGuide} can only
 * return public rows and {@link guestsOnlySections} can only return private
 * ones, because a caller that can pass the visibility in is a caller that can
 * pass the wrong one. {@link ownerGuide} does return both — the owner is
 * editing their own guide — and it is the only function here that a page under
 * `/app` should reach for.
 *
 * ### Places have no visibility, and that is on purpose
 *
 * A place is a restaurant or a beach: a public fact about a town that anyone
 * can look up. There is no column to hide one and there should not be. Anything
 * private about a place — "the blue gate is ours, the one before the café" —
 * belongs in a guests-only *section*.
 *
 * Nothing in this file writes. Mutations live in `app/_actions/guide.ts`.
 */

import { and, asc, eq, inArray, or } from "drizzle-orm";

import { db } from "@/db";
import {
  guideSections,
  images,
  places,
  type GuideVisibility,
  type PlaceCategory,
} from "@/db/schema";

/* ============================================================
   WHAT A PAGE RENDERS
   ============================================================ */

/** A photo hanging off a section or a place. */
export type GuidePhoto = {
  id: string;
  url: string;
  alt: string | null;
};

export type GuideSectionView = {
  id: string;
  title: string;
  body: string;
  position: number;
  visibility: GuideVisibility;
  photos: GuidePhoto[];
};

export type PlaceView = {
  id: string;
  name: string;
  category: PlaceCategory;
  note: string | null;
  mapUrl: string | null;
  position: number;
  photos: GuidePhoto[];
};

/** The half of the guide a public page renders. */
export type PublicGuide = {
  sections: GuideSectionView[];
  places: PlaceView[];
};

/** Everything, for the owner's own editor. */
export type OwnerGuide = {
  publicSections: GuideSectionView[];
  guestsSections: GuideSectionView[];
  places: PlaceView[];
};

/* ============================================================
   PHOTOS
   ============================================================ */

type PhotoRow = GuidePhoto & {
  sectionId: string | null;
  placeId: string | null;
};

/**
 * The photos belonging to rows that have already been selected.
 *
 * Keyed on the ids the caller just fetched, never on the house alone. A photo
 * can only come back if its section or its place already did, so an image row
 * has no way to disagree with the sections about what a guest may see. With
 * nothing to key on there is no query at all — `where(houseId)` with both
 * `inArray`s dropped would quietly return the whole house's photographs,
 * guests-only ones included, which is precisely the leak this file exists to
 * make impossible.
 */
async function photosFor(
  houseId: string,
  sectionIds: string[],
  placeIds: string[],
): Promise<PhotoRow[]> {
  if (sectionIds.length === 0 && placeIds.length === 0) return [];

  const owners = [
    sectionIds.length > 0 ? inArray(images.sectionId, sectionIds) : undefined,
    placeIds.length > 0 ? inArray(images.placeId, placeIds) : undefined,
  ].filter((clause) => clause !== undefined);

  return db
    .select({
      id: images.id,
      url: images.url,
      alt: images.alt,
      sectionId: images.sectionId,
      placeId: images.placeId,
    })
    .from(images)
    .where(and(eq(images.houseId, houseId), or(...owners)))
    .orderBy(asc(images.position), asc(images.createdAt));
}

function photosOfSection(photos: PhotoRow[], sectionId: string): GuidePhoto[] {
  return photos
    .filter((photo) => photo.sectionId === sectionId)
    .map(({ id, url, alt }) => ({ id, url, alt }));
}

function photosOfPlace(photos: PhotoRow[], placeId: string): GuidePhoto[] {
  return photos
    .filter((photo) => photo.placeId === placeId)
    .map(({ id, url, alt }) => ({ id, url, alt }));
}

/* ============================================================
   ROWS
   ============================================================ */

/**
 * Sections of one visibility, in the order the owner put them.
 *
 * Private to this file. The exported functions each bind the visibility
 * themselves, which is what stops a caller choosing it.
 *
 * `position` then `title` — a house whose sections all sit at position 0,
 * because nobody has dragged anything yet, still comes back in a stable order
 * rather than in whatever order the planner felt like.
 */
async function sectionRows(houseId: string, visibility: GuideVisibility) {
  return db
    .select({
      id: guideSections.id,
      title: guideSections.title,
      body: guideSections.body,
      position: guideSections.position,
      visibility: guideSections.visibility,
    })
    .from(guideSections)
    .where(
      and(
        eq(guideSections.houseId, houseId),
        eq(guideSections.visibility, visibility),
      ),
    )
    .orderBy(asc(guideSections.position), asc(guideSections.title));
}

async function placeRows(houseId: string) {
  return db
    .select({
      id: places.id,
      name: places.name,
      category: places.category,
      note: places.note,
      mapUrl: places.mapUrl,
      position: places.position,
    })
    .from(places)
    .where(eq(places.houseId, houseId))
    .orderBy(asc(places.position), asc(places.name));
}

/* ============================================================
   THE PUBLIC HALF
   ============================================================ */

/**
 * What `/h/[slug]` renders: the public sections and every place.
 *
 * A guests-only section cannot come out of here. There is no argument that
 * would make it, and adding one would be the bug.
 */
export async function publicGuide(houseId: string): Promise<PublicGuide> {
  const [sections, spots] = await Promise.all([
    sectionRows(houseId, "public"),
    placeRows(houseId),
  ]);

  const photos = await photosFor(
    houseId,
    sections.map((section) => section.id),
    spots.map((spot) => spot.id),
  );

  return {
    sections: sections.map((section) => ({
      ...section,
      photos: photosOfSection(photos, section.id),
    })),
    places: spots.map((spot) => ({
      ...spot,
      photos: photosOfPlace(photos, spot.id),
    })),
  };
}

/* ============================================================
   THE GUESTS-ONLY HALF
   ============================================================ */

/**
 * The arrival packet: the sections only a confirmed guest sees.
 *
 * **Call this only when the booking is confirmed.** The visibility filter is
 * the privacy split and the caller's status check is the lock on it; neither is
 * optional, and `/b/[token]` is the only page that has any business here.
 *
 * Places are not included. They are public by nature — see the note at the top
 * of this file — and a guest reads them on the house page like everybody else.
 */
export async function guestsOnlySections(
  houseId: string,
): Promise<GuideSectionView[]> {
  const sections = await sectionRows(houseId, "guests");
  if (sections.length === 0) return [];

  const photos = await photosFor(
    houseId,
    sections.map((section) => section.id),
    [],
  );

  return sections.map((section) => ({
    ...section,
    photos: photosOfSection(photos, section.id),
  }));
}

/* ============================================================
   BOTH HALVES, FOR THE PERSON WHO WROTE THEM
   ============================================================ */

/**
 * Everything, for the owner's editor.
 *
 * The two halves stay in separate arrays rather than one list with a flag,
 * because the screen that renders this has to show the split — which of these
 * paragraphs the whole family can read, and which of them only reach someone
 * who has been given a week. A single sorted list with a badge on some of the
 * rows is how that distinction stops being visible.
 *
 * Only ever behind `requireOwner`/`requireHouse`, and only ever with the
 * owner's own `houseId`.
 */
export async function ownerGuide(houseId: string): Promise<OwnerGuide> {
  const [publicSections, guestsSections, spots] = await Promise.all([
    sectionRows(houseId, "public"),
    sectionRows(houseId, "guests"),
    placeRows(houseId),
  ]);

  const photos = await photosFor(
    houseId,
    [...publicSections, ...guestsSections].map((section) => section.id),
    spots.map((spot) => spot.id),
  );

  const withPhotos = (section: (typeof publicSections)[number]) => ({
    ...section,
    photos: photosOfSection(photos, section.id),
  });

  return {
    publicSections: publicSections.map(withPhotos),
    guestsSections: guestsSections.map(withPhotos),
    places: spots.map((spot) => ({
      ...spot,
      photos: photosOfPlace(photos, spot.id),
    })),
  };
}
