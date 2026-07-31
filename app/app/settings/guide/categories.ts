/**
 * What the six place categories are called on the owner's own screen.
 *
 * The owner dashboard is English only, so these are literals rather than
 * dictionary keys — but they are deliberately the same sentences the guest
 * page prints over each group (`guide.places.*` in `lib/i18n/en.json`). The
 * owner is choosing which heading a place will sit under, so the picker should
 * offer the headings, not the enum: "To eat" is where it lands, "eat" is what
 * the column holds.
 *
 * The order is fixed and is the order both screens group by. It runs the way a
 * day does — a meal, a drink, the sea, a walk, an errand, the children — rather
 * than alphabetically, which would open the list on "Beach" for no reason.
 */

import type { PlaceCategory } from "@/db/schema";

export const CATEGORY_ORDER = [
  "eat",
  "drink",
  "beach",
  "walk",
  "shop",
  "kids",
] as const satisfies readonly PlaceCategory[];

export const CATEGORY_LABEL: Record<PlaceCategory, string> = {
  eat: "To eat",
  drink: "For a drink",
  beach: "The water",
  walk: "Worth the walk",
  shop: "For what you need",
  kids: "With children",
};
