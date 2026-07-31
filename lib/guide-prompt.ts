/**
 * The prompt the owner copies. **This app never calls a model.**
 *
 * That is a decision, not an omission. The owner already pays for ChatGPT or
 * Claude; asking them to paste one block of text into a window they already
 * have open costs this product nothing, needs no API key, adds no metered
 * dependency to a feature used once per house, and — the part that actually
 * matters — lets the person see the exact words being sent on their behalf.
 * There is no AI SDK in this repo and there must never be one. If you are here
 * to "just wire up a model call", the answer is no; see DECISIONS.md.
 *
 * So the loop is: this file writes a prompt → the owner pastes it into whatever
 * they use → they paste the reply back → `lib/guide-parse.ts` turns it into an
 * editable draft → they edit it → they save it. Nothing publishes itself.
 *
 * ### Why the prompt is this long
 *
 * Two jobs, and both of them are why a one-liner would not do.
 *
 * 1. **It has to be about *this* house.** A generic "write a guide to a Turkish
 *    seaside town" comes back as a travel blog. Seeded with the name, the town,
 *    the season and the owner's own blurb, it comes back mentioning the actual
 *    place, which is the entire reason to seed it.
 * 2. **It has to come back in a shape {@link parseGuideReply} can read.** The
 *    format below is designed for a parser, not for elegance: fixed markers on
 *    their own lines, `KEY: value` fields, one free-text field declared last.
 *    Models follow a shape they can see far better than one described to them,
 *    so the prompt shows it and then states the rules underneath.
 *
 * ### What it forbids
 *
 * Marketing voice, and invented fact. The first is a register problem — this
 * product is a note on a fridge, not a listing — and the second is a cost
 * problem: a draft full of plausible detail about rooms the model has never
 * seen takes longer to correct than it would have taken to write. The
 * guests-only half is the sharp case. The address, the key, the wifi and the
 * boiler are exactly what a model cannot know, so the prompt asks for those
 * sections as **titles with empty bodies** — a checklist for the owner rather
 * than six confident paragraphs of fiction.
 *
 * ### The prompt is English, the guide is not
 *
 * The owner dashboard is English-only in v1, and this text is read by the
 * owner. The *guide* is for guests, so the prompt names the house's language
 * and demands every title and sentence in it. A Turkish house gets a Turkish
 * guide out of an English request, which is a thing every model does well.
 */

import type { House, HouseLanguage } from "@/db/schema";
import { isDateStr } from "@/lib/dates";
import { t } from "@/lib/i18n";

/* ============================================================
   WHAT THE PROMPT NEEDS TO KNOW
   ============================================================ */

/**
 * The columns the prompt is seeded from — a `Pick`, not the whole row, so the
 * settings screen can preview a prompt for unsaved changes and a test does not
 * have to invent a `feedToken`.
 */
export type GuidePromptHouse = Pick<
  House,
  | "name"
  | "town"
  | "country"
  | "language"
  | "blurb"
  | "maxGuests"
  | "bookableFrom"
  | "bookableTo"
>;

/** What to call the house's language inside an English instruction. */
const LANGUAGE_NAME: Record<HouseLanguage, string> = {
  en: "English",
  tr: "Turkish",
};

/* ============================================================
   THE SEASON, IN WORDS
   ============================================================ */

/** The month a `YYYY-MM-DD` bound falls in, named in English, or null. */
function monthName(day: string | null): string | null {
  if (!day || !isDateStr(day)) return null;
  return t(`month.${Number(day.slice(5, 7))}`, "en");
}

/**
 * "June to September", "June onwards", "up to the end of September",
 * "all year".
 *
 * Months, not dates. Somebody writing about what a town is like in August
 * needs the shape of the season; the exact first bookable day is a rule the
 * calendar enforces and no part of a guide.
 */
function seasonLine(house: GuidePromptHouse): string {
  const from = monthName(house.bookableFrom);
  const to = monthName(house.bookableTo);

  if (from && to) return from === to ? from : `${from} to ${to}`;
  if (from) return `${from} onwards`;
  if (to) return `up to the end of ${to}`;
  return "all year";
}

/* ============================================================
   THE PROMPT
   ============================================================ */

/**
 * The whole prompt, ready to copy.
 *
 * Deterministic: the same house produces the same string every time, so a
 * screenshot in a support thread means something and a test can assert on it.
 * It ends with the format block, because the last thing in a prompt is the
 * thing a model follows most closely.
 */
export function buildGuidePrompt(house: GuidePromptHouse): string {
  const language = LANGUAGE_NAME[house.language];
  const town = house.town.trim();
  const blurb = house.blurb?.trim();

  const facts = [
    `Name: ${house.name.trim()}`,
    `Where: ${town}, ${house.country.trim()}`,
    `Open: ${seasonLine(house)}`,
    `Sleeps: ${house.maxGuests}`,
    blurb ? `How the owner describes it: ${blurb}` : null,
  ].filter((line): line is string => line !== null);

  return `Write a short guide to a summer house and the town it sits in. I am the owner. I will read every word and change what I want before anyone else sees it.

THE HOUSE
${facts.join("\n")}

Write the guide in ${language}. Every title, every sentence.

WHO READS IT
People I know — family, friends, friends of friends — who have been sent a link to the house. Not strangers, not customers. Nothing is for sale here and this is not a hotel.

HOW TO WRITE IT
- Plain sentences, the way you would write a note to a cousin.
- Two to four sentences per section. Shorter is better than longer.
- No sales voice. Never "nestled", "hidden gem", "stunning", "breathtaking", "a slice of paradise", "unwind", "escape", "must-see", "vibrant".
- No exclamation marks. No emoji. No headings other than the markers in the format below.
- Do not invent anything about the house. You have never been inside it. You do not know the rooms, the beds, the kitchen, the terrace, the view, the wifi or the boiler. Write about ${town} and leave the house to me.
- Only name a street, a beach or a business in ${town} if you are confident it is real. If you are not sure, describe the kind of place instead of naming it. Never invent opening hours, prices, phone numbers or addresses.
- If you know little about ${town}, write less. A short guide that is true beats a long one that is invented.

WHAT TO WRITE
Four to seven public sections, four to six guests-only sections, and five to eight places.

PUBLIC SECTIONS (VISIBILITY: public) are read by anyone holding the link, before they ask for a week. They help someone decide when to come: what ${town} is like, how it changes across the season, the sea and the weather, getting there and getting around, market day, what is worth bringing.

GUESTS-ONLY SECTIONS (VISIBILITY: guests) are read only by someone whose week is already confirmed. They are the practical things only I know, so write the TITLE and leave the BODY empty. You cannot know these and you must not guess at them. Give me the list to fill in myself: finding the house, the key, the wifi, the water and the boiler, the bins, who to call, what to do on the way out.

PLACES are single spots worth knowing — somewhere to eat, somewhere for a drink, a beach, a walk, a shop, something for children.

FORMAT
Reply with blocks in exactly this shape and nothing else. No preamble, no closing remarks, no code fence, no numbering, no bullet points.

[SECTION]
TITLE: a few words
VISIBILITY: public
BODY:
The text of the section. Plain paragraphs.
A blank line inside the body is fine.

[PLACE]
NAME: what it is called
CATEGORY: eat
NOTE: one sentence, or nothing
MAP:

[END]

RULES FOR THE FORMAT
- Keep [SECTION], [PLACE], [END], TITLE, VISIBILITY, BODY, NAME, CATEGORY, NOTE and MAP exactly as written above: English, capitals, on their own lines. Only what comes after the colon is written in ${language}.
- VISIBILITY is public or guests. Nothing else.
- CATEGORY is one of eat, drink, beach, walk, shop, kids. Nothing else. Pick the closest one.
- BODY: is the last field of a section. Everything after it is the body, up to the next [SECTION], [PLACE] or [END].
- A guests-only section has a TITLE and nothing under BODY:.
- Leave MAP empty. I paste my own links.
- Finish with [END] on its own line.`;
}
