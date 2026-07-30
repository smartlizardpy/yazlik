"use server";

/**
 * Everything that writes to `houses`.
 *
 * Two actions: one that makes the owner's first (and, in v1, only) house, and
 * one that changes it. Both are `useActionState`-shaped — `(previousState,
 * payload)` — so a form can bind them directly and render the error beside the
 * field that caused it.
 *
 * The payload is a `FormData` from a form, or a plain object when something
 * server-side calls the action itself. Both go through the same zod schema, so
 * there is one definition of what a valid house is.
 *
 * ### The contract a form has to keep
 *
 * - A key **absent** from the payload is left unchanged. That is what makes
 *   `updateHouse` a partial update.
 * - An **empty string** clears a field that is allowed to be empty: `blurb`,
 *   `bookableFrom`, `bookableTo`.
 * - `showGuestNames` needs an explicit `"true"` or `"false"`. An unchecked
 *   checkbox sends nothing at all, and nothing means "unchanged" here — so pair
 *   the checkbox with a hidden input, or submit the value from client state.
 * - On failure, `field` is the input's `name`. Keep the `name` attributes equal
 *   to the keys below and errors land in the right place with no mapping table.
 */

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { houses, type HouseLanguage } from "@/db/schema";
import { compareDates, isDateStr } from "@/lib/dates";
import { newSlug, newToken } from "@/lib/ids";
import { getOwnerHouse, requireOwner } from "@/lib/session";

/* ============================================================
   RESULT SHAPE
   ============================================================ */

/**
 * What every action here returns. `field` names the input to attach the message
 * to; without it the message belongs to the form as a whole.
 */
export type ActionResult =
  | { ok: true }
  | { ok: false; error: string; field?: string };

/** `useActionState` starts at `null` — nothing has been submitted yet. */
export type HouseFormState = ActionResult | null;

/** The three things you cannot guess about a house. */
export type CreateHouseInput = {
  name: string;
  town: string;
  country: string;
};

/** Every settings field. Omit a key to leave it alone. */
export type UpdateHouseInput = {
  name?: string;
  town?: string;
  country?: string;
  language?: HouseLanguage;
  blurb?: string | null;
  minNights?: number;
  maxNights?: number;
  gapDays?: number;
  maxGuests?: number;
  bookableFrom?: string | null;
  bookableTo?: string | null;
  showGuestNames?: boolean;
};

/* ============================================================
   READING THE PAYLOAD
   ============================================================ */

type Payload = FormData | Record<string, unknown>;

/** `undefined` means the caller did not mention this field. */
function readField(source: Payload, key: string): unknown {
  if (source instanceof FormData) {
    if (!source.has(key)) return undefined;
    const value = source.get(key);
    // A File can never be a house field; treat it as if it were not sent.
    return typeof value === "string" ? value : undefined;
  }
  return source[key];
}

/** Only the keys the caller actually sent, so "absent" survives into zod. */
function pick(source: Payload, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const value = readField(source, key);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/* ============================================================
   FIELD SCHEMAS
   ============================================================ */

const trimmed = (value: unknown) => (typeof value === "string" ? value.trim() : value);

/** `""` and whitespace mean "empty", which for these fields means NULL. */
const emptyToNull = (value: unknown) => {
  if (typeof value !== "string") return value;
  const text = value.trim();
  return text === "" ? null : text;
};

/** Forms send strings; code sends numbers. NaN falls through to the type error. */
const toNumber = (value: unknown) => {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (text === "") return Number.NaN;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const toBoolean = (value: unknown) => {
  if (typeof value !== "string") return value;
  const text = value.trim().toLowerCase();
  if (text === "true" || text === "on" || text === "1" || text === "yes") return true;
  if (text === "false" || text === "off" || text === "0" || text === "no") return false;
  return value;
};

function requiredText(max: number, blank: string, tooLong: string) {
  return z.preprocess(trimmed, z.string({ error: blank }).min(1, blank).max(max, tooLong));
}

function count(options: {
  min: number;
  max: number;
  blank: string;
  fraction: string;
  tooLow: string;
  tooHigh: string;
}) {
  return z.preprocess(
    toNumber,
    z
      .number({ error: options.blank })
      .int({ error: options.fraction })
      .min(options.min, options.tooLow)
      .max(options.max, options.tooHigh),
  );
}

/** A `YYYY-MM-DD` day, or NULL for "no bound". Same guard the rest of the app uses. */
function dayOrNull(malformed: string) {
  return z.preprocess(
    emptyToNull,
    z.string({ error: malformed }).refine(isDateStr, { error: malformed }).nullable(),
  );
}

const nameField = requiredText(
  80,
  "Name the house — whatever your family calls it.",
  "That name is too long. Keep it to 80 characters.",
);

const townField = requiredText(
  80,
  "Add the town, so guests know where they are going.",
  "That town name is too long. Keep it to 80 characters.",
);

const countryField = requiredText(
  80,
  "Add the country.",
  "That country name is too long. Keep it to 80 characters.",
);

const languageField = z.enum(["en", "tr"], {
  error: "Pick the language your guests read.",
});

const blurbField = z.preprocess(
  emptyToNull,
  z
    .string()
    .max(600, "That description is too long. Keep it to 600 characters.")
    .nullable(),
);

const minNightsField = count({
  min: 1,
  max: 365,
  blank: "Enter the shortest stay, in nights.",
  fraction: "Count the shortest stay in whole nights.",
  tooLow: "A stay has to be at least one night.",
  tooHigh: "Keep the shortest stay to 365 nights or fewer.",
});

const maxNightsField = count({
  min: 1,
  max: 365,
  blank: "Enter the longest stay, in nights.",
  fraction: "Count the longest stay in whole nights.",
  tooLow: "The longest stay has to be at least one night.",
  tooHigh: "Keep the longest stay to 365 nights or fewer.",
});

const gapDaysField = count({
  min: 0,
  max: 7,
  blank: "Enter the gap between stays, in days.",
  fraction: "Count the gap in whole days.",
  tooLow: "A gap cannot be negative. Use 0 to allow a same-day changeover.",
  tooHigh: "Keep the gap to 7 days or fewer.",
});

const maxGuestsField = count({
  min: 1,
  max: 99,
  blank: "Enter how many guests the house sleeps.",
  fraction: "Count guests in whole people.",
  tooLow: "The house has to sleep at least one guest.",
  tooHigh: "Keep the limit to 99 guests or fewer.",
});

const showGuestNamesField = z.preprocess(
  toBoolean,
  z.boolean({ error: "Choose whether guests see each other's names." }),
);

/* ============================================================
   SCHEMAS
   ============================================================ */

const CREATE_FIELDS = ["name", "town", "country"] as const;

const createSchema = z.object({
  name: nameField,
  town: townField,
  country: countryField,
});

const UPDATE_FIELDS = [
  "name",
  "town",
  "country",
  "language",
  "blurb",
  "minNights",
  "maxNights",
  "gapDays",
  "maxGuests",
  "bookableFrom",
  "bookableTo",
  "showGuestNames",
] as const;

// Declaration order is error order: zod reports issues in key order, and the
// first one is what the form shows. This is the order the settings screen reads.
const updateSchema = z
  .object({
    name: nameField,
    town: townField,
    country: countryField,
    language: languageField,
    blurb: blurbField,
    minNights: minNightsField,
    maxNights: maxNightsField,
    gapDays: gapDaysField,
    maxGuests: maxGuestsField,
    bookableFrom: dayOrNull(
      "Write the first day of the season as a date, like 2026-06-01.",
    ),
    bookableTo: dayOrNull(
      "Write the last day of the season as a date, like 2026-09-30.",
    ),
    showGuestNames: showGuestNamesField,
  })
  .partial();

/**
 * The cross-field rules, checked against the *merged* house rather than the
 * patch. Raising `maxNights` alone still has to clear the `minNights` already
 * stored, and that comparison is impossible to make from the patch by itself.
 */
const rulesSchema = z
  .object({
    minNights: z.number().int().min(1, "A stay has to be at least one night."),
    maxNights: z
      .number()
      .int()
      .min(1, "The longest stay has to be at least one night."),
    gapDays: z
      .number()
      .int()
      .min(0, "A gap cannot be negative. Use 0 to allow a same-day changeover.")
      .max(7, "Keep the gap to 7 days or fewer."),
    maxGuests: z
      .number()
      .int()
      .min(1, "The house has to sleep at least one guest."),
    bookableFrom: z.string().nullable(),
    bookableTo: z.string().nullable(),
  })
  .refine((rules) => rules.maxNights >= rules.minNights, {
    error:
      "The longest stay is shorter than the shortest. Raise it, or lower the shortest stay.",
    path: ["maxNights"],
  })
  .refine(
    (rules) =>
      !rules.bookableFrom ||
      !rules.bookableTo ||
      compareDates(rules.bookableFrom, rules.bookableTo) <= 0,
    {
      error: "The season ends before it starts. Move the last day after the first.",
      path: ["bookableTo"],
    },
  );

/* ============================================================
   ERRORS
   ============================================================ */

/**
 * One message, one field. A form that shows every error at once is a wall of
 * red; showing the first thing to fix is how a person actually works through it.
 */
function failure(error: z.ZodError): ActionResult {
  const issue = error.issues[0];
  if (!issue) {
    return { ok: false, error: "Something in that form is not valid. Check it and try again." };
  }
  const field = issue.path.find((part): part is string => typeof part === "string");
  return field
    ? { ok: false, error: issue.message, field }
    : { ok: false, error: issue.message };
}

/** Postgres `unique_violation`. Only ever a slug or feed token drawing twice. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

/* ============================================================
   ACTIONS
   ============================================================ */

/**
 * Make the owner's house. One house per owner in v1, so a second attempt is
 * refused with a message rather than an exception.
 *
 * Everything except the name, town, and country takes its default from the
 * schema — the owner meets those in settings, not before they have a link.
 */
export async function createHouse(
  _previous: HouseFormState,
  payload: FormData | CreateHouseInput,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const parsed = createSchema.safeParse(pick(payload, CREATE_FIELDS));
  if (!parsed.success) return failure(parsed.error);

  if (await getOwnerHouse()) {
    return {
      ok: false,
      error: "You already have a house. Change its details in settings.",
    };
  }

  let created = false;
  let lastError: unknown = null;

  // A 12-character slug collides about as often as a meteor lands on the house,
  // but the fix is to draw again, so draw again.
  for (let attempt = 0; attempt < 3 && !created; attempt++) {
    try {
      await db.insert(houses).values({
        ownerId: owner.id,
        slug: newSlug(),
        feedToken: newToken(),
        name: parsed.data.name,
        town: parsed.data.town,
        country: parsed.data.country,
      });
      created = true;
    } catch (error) {
      lastError = error;
      if (!isUniqueViolation(error)) break;
    }
  }

  if (!created) {
    console.error("[createHouse] insert failed", lastError);
    return { ok: false, error: "The house did not save. Try again in a moment." };
  }

  revalidatePath("/app", "layout");
  // Throws, so nothing below runs — and nothing needs to.
  redirect("/app");
}

/**
 * Change the owner's house. Partial: whatever the payload mentions is written,
 * everything else keeps the value already stored.
 *
 * Ownership comes from the session, never from the payload — the house is
 * looked up by `ownerId`, so there is no id a caller could swap.
 */
export async function updateHouse(
  _previous: HouseFormState,
  payload: FormData | UpdateHouseInput,
): Promise<ActionResult> {
  const owner = await requireOwner();

  const patch = updateSchema.safeParse(pick(payload, UPDATE_FIELDS));
  if (!patch.success) return failure(patch.error);

  const house = await getOwnerHouse();
  if (!house) {
    return {
      ok: false,
      error: "You do not have a house yet. Add one, then change its settings.",
    };
  }

  // A form may carry the house id for its own bookkeeping. It is a check, never
  // the authority: the row was already chosen by the session's owner id.
  const claimedId = readField(payload, "houseId");
  if (typeof claimedId === "string" && claimedId !== house.id) {
    return { ok: false, error: "That house is not yours to change." };
  }

  const change = patch.data;
  const next = {
    name: change.name ?? house.name,
    town: change.town ?? house.town,
    country: change.country ?? house.country,
    language: change.language ?? house.language,
    blurb: change.blurb === undefined ? house.blurb : change.blurb,
    minNights: change.minNights ?? house.minNights,
    maxNights: change.maxNights ?? house.maxNights,
    gapDays: change.gapDays ?? house.gapDays,
    maxGuests: change.maxGuests ?? house.maxGuests,
    bookableFrom:
      change.bookableFrom === undefined ? house.bookableFrom : change.bookableFrom,
    bookableTo:
      change.bookableTo === undefined ? house.bookableTo : change.bookableTo,
    showGuestNames: change.showGuestNames ?? house.showGuestNames,
  };

  const rules = rulesSchema.safeParse(next);
  if (!rules.success) return failure(rules.error);

  try {
    await db
      .update(houses)
      .set(next)
      .where(and(eq(houses.id, house.id), eq(houses.ownerId, owner.id)));
  } catch (error) {
    console.error("[updateHouse] update failed", error);
    return { ok: false, error: "The changes did not save. Try again in a moment." };
  }

  // The header, the dashboard, and settings all read the house.
  revalidatePath("/app", "layout");
  // Name, town, blurb, and every booking rule are visible to guests.
  revalidatePath(`/h/${house.slug}`);

  return { ok: true };
}
