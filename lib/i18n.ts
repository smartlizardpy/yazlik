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
import { isDateStr, toDate, type DateStr } from "@/lib/dates";

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

/**
 * Two days as one line: `1 August 2026 – 8 August 2026`.
 *
 * The written form. Unambiguous, fully spelled out, never abbreviated: this is
 * what goes in an .ics file, an email subject and anywhere a date has to
 * survive being read six months later out of context. Do not "improve" it —
 * {@link humanRange} is the one you want on a screen.
 */
export function rangeLabel(start: DateStr, end: DateStr, lang: Lang): string {
  return t("format.range", lang, {
    from: dayLabel(start, lang),
    to: dayLabel(end, lang),
  });
}

/* ============================================================
   SPOKEN DATES

   Nobody says "18 August 2026 – 23 August 2026". They say "Tuesday the 18th
   to Sunday the 23rd" — the weekday, because that is what you actually plan
   around, and the year only if it is not this one. `rangeLabel` writes a
   date; these two say one.
   ============================================================ */

/**
 * Three-letter months, per language.
 *
 * These live in code rather than in the dictionaries on purpose: they are a
 * mechanical shortening of `month.N`, not a translation decision, and the two
 * JSON files have to stay key-for-key identical for the dictionary test. Drift
 * is caught in `lib/i18n.test.ts`, which asserts every entry here is still a
 * prefix of the full month name it abbreviates.
 */
const SHORT_MONTHS: Record<Lang, readonly string[]> = {
  en: [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ],
  tr: [
    "Oca",
    "Şub",
    "Mar",
    "Nis",
    "May",
    "Haz",
    "Tem",
    "Ağu",
    "Eyl",
    "Eki",
    "Kas",
    "Ara",
  ],
};

/** The pieces of a spoken date. An absent piece is one that is not said. */
type SpokenDay = {
  weekday: string;
  day: number;
  month?: string;
  year?: number;
};

/**
 * Word order, per language, following each locale's own short-date form:
 * English puts the weekday first (`Tue 18 Aug`), Turkish puts it last
 * (`18 Ağu Sal`). Getting this backwards is the tell of a translated
 * interface, and it costs one line to get right.
 */
const SPEAK: Record<Lang, (parts: SpokenDay) => string> = {
  en: ({ weekday, day, month, year }) =>
    join([weekday, String(day), month, year]),
  tr: ({ weekday, day, month, year }) =>
    join([String(day), month, year, weekday]),
};

function join(parts: (string | number | undefined)[]): string {
  return parts.filter((p) => p !== undefined).join(" ");
}

export type SpokenDateOptions = {
  /**
   * The year to treat as "this year", and therefore leave unsaid. Defaults to
   * the current one. Pass it explicitly from a test, or from a server render
   * that has to agree with the client across New Year's Eve.
   */
  currentYear?: number;
};

function thisYear(options: SpokenDateOptions): number {
  return options.currentYear ?? new Date().getFullYear();
}

function parts(date: Date, lang: Lang): Omit<SpokenDay, "year"> {
  return {
    weekday: t(`weekday.short.${date.getDay()}`, lang),
    day: date.getDate(),
    month: SHORT_MONTHS[lang][date.getMonth()],
  };
}

/**
 * One day, said out loud: `Tue 18 Aug`, `18 Ağu Sal`.
 *
 * The year is silent unless it is not the current one — a stay next August
 * does not need telling you which August, and a stay in 2027 does.
 */
export function humanDay(
  day: DateStr,
  lang: Lang,
  options: SpokenDateOptions = {},
): string {
  if (!isDateStr(day)) return day;
  const date = toDate(day);
  const year = date.getFullYear();
  return SPEAK[lang]({
    ...parts(date, lang),
    year: year === thisYear(options) ? undefined : year,
  });
}

/**
 * Two days, said as one stretch of time.
 *
 * - Inside one month, the month is said once: `Tue 18 – Sun 23 Aug`.
 * - Across two, each end carries its own: `Sat 29 Aug – Wed 2 Sep`.
 * - The year appears only where it is not the current one, which means a stay
 *   over New Year reads `Tue 29 Dec – Sat 2 Jan 2027` rather than repeating
 *   a year the reader is standing in.
 * - Both days the same is not a range of nothing, it is a day: `Tue 18 Aug`.
 *
 * The two arguments are the same two `rangeLabel` takes — a check-in and a
 * check-out, half-open `[start, end)` — so anywhere one is used the other can
 * be swapped in without rethinking what the dates mean.
 */
export function humanRange(
  start: DateStr,
  end: DateStr,
  lang: Lang,
  options: SpokenDateOptions = {},
): string {
  // Anything that is not a real day falls back to the written form, which has
  // its own passthrough for junk. A malformed date should look wrong, not
  // throw a page away.
  if (!isDateStr(start) || !isDateStr(end)) return rangeLabel(start, end, lang);
  if (start === end) return humanDay(start, lang, options);

  const from = toDate(start);
  const to = toDate(end);
  const year = thisYear(options);
  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = sameYear && from.getMonth() === to.getMonth();

  const speak = SPEAK[lang];

  return t("format.range", lang, {
    from: speak({
      ...parts(from, lang),
      // Said once, on the far end, when both ends share it.
      month: sameMonth ? undefined : SHORT_MONTHS[lang][from.getMonth()],
      year:
        sameYear || from.getFullYear() === year
          ? undefined
          : from.getFullYear(),
    }),
    to: speak({
      ...parts(to, lang),
      year: to.getFullYear() === year ? undefined : to.getFullYear(),
    }),
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
