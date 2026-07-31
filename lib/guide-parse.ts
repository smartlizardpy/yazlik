/**
 * The other half of the copy-paste loop: turning what a model wrote back into
 * an editable draft.
 *
 * `lib/guide-prompt.ts` asks for a strict shape. This reads it. Nothing here
 * touches the database — it takes a string and returns a draft the owner edits
 * on screen before anything is saved.
 *
 * ### The one rule
 *
 * **Nothing is silently dropped.** A person has just waited for a model to
 * write six paragraphs about their town; losing one because a marker came back
 * bold, or because they pasted the sign-off along with it, is the worst thing
 * this file could do. Anything that does not fit a shape is kept verbatim and
 * handed back as one free-text section the owner can see, edit, or delete. An
 * ugly draft is a small problem. A missing paragraph is a betrayal of the two
 * minutes they just spent waiting for it.
 *
 * So this parser is forgiving on purpose. It survives a code fence around the
 * whole reply, a "Here's your guide:" preamble, a sign-off underneath, bold
 * markers, markdown headings, smart quotes, en-dashes standing in for empty
 * fields, Turkish field names, and blocks in any order.
 *
 * ### What it will not do
 *
 * Guess. A place with no name, or with a category that is not one of the six
 * the schema allows, is not turned into a plausible-looking row — its text goes
 * to the free-text section untouched. Inventing a category is a lie that
 * survives onto the guest's screen; a paragraph in the wrong box is something
 * the owner fixes in one tap.
 *
 * ### Two deliberate exceptions to "keep everything"
 *
 * - **A MAP value that is not an http(s) link is ignored.** That field is a URL
 *   the owner pastes, not prose; a dash or "n/a" in it is a placeholder, not
 *   something anyone wanted to read.
 * - **Prose is never rewritten.** Smart quotes and en-dashes inside a body come
 *   through exactly as they were written. Normalisation happens only where a
 *   value is being *matched* — a marker, a field name, a category — and where a
 *   short value is unwrapped, such as a title in quotation marks.
 *
 * ### Privacy leans one way
 *
 * A section whose VISIBILITY is missing or unreadable is drafted as
 * **guests-only**, and so is the free-text leftover. That is deliberate and it
 * is the safe direction: an unparsed blob can perfectly well contain the door
 * code, and a section wrongly kept private is an annoyance the owner fixes,
 * while a section wrongly made public is the one promise this product cannot
 * break. The owner reviews every section before any of it is saved either way.
 */

import type { GuideVisibility, PlaceCategory } from "@/db/schema";
import { DEFAULT_LANG, t, type Lang } from "@/lib/i18n";

/* ============================================================
   WHAT COMES OUT
   ============================================================ */

/** A section as drafted — no id, no position, nothing written yet. */
export type DraftSection = {
  title: string;
  body: string;
  visibility: GuideVisibility;
};

/** A place as drafted. `note` and `mapUrl` are null when there was none. */
export type DraftPlace = {
  name: string;
  category: PlaceCategory;
  note: string | null;
  mapUrl: string | null;
};

/**
 * The whole draft.
 *
 * `leftover` is the text that did not fit any shape. It is **also** the body of
 * the last entry in `sections`, so a caller that only knows about `sections`
 * still shows it to the owner and cannot lose it. `leftover` is handed back
 * separately so the editor can point at that one card and say what happened.
 */
export type GuideDraft = {
  sections: DraftSection[];
  places: DraftPlace[];
  leftover: string | null;
};

export type ParseGuideOptions = {
  /**
   * The house's language. Used for one thing: the title of the leftover
   * section, which is guest-facing the moment the owner saves it unedited.
   */
  lang?: Lang;
};

/* ============================================================
   NORMALISING — for matching only, never for prose
   ============================================================ */

/** The combining dot `İ.toLowerCase()` leaves behind. */
const COMBINING_DOT = /\u0307/g;

/** BOM and the zero-width characters a copy-paste can carry in. */
const INVISIBLE = /[\uFEFF\u200B-\u200D]/g;

/**
 * Lower-cased, with both halves of the Turkish dotted-i problem flattened.
 *
 * JavaScript lower-cases without a locale, and Turkish has two i's:
 *
 * - `"İSİM".toLowerCase()` is `"i̇si̇m"` — an `i` followed by a combining dot.
 * - `"BAŞLIK".toLowerCase()` is `"başlik"` — a *dotted* i, because the dotless
 *   `ı` upper-cases to a plain `I` and comes back down as a plain `i`.
 *
 * Left alone, half the Turkish field names written in capitals miss their
 * lookup, which is the whole guide landing in the leftover section for a
 * Turkish house. Neither dot carries meaning to a table lookup, so both go.
 */
function fold(value: string): string {
  return value
    .toLowerCase()
    .replace(COMBINING_DOT, "")
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A lookup table with its keys folded the same way its values will be.
 *
 * Written once here rather than by hand at every entry, so a table can spell
 * `başlık` the way a Turk spells it and still match what `toLowerCase` does to
 * `BAŞLIK`.
 */
function folded<T>(table: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, value] of Object.entries(table)) out[fold(key)] = value;
  return out;
}

/** Both kinds of quote, both kinds of apostrophe, both guillemets. */
const OPENING = /^["'`‘’‚‛“”„‟«»]/;
const CLOSING = /["'`‘’‚‛“”„‟«»]$/;

/**
 * A value with its wrapping quotes taken off — and only wrapping ones.
 * `Ali'nin Yeri` keeps its apostrophe; `“Ali'nin Yeri”` loses its quotes.
 */
function unquote(value: string): string {
  let text = value.trim();
  while (text.length > 1 && OPENING.test(text) && CLOSING.test(text)) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

/** Markdown emphasis and heading marks around a short value. */
function undecorate(value: string): string {
  return unquote(
    value
      .trim()
      .replace(/^[*_#\s]+/, "")
      .replace(/[*_#\s]+$/, ""),
  );
}

/**
 * The things a model writes when it means "nothing here": a dash, a placeholder
 * word, an empty pair of brackets. All of them mean the field was left blank.
 */
const BLANKS = new Set(
  [
    "",
    "-",
    "--",
    "---",
    "–",
    "—",
    "_",
    "...",
    "…",
    "n/a",
    "na",
    "none",
    "null",
    "nil",
    "tbd",
    "empty",
    "(empty)",
    "[empty]",
    "yok",
    "bos",
    "boş",
  ].map(fold),
);

function isBlank(value: string): boolean {
  return BLANKS.has(fold(undecorate(value)));
}

/* ============================================================
   MARKERS
   ============================================================ */

type Marker = "section" | "place" | "end";

/** Written plainly, these are the markers the prompt asks for. */
const PLAIN_MARKERS: Record<string, Marker> = folded({
  section: "section",
  place: "place",
  end: "end",
});

/**
 * Turkish markers, accepted **only inside brackets**.
 *
 * The prompt tells the model to leave the markers in English, and most do. A
 * bare line reading `yer` is far more likely to be the end of a sentence than a
 * block marker, so the brackets are what make the Turkish forms safe to accept.
 */
const BRACKETED_MARKERS: Record<string, Marker> = folded({
  ...PLAIN_MARKERS,
  bolum: "section",
  "bölüm": "section",
  kisim: "section",
  "kısım": "section",
  yer: "place",
  mekan: "place",
  "mekân": "place",
  son: "end",
  bitti: "end",
});

/**
 * Is this line a block marker, and which?
 *
 * Everything a model might dress a marker in comes off first: `##`, `**`, `>`,
 * a trailing colon, a run of dashes on either side. What is left has to be one
 * word, optionally in brackets.
 */
function markerOf(line: string): Marker | null {
  const bare = line
    .trim()
    .replace(/^[>#*_\-–—\s]+/, "")
    .replace(/[*_#.:\-–—\s]+$/, "")
    .trim();

  if (!bare) return null;

  const bracketed = /^\[\s*(.+?)\s*\]$/.exec(bare);
  const word = fold(bracketed ? bracketed[1] : bare);

  return (bracketed ? BRACKETED_MARKERS[word] : PLAIN_MARKERS[word]) ?? null;
}

/* ============================================================
   FIELDS
   ============================================================ */

type Field =
  | "title"
  | "visibility"
  | "body"
  | "name"
  | "category"
  | "note"
  | "map";

/**
 * Field names, English and Turkish.
 *
 * These are safe to accept unbracketed because a field line has to put its name
 * at the very start and end it with a colon, and the name has to be one of
 * these exactly. A body sentence that happens to contain a colon does not
 * match, and a line whose key is not in here is treated as prose — never thrown
 * away.
 */
const FIELDS: Record<string, Field> = folded({
  title: "title",
  heading: "title",
  "başlık": "title",
  baslik: "title",

  visibility: "visibility",
  who: "visibility",
  "görünürlük": "visibility",
  gorunurluk: "visibility",
  kim: "visibility",
  kimler: "visibility",

  body: "body",
  text: "body",
  metin: "body",
  "içerik": "body",
  icerik: "body",

  name: "name",
  ad: "name",
  isim: "name",
  "adı": "name",
  adi: "name",

  category: "category",
  kategori: "category",
  "tür": "category",
  tur: "category",

  note: "note",
  not: "note",
  "açıklama": "note",
  aciklama: "note",

  map: "map",
  "map url": "map",
  mapurl: "map",
  link: "map",
  harita: "map",
  "bağlantı": "map",
  baglanti: "map",
});

/** `TITLE: something`, `**Not:** bir cümle`, `- name: x`. */
const FIELD_LINE = /^[\s>*_#-]*([\p{L}][\p{L} ]{0,23})[\s*_]*[:：]\s?(.*)$/u;

type FieldLine = { field: Field; value: string };

function fieldOf(line: string): FieldLine | null {
  const match = FIELD_LINE.exec(line);
  if (!match) return null;
  const field = FIELDS[fold(match[1])];
  return field ? { field, value: match[2] } : null;
}

/* ============================================================
   ENUMS
   ============================================================ */

const VISIBILITIES: Record<string, GuideVisibility> = folded({
  public: "public",
  everyone: "public",
  anyone: "public",
  all: "public",
  open: "public",
  herkes: "public",
  "herkese açık": "public",
  "açık": "public",
  acik: "public",
  genel: "public",

  guests: "guests",
  guest: "guests",
  "guests only": "guests",
  "guest only": "guests",
  private: "guests",
  misafir: "guests",
  misafirler: "guests",
  "sadece misafirler": "guests",
  "özel": "guests",
  ozel: "guests",
  gizli: "guests",
});

const CATEGORIES: Record<string, PlaceCategory> = folded({
  eat: "eat",
  food: "eat",
  restaurant: "eat",
  dinner: "eat",
  lunch: "eat",
  breakfast: "eat",
  yemek: "eat",
  restoran: "eat",
  lokanta: "eat",
  "kahvaltı": "eat",
  kahvalti: "eat",

  drink: "drink",
  drinks: "drink",
  bar: "drink",
  cafe: "drink",
  "café": "drink",
  coffee: "drink",
  "içecek": "drink",
  icecek: "drink",
  kahve: "drink",
  meyhane: "drink",

  beach: "beach",
  beaches: "beach",
  swim: "beach",
  swimming: "beach",
  sea: "beach",
  plaj: "beach",
  deniz: "beach",
  koy: "beach",

  walk: "walk",
  walks: "walk",
  walking: "walk",
  hike: "walk",
  hiking: "walk",
  "yürüyüş": "walk",
  yuruyus: "walk",
  gezi: "walk",
  "doğa": "walk",
  doga: "walk",

  shop: "shop",
  shops: "shop",
  shopping: "shop",
  market: "shop",
  grocery: "shop",
  "alışveriş": "shop",
  alisveris: "shop",
  pazar: "shop",
  bakkal: "shop",
  manav: "shop",

  kids: "kids",
  kid: "kids",
  children: "kids",
  child: "kids",
  family: "kids",
  "çocuk": "kids",
  cocuk: "kids",
  "çocuklar": "kids",
  aile: "kids",
});

/**
 * Look a value up in a table, whole first and then word by word.
 *
 * Whole-value first so `guests only` beats its own first word. Word by word
 * after that, so `CATEGORY: eat (food)` and `VISIBILITY: public — anyone with
 * the link` still land somewhere sensible instead of nowhere.
 */
function lookup<T>(table: Record<string, T>, value: string): T | null {
  const whole = fold(undecorate(value));
  if (table[whole]) return table[whole];

  for (const word of whole.split(/[^\p{L}]+/u)) {
    if (word && table[word]) return table[word];
  }
  return null;
}

/* ============================================================
   THE MAP LINK
   ============================================================ */

const BARE_URL = /^https?:\/\/\S+$/i;
const MARKDOWN_LINK = /^\[[^\]]*\]\((https?:\/\/[^)\s]+)\)$/i;
const ANGLED = /^<(https?:\/\/[^>\s]+)>$/i;

/**
 * A link, or null. Never prose.
 *
 * The prompt tells the model to leave MAP empty, so nearly every reply has a
 * blank here. A model that ignores that and writes a link is taken at its word;
 * one that writes "search for it on Google Maps" is not.
 */
function mapUrlOf(value: string): string | null {
  const written = undecorate(value);
  if (!written || isBlank(written)) return null;

  const markdown = MARKDOWN_LINK.exec(written) ?? ANGLED.exec(written);
  if (markdown) return markdown[1];

  return BARE_URL.test(written) ? written : null;
}

/* ============================================================
   CUTTING THE REPLY UP
   ============================================================ */

/** A run of lines: a block if it had a marker, loose text if it did not. */
type Chunk = { marker: Marker | null; lines: string[] };

/** A fence line: ``` or ~~~, with or without a language after it. */
const FENCE = /^\s*(?:```|~~~)\s*[\p{L}]*\s*$/u;

/**
 * The reply, cut into chunks in the order they were written.
 *
 * Line endings are normalised and code fences are dropped — a fenced reply is
 * the single most common way a model ignores "no code fence", and the fence
 * itself is not content. Everything else is left exactly as it was typed.
 *
 * `[END]` closes the block it follows and opens a loose chunk, rather than
 * stopping the read. A model that helpfully puts `[END]` after *every* block
 * would otherwise lose everything past the first one, and losing things is the
 * one thing this file does not do.
 */
function chunks(reply: string): Chunk[] {
  const lines = reply
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !FENCE.test(line));

  const out: Chunk[] = [];
  let current: Chunk = { marker: null, lines: [] };
  out.push(current);

  for (const line of lines) {
    const marker = markerOf(line);

    if (marker === null) {
      current.lines.push(line);
      continue;
    }

    // `[END]` opens loose text; the other two open a block. Either way the
    // marker line itself is scaffolding and is not kept.
    current = { marker: marker === "end" ? null : marker, lines: [] };
    out.push(current);
  }

  return out;
}

/* ============================================================
   READING ONE BLOCK
   ============================================================ */

/** Trim blank lines off both ends without touching the ones in the middle. */
function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start += 1;
  while (end > start && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(start, end);
}

function text(lines: string[]): string {
  return trimBlankLines(lines).join("\n");
}

/**
 * A section, or null if there was no title to hang one on.
 *
 * `BODY:` ends the field-reading: everything after it is prose, so a body line
 * that happens to read `Wifi: yazlik2026` stays in the body instead of being
 * mistaken for a field. Lines before the body that are not fields are prose in
 * the wrong place — they are kept, above the body, rather than discarded.
 *
 * A section with no body is not a failure. The prompt asks for exactly that:
 * the guests-only half comes back as titles the owner fills in, because those
 * are the facts a model cannot know.
 */
function readSection(lines: string[]): DraftSection | null {
  let title: string | null = null;
  let visibility: GuideVisibility | null = null;
  const strays: string[] = [];
  const body: string[] = [];

  let inBody = false;

  for (const line of lines) {
    if (inBody) {
      body.push(line);
      continue;
    }

    const field = fieldOf(line);

    if (!field) {
      if (line.trim() !== "") strays.push(line);
      continue;
    }

    switch (field.field) {
      case "title":
        title = undecorate(field.value);
        break;
      case "visibility":
        visibility = lookup(VISIBILITIES, field.value);
        break;
      case "body":
        inBody = true;
        if (field.value.trim() !== "") body.push(field.value);
        break;
      default:
        // A place's field inside a section block. Not a field of this shape,
        // so as far as this block is concerned it is prose.
        strays.push(line);
    }
  }

  if (!title) return null;

  return {
    title,
    body: text([...strays, ...body]),
    // Missing or unreadable leans private. See the note at the top of the file.
    visibility: visibility ?? "guests",
  };
}

/**
 * A place, or null when it is missing one of the two things that cannot be
 * guessed at.
 *
 * A name and a category are the whole row: without a name there is nothing to
 * show, and the category is an enum the guest page groups by. Neither is worth
 * inventing, so a block missing either is handed back to the caller to keep as
 * text.
 */
function readPlace(lines: string[]): DraftPlace | null {
  let name: string | null = null;
  let category: PlaceCategory | null = null;
  let mapUrl: string | null = null;
  const note: string[] = [];

  for (const line of lines) {
    const field = fieldOf(line);

    if (!field) {
      if (line.trim() !== "") note.push(line);
      continue;
    }

    switch (field.field) {
      case "name":
      case "title":
        name = undecorate(field.value);
        break;
      case "category":
        category = lookup(CATEGORIES, field.value);
        break;
      case "map":
        mapUrl = mapUrlOf(field.value);
        break;
      case "note":
      case "body":
        if (!isBlank(field.value)) note.push(undecorate(field.value));
        break;
      default:
        note.push(line);
    }
  }

  if (!name || !category) return null;

  const written = text(note);

  return { name, category, note: written === "" ? null : written, mapUrl };
}

/* ============================================================
   THE PARSER
   ============================================================ */

/** Three or more blank lines collapse to one gap. Nothing else is touched. */
function tidy(pieces: string[]): string {
  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece !== "")
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A pasted reply, read into a draft.
 *
 * Order is preserved: sections come back in the order they were written, and so
 * do places. Positions are the caller's business — `saveGuideDraft` assigns
 * them when the owner saves.
 *
 * An empty paste is an empty draft: no error, no leftover section, nothing to
 * lose and nothing to show.
 */
export function parseGuideReply(
  reply: string,
  options: ParseGuideOptions = {},
): GuideDraft {
  const lang = options.lang ?? DEFAULT_LANG;

  if (typeof reply !== "string" || reply.trim() === "") {
    return { sections: [], places: [], leftover: null };
  }

  const sections: DraftSection[] = [];
  const places: DraftPlace[] = [];
  /** Everything that could not be made into a row, in the order it was written. */
  const orphans: string[] = [];

  for (const chunk of chunks(reply)) {
    const lines = trimBlankLines(chunk.lines);
    if (lines.length === 0) continue;

    if (chunk.marker === null) {
      orphans.push(text(lines));
      continue;
    }

    if (chunk.marker === "section") {
      const section = readSection(lines);
      if (section) sections.push(section);
      // The marker line is not kept with it: the owner is being shown the
      // words, not the shape they failed to fit.
      else orphans.push(text(lines));
      continue;
    }

    const place = readPlace(lines);
    if (place) places.push(place);
    else orphans.push(text(lines));
  }

  const leftover = tidy(orphans);
  if (leftover === "") {
    return { sections, places, leftover: null };
  }

  // Last, so a good draft reads top to bottom and the odd bit is at the end
  // where the owner deletes it. Private, because nobody has read it yet.
  sections.push({
    title: t("guide.leftover.title", lang),
    body: leftover,
    visibility: "guests",
  });

  return { sections, places, leftover };
}
