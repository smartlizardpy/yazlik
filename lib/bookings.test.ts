/**
 * The booking helpers and the copy that dresses them, with no database and no
 * network.
 *
 * `lib/bookings.ts` imports `@/db`, which throws at import time without a
 * `DATABASE_URL`. The query functions are thin `select`s not worth mocking a
 * driver for, so `@/db` is replaced wholesale and only the pure part —
 * `houseRules()` — is exercised here. Everything else in this file is about the
 * dictionaries.
 *
 * The dictionary tests are the point. A missing Turkish string is invisible in
 * review, invisible in TypeScript, and only visible to the one guest who reads
 * Turkish — so it fails here instead, along with a placeholder that got renamed
 * in one language and not the other.
 */

import { describe, expect, it, vi } from "vitest";

// Hoisted above the imports below, so `@/db` is never evaluated and no
// connection string is needed to run these.
vi.mock("@/db", () => ({ db: {} }));

import type { CheckFailureCode, HouseRules } from "@/lib/availability";
import { checkRequest } from "@/lib/availability";
import { houseRules, type HouseRulesSource } from "@/lib/bookings";
import {
  FAILURE_KEYS,
  LANGS,
  dayLabel,
  dictionary,
  failureMessage,
  isLang,
  rangeLabel,
  t,
  tn,
  toLang,
  translator,
  type Lang,
} from "@/lib/i18n";

/* ============================================================
   FIXTURES
   ============================================================ */

/** Every column `houseRules` reads, and nothing else. */
const HOUSE: HouseRulesSource = {
  minNights: 2,
  maxNights: 14,
  gapDays: 1,
  maxGuests: 6,
  bookableFrom: "2026-06-01",
  bookableTo: "2026-09-30",
};

const RULES: HouseRules = houseRules(HOUSE);

/** The nine codes, listed by hand so a new one has to be added on purpose. */
const CODES: CheckFailureCode[] = [
  "END_BEFORE_START",
  "PAST",
  "TOO_SHORT",
  "TOO_LONG",
  "INVALID_GUESTS",
  "TOO_MANY_GUESTS",
  "OUTSIDE_WINDOW",
  "OVERLAP",
  "GAP",
];

const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(text: string): Set<string> {
  return new Set(Array.from(text.matchAll(PLACEHOLDER), (m) => m[1]));
}

/* ============================================================
   houseRules
   ============================================================ */

describe("houseRules", () => {
  it("carries every soft rule across", () => {
    expect(RULES).toEqual({
      minNights: 2,
      maxNights: 14,
      gapDays: 1,
      maxGuests: 6,
      bookableFrom: "2026-06-01",
      bookableTo: "2026-09-30",
    });
  });

  it("keeps an unbounded season as null on both sides", () => {
    const open = houseRules({ ...HOUSE, bookableFrom: null, bookableTo: null });
    expect(open.bookableFrom).toBeNull();
    expect(open.bookableTo).toBeNull();
  });

  it("reads a missing bound the same as an explicitly empty one", () => {
    // A partially-filled settings form sends `undefined`; the database sends
    // `null`. HouseRules only understands `null`.
    const partial = { ...HOUSE } as Record<string, unknown>;
    delete partial.bookableFrom;
    delete partial.bookableTo;
    const rules = houseRules(partial as HouseRulesSource);
    expect(rules.bookableFrom).toBeNull();
    expect(rules.bookableTo).toBeNull();
  });

  it("narrows to exactly the keys availability asks for", () => {
    expect(Object.keys(RULES).sort()).toEqual([
      "bookableFrom",
      "bookableTo",
      "gapDays",
      "maxGuests",
      "maxNights",
      "minNights",
    ]);
  });

  it("hands checkRequest something it accepts", () => {
    const ok = checkRequest(
      RULES,
      [],
      { startDate: "2026-08-01", endDate: "2026-08-08", guests: 4 },
      "2026-05-01",
    );
    expect(ok).toEqual({ ok: true });
  });
});

/* ============================================================
   t()
   ============================================================ */

describe("t", () => {
  it("reads a string out of the house's dictionary", () => {
    expect(t("house.calendar", "en")).toBe("Calendar");
    expect(t("house.calendar", "tr")).toBe("Takvim");
  });

  it("fills named placeholders", () => {
    expect(t("house.town", "en", { town: "Çeşme", country: "Turkey" })).toBe(
      "Çeşme, Turkey",
    );
  });

  it("returns the key itself when the key is unknown, and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(t("nothing.like.this", "en")).toBe("nothing.like.this");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("leaves a placeholder alone when nothing was passed for it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(t("house.town", "en", { town: "Çeşme" })).toBe("Çeşme, {country}");
    warn.mockRestore();
  });

  it("counts in both languages", () => {
    expect(tn("count.nights", 1, "en")).toBe("1 night");
    expect(tn("count.nights", 3, "en")).toBe("3 nights");
    // Turkish keeps the noun singular after a number.
    expect(tn("count.nights", 1, "tr")).toBe("1 gece");
    expect(tn("count.nights", 3, "tr")).toBe("3 gece");
  });

  it("binds a language once", () => {
    const tr = translator("tr");
    expect(tr("house.legend.taken")).toBe("Dolu");
  });

  it("narrows a language, and falls back to English on anything else", () => {
    expect(isLang("tr")).toBe(true);
    expect(isLang("de")).toBe(false);
    expect(toLang("tr")).toBe("tr");
    expect(toLang(undefined)).toBe("en");
  });
});

/* ============================================================
   DATES
   ============================================================ */

describe("dayLabel", () => {
  it("writes a day out in each language", () => {
    expect(dayLabel("2026-08-01", "en")).toBe("1 August 2026");
    expect(dayLabel("2026-08-01", "tr")).toBe("1 Ağustos 2026");
  });

  it("drops the leading zero on the day", () => {
    expect(dayLabel("2026-06-09", "en")).toBe("9 June 2026");
  });

  it("hands back anything that is not a day untouched", () => {
    expect(dayLabel("later", "en")).toBe("later");
  });

  it("writes a range", () => {
    expect(rangeLabel("2026-08-01", "2026-08-08", "tr")).toBe(
      "1 Ağustos 2026 – 8 Ağustos 2026",
    );
  });
});

/* ============================================================
   THE DICTIONARIES
   ============================================================ */

describe("dictionaries", () => {
  const en = dictionary("en");
  const tr = dictionary("tr");

  it("ships the languages the schema allows", () => {
    expect(LANGS).toEqual(["en", "tr"]);
  });

  it("defines the same keys in every language", () => {
    for (const lang of LANGS) {
      const keys = Object.keys(dictionary(lang)).sort();
      expect(keys, `${lang} has a different set of keys to English`).toEqual(
        Object.keys(en).sort(),
      );
    }
  });

  it("has no blank strings", () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(dictionary(lang))) {
        expect(value.trim(), `${lang}: ${key} is blank`).not.toBe("");
      }
    }
  });

  it("uses the same placeholders in every language", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(
        [...placeholders(tr[key])].sort(),
        `tr: ${key} does not take the same placeholders as English`,
      ).toEqual([...placeholders(value)].sort());
    }
  });

  it("is not English wearing diacritics", () => {
    // A spot check that someone actually wrote Turkish: these are the words a
    // family would use, and none of them survive a find-and-replace.
    expect(tr["house.legend.taken"]).toBe("Dolu");
    expect(tr["status.confirmed"]).toBe("Onaylandı");
    expect(tr["booking.cancel"]).toBe("Bu rezervasyonu iptal et");
    expect(tr["month.8"]).toBe("Ağustos");
    for (const [key, value] of Object.entries(en)) {
      // Placeholder-only and proper-noun strings are allowed to match.
      if (["format.day", "format.range", "house.town", "form.dates.summary"].includes(key)) {
        continue;
      }
      expect(tr[key], `tr: ${key} is still English`).not.toBe(value);
    }
  });
});

/* ============================================================
   FAILURE CODES
   ============================================================ */

describe("failureMessage", () => {
  it("has a key for every code checkRequest can return", () => {
    // FAILURE_KEYS is a total Record over CheckFailureCode, so a new code
    // without copy is a type error. This checks the list stays in step.
    expect(Object.keys(FAILURE_KEYS).sort()).toEqual([...CODES].sort());
  });

  it("has a string for every code in every language", () => {
    for (const lang of LANGS) {
      const dict = dictionary(lang);
      for (const code of CODES) {
        const key = FAILURE_KEYS[code];
        expect(dict[key], `${lang}: no copy for ${code}`).toBeTruthy();
      }
      // The season message has two more shapes than it has codes.
      expect(dict["error.outsideWindow.from"], `${lang}: half-open season`).toBeTruthy();
      expect(dict["error.outsideWindow.to"], `${lang}: half-open season`).toBeTruthy();
    }
  });

  it("writes every code in every language with nothing left unfilled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const lang of LANGS) {
      for (const code of CODES) {
        const message = failureMessage(code, lang, RULES, { startDate: "2026-08-01" });
        expect(message, `${lang}/${code}`).not.toBe(FAILURE_KEYS[code]);
        expect(message.length, `${lang}/${code} is too short to be a sentence`)
          .toBeGreaterThan(10);
        expect(message, `${lang}/${code} left a placeholder`).not.toMatch(PLACEHOLDER);
        expect(message, `${lang}/${code} apologises`).not.toMatch(/sorry|üzgün|maalesef/i);
      }
    }
    expect(warn, "a code fell through to a missing key").not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("says the same thing in Turkish as in English", () => {
    for (const code of CODES) {
      const en = failureMessage(code, "en", RULES, { startDate: "2026-08-01" });
      const tr = failureMessage(code, "tr", RULES, { startDate: "2026-08-01" });
      expect(tr, `${code} is untranslated`).not.toBe(en);
    }
  });

  it("quotes the house's own numbers", () => {
    expect(failureMessage("TOO_SHORT", "en", RULES)).toContain("2 nights");
    expect(failureMessage("TOO_SHORT", "tr", RULES)).toContain("2 gece");
    expect(failureMessage("TOO_LONG", "en", RULES)).toContain("14 nights");
    expect(failureMessage("TOO_MANY_GUESTS", "tr", RULES)).toContain("6 kişi");
    expect(failureMessage("GAP", "en", RULES)).toContain("1 day");
    expect(failureMessage("GAP", "tr", RULES)).toContain("1 gün");
  });

  it("names the arrival day that has already passed", () => {
    expect(failureMessage("PAST", "en", RULES, { startDate: "2026-08-01" })).toContain(
      "1 August 2026",
    );
    expect(failureMessage("PAST", "tr", RULES, { startDate: "2026-08-01" })).toContain(
      "1 Ağustos 2026",
    );
  });

  it("writes the season three ways", () => {
    const both = failureMessage("OUTSIDE_WINDOW", "en", RULES);
    expect(both).toContain("1 June 2026");
    expect(both).toContain("30 September 2026");

    const openEnded = failureMessage("OUTSIDE_WINDOW", "en", {
      ...RULES,
      bookableTo: null,
    });
    expect(openEnded).toContain("1 June 2026");
    expect(openEnded).not.toContain("30 September 2026");

    const openStart = failureMessage("OUTSIDE_WINDOW", "tr", {
      ...RULES,
      bookableFrom: null,
    });
    expect(openStart).toContain("30 Eylül 2026");
    expect(openStart).not.toContain("1 Haziran 2026");
  });

  it("localises whatever checkRequest actually refuses", () => {
    // The real path: a request that breaks a rule, its code turned into copy.
    const result = checkRequest(
      RULES,
      [],
      { startDate: "2026-08-01", endDate: "2026-08-02", guests: 4 },
      "2026-05-01",
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a refusal");
    expect(result.code).toBe("TOO_SHORT");
    expect(failureMessage(result.code, "tr", RULES)).toBe(
      "Buradaki konaklamalar en az 2 gece. Çıkışınızı, konaklama en az 2 gece olacak şekilde ileri alın.",
    );
  });
});

/* ============================================================
   STATUSES
   ============================================================ */

describe("booking statuses", () => {
  const STATUSES = ["pending", "confirmed", "declined", "cancelled"] as const;

  it("has a label and a sentence for every status the schema allows", () => {
    for (const lang of LANGS as Lang[]) {
      const dict = dictionary(lang);
      for (const status of STATUSES) {
        expect(dict[`status.${status}`], `${lang}: ${status}`).toBeTruthy();
        expect(dict[`status.${status}.body`], `${lang}: ${status} body`).toBeTruthy();
      }
    }
  });
});
