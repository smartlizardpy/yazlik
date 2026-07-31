/**
 * Two JSON dictionaries and a lookup. No i18n library.
 *
 * A house has a `language`, and that one field decides what the guest sees:
 * `/h/[slug]`, `/b/[token]`, and every email addressed to a guest. The owner
 * dashboard is English only in v1, so nothing under `/app` should reach for
 * this — if you are writing owner copy, just write the string.
 *
 * Three rules hold the whole thing together:
 *
 * 1. **A key is the fallback.** An unknown key renders as itself and warns in
 *    development. A blank space is how missing copy reaches production
 *    unnoticed; `house.calendar.hint` sitting in the middle of a page does not.
 * 2. **Both dictionaries carry every key, with the same placeholders.**
 *    `lib/bookings.test.ts` asserts this, so a half-translated string fails
 *    `pnpm test` rather than shipping.
 * 3. **Placeholders are `{named}`,** never positional, so a translator can move
 *    them around the sentence. Turkish word order is not English word order.
 */

import en from "@/lib/i18n/en.json";
import tr from "@/lib/i18n/tr.json";

import type { CheckFailureCode, HouseRules } from "@/lib/availability";
import { isDateStr, type DateStr } from "@/lib/dates";

/* ============================================================
   TYPES
   ============================================================ */

/** Matches `houses.language`. Adding a locale is a third JSON file. */
export type Lang = "en" | "tr";

/** Every key English defines. English is the reference dictionary. */
export type MessageKey = keyof typeof en;

/**
 * A key, with autocomplete for the ones that exist — but still a plain string,
 * so a screen that asks for a key nobody wrote yet renders the key instead of
 * failing the build at three in the morning. The test is where that gets caught.
 */
export type Key = MessageKey | (string & Record<never, never>);

export type Vars = Record<string, string | number>;

type Dictionary = Record<string, string>;

export const LANGS: readonly Lang[] = ["en", "tr"] as const;

const DICTIONARIES: Record<Lang, Dictionary> = { en, tr };

/** The default when a caller has no house to ask. */
export const DEFAULT_LANG: Lang = "en";

/** Narrow anything — a route param, a form value — to a language we ship. */
export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "tr";
}

/** Whatever `value` is, hand back a language. Unknown input falls back to English. */
export function toLang(value: unknown): Lang {
  return isLang(value) ? value : DEFAULT_LANG;
}

/** The raw dictionary. Exported for tests and for anything that needs to enumerate. */
export function dictionary(lang: Lang): Dictionary {
  return DICTIONARIES[lang];
}

/* ============================================================
   LOOKUP
   ============================================================ */

const PLACEHOLDER = /\{(\w+)\}/g;

/** Warned-about keys, so a render loop logs once rather than sixty times. */
const warned = new Set<string>();

function warn(message: string) {
  if (process.env.NODE_ENV === "production") return;
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[i18n] ${message}`);
}

/** A dictionary read that admits a key might not be there. */
function lookup(lang: Lang, key: string): string | undefined {
  const dict: Record<string, string | undefined> = DICTIONARIES[lang];
  return dict[key];
}

/**
 * The string for `key` in `lang`, with `{placeholders}` filled from `vars`.
 *
 * A missing key returns the key. A missing placeholder is left in the text,
 * both loudly enough to notice in development and harmlessly enough not to
 * blank out a page in production.
 */
export function t(key: Key, lang: Lang, vars?: Vars): string {
  // Falling back to English keeps a half-translated key readable rather than
  // raw. The test forbids that state existing, so this should never fire.
  const template = lookup(lang, key) ?? lookup(DEFAULT_LANG, key);

  if (template === undefined) {
    warn(`missing key "${key}"`);
    return key;
  }

  if (!vars) return template;

  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      warn(`missing "${name}" for key "${key}" (${lang})`);
      return whole;
    }
    return String(value);
  });
}

/**
 * A counted phrase: `tn("count.nights", 3, "tr")` → "3 gece".
 *
 * Two forms per key, `.one` and `.other`, chosen on `count === 1`. That covers
 * both languages here — Turkish keeps the noun singular after a number, so its
 * two forms are the same word and the rule still lands correctly.
 */
export function tn(key: Key, count: number, lang: Lang, vars?: Vars): string {
  const form = count === 1 ? "one" : "other";
  return t(`${key}.${form}`, lang, { count, ...vars });
}

/** `t` with the language already bound — handy at the top of a page component. */
export function translator(lang: Lang) {
  return (key: Key, vars?: Vars) => t(key, lang, vars);
}

/* ============================================================
   DATES
   ============================================================ */

/**
 * A `YYYY-MM-DD` day written out: `1 August 2026`, `1 Ağustos 2026`.
 *
 * Month names and the ordering both live in the dictionary, so a locale that
 * puts the year first needs no code. `lib/dates.formatDay` is the English-only
 * version used inside `lib/availability`; this is the one guests see.
 */
export function dayLabel(day: DateStr, lang: Lang): string {
  if (!isDateStr(day)) return day;
  const [year, month, date] = day.split("-");
  return t("format.day", lang, {
    day: Number(date),
    month: t(`month.${Number(month)}`, lang),
    year,
  });
}

/** Two days as one line: `1 August 2026 – 8 August 2026`. */
export function rangeLabel(start: DateStr, end: DateStr, lang: Lang): string {
  return t("format.range", lang, {
    from: dayLabel(start, lang),
    to: dayLabel(end, lang),
  });
}

/* ============================================================
   AVAILABILITY FAILURES
   ============================================================ */

/**
 * The key each `checkRequest` refusal maps to.
 *
 * Typed as a total `Record`, so adding a code to `CheckFailureCode` without
 * adding copy for it is a type error rather than a guest staring at
 * `error.somethingNew`.
 */
export const FAILURE_KEYS: Record<CheckFailureCode, MessageKey> = {
  END_BEFORE_START: "error.endBeforeStart",
  PAST: "error.past",
  TOO_SHORT: "error.tooShort",
  TOO_LONG: "error.tooLong",
  INVALID_GUESTS: "error.invalidGuests",
  TOO_MANY_GUESTS: "error.tooManyGuests",
  OUTSIDE_WINDOW: "error.outsideWindow",
  OVERLAP: "error.overlap",
  GAP: "error.gap",
};

/**
 * The season message has three shapes — both bounds, a start only, an end only —
 * and `checkRequest` returns one code for all three. These are the other two.
 */
const SEASON_KEYS = {
  from: "error.outsideWindow.from",
  to: "error.outsideWindow.to",
} as const;

/** Just enough of the request to write the message. */
export type FailureContext = {
  startDate?: DateStr;
};

/**
 * A `checkRequest` refusal, in the house's language.
 *
 * `checkRequest` already returns a `reason`, but it is English and it is written
 * for a developer reading a test. This turns the `code` — the part that is
 * actually data — into copy a guest reads. The numbers come from `rules`, so
 * the message always quotes the house it is talking about.
 */
export function failureMessage(
  code: CheckFailureCode,
  lang: Lang,
  rules: HouseRules,
  context: FailureContext = {},
): string {
  switch (code) {
    case "PAST":
      return t(FAILURE_KEYS.PAST, lang, {
        date: context.startDate ? dayLabel(context.startDate, lang) : "",
      });

    case "TOO_SHORT":
      return t(FAILURE_KEYS.TOO_SHORT, lang, {
        nights: tn("count.nights", rules.minNights, lang),
      });

    case "TOO_LONG":
      return t(FAILURE_KEYS.TOO_LONG, lang, {
        nights: tn("count.nights", rules.maxNights, lang),
      });

    case "TOO_MANY_GUESTS":
      return t(FAILURE_KEYS.TOO_MANY_GUESTS, lang, {
        guests: tn("count.guests", rules.maxGuests, lang),
        max: rules.maxGuests,
      });

    case "GAP":
      return t(FAILURE_KEYS.GAP, lang, {
        days: tn("count.days", rules.gapDays, lang),
      });

    case "OUTSIDE_WINDOW": {
      const { bookableFrom, bookableTo } = rules;
      if (bookableFrom && bookableTo) {
        return t(FAILURE_KEYS.OUTSIDE_WINDOW, lang, {
          from: dayLabel(bookableFrom, lang),
          to: dayLabel(bookableTo, lang),
        });
      }
      if (bookableFrom) {
        return t(SEASON_KEYS.from, lang, { from: dayLabel(bookableFrom, lang) });
      }
      if (bookableTo) {
        return t(SEASON_KEYS.to, lang, { to: dayLabel(bookableTo, lang) });
      }
      // Unreachable: checkRequest only raises this code when a bound exists.
      return t(FAILURE_KEYS.OUTSIDE_WINDOW, lang, { from: "", to: "" });
    }

    default:
      return t(FAILURE_KEYS[code], lang);
  }
}
