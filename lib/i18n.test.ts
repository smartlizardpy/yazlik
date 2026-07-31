/**
 * The spoken date forms.
 *
 * `rangeLabel` is checked in `lib/bookings.test.ts` alongside the dictionary
 * completeness assertions; this file is about `humanDay` and `humanRange`,
 * which are the ones a person reads on a screen.
 *
 * Every case pins `currentYear` explicitly. The year rule is the only part of
 * these functions that reads a clock, and a test that reads the same clock
 * would agree with a bug.
 */

import { describe, expect, it } from "vitest";

import { dictionary, humanDay, humanRange, rangeLabel, t } from "@/lib/i18n";

/** The year the reader is standing in, for every case below. */
const NOW = 2026;

describe("humanRange", () => {
  describe("English", () => {
    it("says the month once inside a single month", () => {
      expect(
        humanRange("2026-08-18", "2026-08-23", "en", { currentYear: NOW }),
      ).toBe("Tue 18 – Sun 23 Aug");
    });

    it("gives each end its own month across a boundary", () => {
      expect(
        humanRange("2026-08-29", "2026-09-02", "en", { currentYear: NOW }),
      ).toBe("Sat 29 Aug – Wed 2 Sep");
    });

    it("says the year only on the end that is not this year", () => {
      expect(
        humanRange("2026-12-29", "2027-01-02", "en", { currentYear: NOW }),
      ).toBe("Tue 29 Dec – Sat 2 Jan 2027");
    });

    it("says a shared year once, at the end", () => {
      expect(
        humanRange("2027-08-18", "2027-08-23", "en", { currentYear: NOW }),
      ).toBe("Wed 18 – Mon 23 Aug 2027");

      expect(
        humanRange("2027-08-29", "2027-09-02", "en", { currentYear: NOW }),
      ).toBe("Sun 29 Aug – Thu 2 Sep 2027");
    });

    it("keeps both ends for a single night", () => {
      // Arrive on the 18th, leave on the 19th: one night, two days named.
      expect(
        humanRange("2026-08-18", "2026-08-19", "en", { currentYear: NOW }),
      ).toBe("Tue 18 – Wed 19 Aug");
    });

    it("collapses a zero-length range to one day", () => {
      expect(
        humanRange("2026-08-18", "2026-08-18", "en", { currentYear: NOW }),
      ).toBe("Tue 18 Aug");
    });
  });

  describe("Turkish", () => {
    // Turkish puts the weekday after the date — `18 Ağu Sal`, not `Sal 18
    // Ağu`. Same information, the locale's own order.
    it("says the month once inside a single month", () => {
      expect(
        humanRange("2026-08-18", "2026-08-23", "tr", { currentYear: NOW }),
      ).toBe("18 Sal – 23 Ağu Paz");
    });

    it("gives each end its own month across a boundary", () => {
      expect(
        humanRange("2026-08-29", "2026-09-02", "tr", { currentYear: NOW }),
      ).toBe("29 Ağu Cmt – 2 Eyl Çar");
    });

    it("says the year only on the end that is not this year", () => {
      expect(
        humanRange("2026-12-29", "2027-01-02", "tr", { currentYear: NOW }),
      ).toBe("29 Ara Sal – 2 Oca 2027 Cmt");
    });

    it("keeps both ends for a single night", () => {
      expect(
        humanRange("2026-08-18", "2026-08-19", "tr", { currentYear: NOW }),
      ).toBe("18 Sal – 19 Ağu Çar");
    });

    it("collapses a zero-length range to one day", () => {
      expect(
        humanRange("2026-08-18", "2026-08-18", "tr", { currentYear: NOW }),
      ).toBe("18 Ağu Sal");
    });
  });

  it("leaves this year unsaid without being told what year it is", () => {
    const year = new Date().getFullYear();
    const said = humanRange(`${year}-08-18`, `${year}-08-23`, "en");
    expect(said).not.toContain(String(year));
    expect(said).toContain("Aug");
  });

  it("says a year that is not this one without being told", () => {
    const next = new Date().getFullYear() + 1;
    expect(humanRange(`${next}-08-18`, `${next}-08-23`, "en")).toContain(
      String(next),
    );
  });

  it("falls back to the written form rather than throwing on junk", () => {
    expect(humanRange("not-a-date", "2026-08-23", "en")).toBe(
      rangeLabel("not-a-date", "2026-08-23", "en"),
    );
  });
});

describe("humanDay", () => {
  it("says one day in each language", () => {
    expect(humanDay("2026-08-18", "en", { currentYear: NOW })).toBe(
      "Tue 18 Aug",
    );
    expect(humanDay("2026-08-18", "tr", { currentYear: NOW })).toBe(
      "18 Ağu Sal",
    );
  });

  it("adds the year when it is not this one", () => {
    expect(humanDay("2027-01-02", "en", { currentYear: NOW })).toBe(
      "Sat 2 Jan 2027",
    );
    expect(humanDay("2027-01-02", "tr", { currentYear: NOW })).toBe(
      "2 Oca 2027 Cmt",
    );
  });

  it("hands back anything that is not a day, untouched", () => {
    expect(humanDay("soon", "en")).toBe("soon");
  });
});

describe("short month names", () => {
  // The abbreviations live in lib/i18n.ts rather than the dictionaries. This
  // is the guard against them drifting away from the full names a translator
  // *can* edit.
  for (const lang of ["en", "tr"] as const) {
    it(`abbreviate the ${lang} month names they stand for`, () => {
      const dict = dictionary(lang);
      for (let month = 1; month <= 12; month++) {
        // A day in the middle of each month, so no timezone edge can shift it.
        const short = humanDay(
          `2026-${String(month).padStart(2, "0")}-15`,
          lang,
          { currentYear: 2026 },
        );
        const full = dict[`month.${month}`];
        expect(full).toBeTruthy();
        const abbreviation = short
          .split(" ")
          .find((word) => full.startsWith(word) && word.length === 3);
        expect(
          abbreviation,
          `no 3-letter abbreviation of "${full}" found in "${short}"`,
        ).toBeTruthy();
      }
    });
  }

  it("uses the dictionary's own weekday names", () => {
    // 2026-08-18 is a Tuesday; `weekday.short.2` is what the dictionary calls
    // that, in whichever language.
    expect(humanDay("2026-08-18", "tr", { currentYear: 2026 })).toContain(
      t("weekday.short.2", "tr"),
    );
  });
});
