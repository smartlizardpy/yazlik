import { describe, expect, it } from "vitest";

import {
  bookableWindow,
  checkRequest,
  disabledDates,
  type BusyRange,
  type CheckResult,
  type HouseRules,
} from "@/lib/availability";
import {
  addDaysStr,
  compareDates,
  eachDayInRange,
  isDateStr,
  nightsBetween,
  rangesOverlap,
  toDate,
  toStr,
} from "@/lib/dates";

/** A house open for the summer of 2026, 2–14 nights, sleeps 6, no gap. */
const RULES: HouseRules = {
  minNights: 2,
  maxNights: 14,
  gapDays: 0,
  maxGuests: 6,
  bookableFrom: "2026-06-01",
  bookableTo: "2026-09-30",
};

const TODAY = "2026-05-01";

/** A confirmed stay: in on the 1st of August, out on the 10th. */
const AUGUST: BusyRange[] = [{ startDate: "2026-08-01", endDate: "2026-08-10" }];

function rules(over: Partial<HouseRules> = {}): HouseRules {
  return { ...RULES, ...over };
}

function ask(
  startDate: string,
  endDate: string,
  opts: { guests?: number; busy?: BusyRange[]; rules?: HouseRules; today?: string } = {},
): CheckResult {
  return checkRequest(
    opts.rules ?? RULES,
    opts.busy ?? [],
    { startDate, endDate, guests: opts.guests ?? 4 },
    opts.today ?? TODAY,
  );
}

/** Assert a refusal and hand back the code, so tests read as one line each. */
function codeOf(result: CheckResult): string {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  expect(result.reason.length).toBeGreaterThan(10);
  expect(result.reason).toMatch(/^[A-Z]/);
  expect(result.reason).not.toMatch(/sorry/i);
  return result.code;
}

describe("dates", () => {
  it("round-trips a date string", () => {
    expect(toStr(toDate("2026-08-01"))).toBe("2026-08-01");
    expect(toStr(toDate("2026-02-28"))).toBe("2026-02-28");
    expect(toStr(toDate("2026-12-31"))).toBe("2026-12-31");
  });

  it("rejects nonsense date strings", () => {
    expect(isDateStr("2026-08-01")).toBe(true);
    expect(isDateStr("2026-02-31")).toBe(false);
    expect(isDateStr("01/08/2026")).toBe(false);
    expect(() => toDate("not a date")).toThrow();
  });

  it("counts nights half-open", () => {
    expect(nightsBetween("2026-08-01", "2026-08-05")).toBe(4);
    expect(nightsBetween("2026-08-01", "2026-08-02")).toBe(1);
    expect(nightsBetween("2026-08-01", "2026-08-01")).toBe(0);
    expect(nightsBetween("2026-08-05", "2026-08-01")).toBe(-4);
  });

  it("counts nights across a month and a leap-free February", () => {
    expect(nightsBetween("2026-07-30", "2026-08-02")).toBe(3);
    expect(nightsBetween("2026-02-27", "2026-03-01")).toBe(2);
  });

  it("adds and compares days", () => {
    expect(addDaysStr("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysStr("2026-09-01", -1)).toBe("2026-08-31");
    expect(compareDates("2026-08-01", "2026-08-02")).toBeLessThan(0);
    expect(compareDates("2026-08-02", "2026-08-01")).toBeGreaterThan(0);
    expect(compareDates("2026-08-01", "2026-08-01")).toBe(0);
  });

  it("lists the nights slept, not the checkout day", () => {
    expect(eachDayInRange("2026-08-01", "2026-08-05")).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
    expect(eachDayInRange("2026-08-01", "2026-08-01")).toEqual([]);
    expect(eachDayInRange("2026-08-05", "2026-08-01")).toEqual([]);
  });

  it("treats a same-day changeover as no overlap", () => {
    expect(rangesOverlap("2026-08-01", "2026-08-10", "2026-08-10", "2026-08-14")).toBe(false);
    expect(rangesOverlap("2026-08-10", "2026-08-14", "2026-08-01", "2026-08-10")).toBe(false);
  });

  it("spots real overlaps in every direction", () => {
    expect(rangesOverlap("2026-08-01", "2026-08-10", "2026-08-09", "2026-08-12")).toBe(true);
    expect(rangesOverlap("2026-08-01", "2026-08-10", "2026-07-30", "2026-08-02")).toBe(true);
    expect(rangesOverlap("2026-08-01", "2026-08-10", "2026-08-03", "2026-08-05")).toBe(true);
    expect(rangesOverlap("2026-08-03", "2026-08-05", "2026-08-01", "2026-08-10")).toBe(true);
    expect(rangesOverlap("2026-08-01", "2026-08-10", "2026-08-01", "2026-08-10")).toBe(true);
    expect(rangesOverlap("2026-08-01", "2026-08-10", "2026-08-20", "2026-08-25")).toBe(false);
    expect(rangesOverlap("2026-08-01", "2026-08-01", "2026-07-25", "2026-08-10")).toBe(false);
  });
});

describe("checkRequest — a clean request", () => {
  it("accepts a stay that breaks nothing", () => {
    expect(ask("2026-08-12", "2026-08-19", { busy: AUGUST })).toEqual({ ok: true });
  });

  it("accepts a stay in an empty calendar", () => {
    expect(ask("2026-06-01", "2026-06-08")).toEqual({ ok: true });
  });
});

describe("checkRequest — changeover and overlap", () => {
  it("allows arriving the day the last guest leaves", () => {
    expect(ask("2026-08-10", "2026-08-14", { busy: AUGUST })).toEqual({ ok: true });
  });

  it("allows leaving the day the next guest arrives", () => {
    expect(ask("2026-07-28", "2026-08-01", { busy: AUGUST })).toEqual({ ok: true });
  });

  it("rejects an overlap of a single night at the end", () => {
    expect(codeOf(ask("2026-08-09", "2026-08-12", { busy: AUGUST }))).toBe("OVERLAP");
  });

  it("rejects an overlap of a single night at the start", () => {
    expect(codeOf(ask("2026-07-30", "2026-08-02", { busy: AUGUST }))).toBe("OVERLAP");
  });

  it("rejects a stay swallowing the busy range whole", () => {
    expect(codeOf(ask("2026-07-29", "2026-08-11", { busy: AUGUST }))).toBe("OVERLAP");
  });

  it("rejects a stay sitting inside the busy range", () => {
    expect(codeOf(ask("2026-08-03", "2026-08-06", { busy: AUGUST }))).toBe("OVERLAP");
  });

  it("checks every busy range, not just the first", () => {
    const busy: BusyRange[] = [
      { startDate: "2026-06-01", endDate: "2026-06-05" },
      { startDate: "2026-08-01", endDate: "2026-08-10" },
    ];
    expect(codeOf(ask("2026-08-05", "2026-08-08", { busy }))).toBe("OVERLAP");
    expect(ask("2026-06-06", "2026-06-09", { busy })).toEqual({ ok: true });
  });
});

describe("checkRequest — gap days", () => {
  const gap1 = rules({ gapDays: 1 });

  it("rejects a stay starting the day after a checkout", () => {
    expect(codeOf(ask("2026-08-10", "2026-08-13", { busy: AUGUST, rules: gap1 }))).toBe("GAP");
  });

  it("allows a stay one clear day after a checkout", () => {
    expect(ask("2026-08-11", "2026-08-14", { busy: AUGUST, rules: gap1 })).toEqual({ ok: true });
  });

  it("rejects a stay checking out on the next arrival day", () => {
    expect(codeOf(ask("2026-07-28", "2026-08-01", { busy: AUGUST, rules: gap1 }))).toBe("GAP");
  });

  it("allows a stay leaving one clear day before an arrival", () => {
    expect(ask("2026-07-27", "2026-07-31", { busy: AUGUST, rules: gap1 })).toEqual({ ok: true });
  });

  it("scales with gapDays", () => {
    const gap2 = rules({ gapDays: 2 });
    expect(codeOf(ask("2026-08-11", "2026-08-14", { busy: AUGUST, rules: gap2 }))).toBe("GAP");
    expect(ask("2026-08-12", "2026-08-15", { busy: AUGUST, rules: gap2 })).toEqual({ ok: true });
  });

  it("reports a straight collision as OVERLAP rather than GAP", () => {
    expect(codeOf(ask("2026-08-09", "2026-08-12", { busy: AUGUST, rules: gap1 }))).toBe("OVERLAP");
  });
});

describe("checkRequest — length", () => {
  it("accepts exactly minNights", () => {
    expect(ask("2026-08-12", "2026-08-14")).toEqual({ ok: true });
  });

  it("rejects one night short of minNights", () => {
    expect(codeOf(ask("2026-08-12", "2026-08-13"))).toBe("TOO_SHORT");
  });

  it("names the minimum in the reason", () => {
    const result = ask("2026-08-12", "2026-08-13", { rules: rules({ minNights: 3 }) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("3 nights");
  });

  it("accepts exactly maxNights", () => {
    expect(ask("2026-08-12", "2026-08-26")).toEqual({ ok: true });
  });

  it("rejects one night over maxNights", () => {
    expect(codeOf(ask("2026-08-12", "2026-08-27"))).toBe("TOO_LONG");
  });

  it("rejects a checkout before check-in", () => {
    expect(codeOf(ask("2026-08-12", "2026-08-10"))).toBe("END_BEFORE_START");
  });

  it("rejects a zero-night stay", () => {
    expect(codeOf(ask("2026-08-12", "2026-08-12"))).toBe("END_BEFORE_START");
  });
});

describe("checkRequest — guests", () => {
  it("accepts exactly maxGuests", () => {
    expect(ask("2026-08-12", "2026-08-16", { guests: 6 })).toEqual({ ok: true });
  });

  it("rejects one guest over maxGuests", () => {
    expect(codeOf(ask("2026-08-12", "2026-08-16", { guests: 7 }))).toBe("TOO_MANY_GUESTS");
  });

  it("rejects a headcount of zero", () => {
    expect(codeOf(ask("2026-08-12", "2026-08-16", { guests: 0 }))).toBe("INVALID_GUESTS");
  });
});

describe("checkRequest — bookable window", () => {
  it("rejects a stay straddling bookableTo", () => {
    expect(codeOf(ask("2026-09-28", "2026-10-02"))).toBe("OUTSIDE_WINDOW");
  });

  it("accepts a stay checking out exactly on bookableTo", () => {
    expect(ask("2026-09-26", "2026-09-30")).toEqual({ ok: true });
  });

  it("rejects a stay straddling bookableFrom", () => {
    expect(codeOf(ask("2026-05-30", "2026-06-03"))).toBe("OUTSIDE_WINDOW");
  });

  it("accepts a stay arriving exactly on bookableFrom", () => {
    expect(ask("2026-06-01", "2026-06-05")).toEqual({ ok: true });
  });

  it("rejects a stay entirely past the season", () => {
    expect(codeOf(ask("2026-11-01", "2026-11-05"))).toBe("OUTSIDE_WINDOW");
  });

  it("names both ends of the season in the reason", () => {
    const result = ask("2026-11-01", "2026-11-05");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("1 June 2026");
      expect(result.reason).toContain("30 September 2026");
    }
  });

  it("imposes no window when both bounds are null", () => {
    const open = rules({ bookableFrom: null, bookableTo: null });
    expect(ask("2026-12-24", "2026-12-28", { rules: open })).toEqual({ ok: true });
  });

  it("honours a lower bound on its own", () => {
    const open = rules({ bookableTo: null });
    expect(ask("2026-12-24", "2026-12-28", { rules: open })).toEqual({ ok: true });
    expect(codeOf(ask("2026-05-02", "2026-05-06", { rules: open }))).toBe("OUTSIDE_WINDOW");
  });
});

describe("checkRequest — the past", () => {
  it("rejects an arrival before today", () => {
    expect(codeOf(ask("2026-06-10", "2026-06-14", { today: "2026-06-11" }))).toBe("PAST");
  });

  it("accepts an arrival on today", () => {
    expect(ask("2026-06-11", "2026-06-14", { today: "2026-06-11" })).toEqual({ ok: true });
  });

  it("reports PAST ahead of any other broken rule", () => {
    expect(codeOf(ask("2026-01-01", "2026-01-02", { guests: 99, today: "2026-06-11" }))).toBe(
      "PAST",
    );
  });

  it("still reports an impossible range before the past", () => {
    expect(codeOf(ask("2026-01-05", "2026-01-01", { today: "2026-06-11" }))).toBe(
      "END_BEFORE_START",
    );
  });
});

describe("disabledDates", () => {
  it("greys out every night held but not the checkout day", () => {
    const out = disabledDates(RULES, [{ startDate: "2026-08-01", endDate: "2026-08-05" }], TODAY);
    expect([...out].sort()).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
    expect(out.has("2026-08-05")).toBe(false);
    expect(out.has("2026-07-31")).toBe(false);
  });

  it("pads by gapDays on both sides", () => {
    const out = disabledDates(
      rules({ gapDays: 1 }),
      [{ startDate: "2026-08-01", endDate: "2026-08-05" }],
      TODAY,
    );
    expect(out.size).toBe(6);
    expect(out.has("2026-07-31")).toBe(true);
    expect(out.has("2026-08-05")).toBe(true);
    expect(out.has("2026-08-06")).toBe(false);
  });

  it("drops days that have already gone", () => {
    const out = disabledDates(
      RULES,
      [{ startDate: "2026-08-01", endDate: "2026-08-05" }],
      "2026-08-03",
    );
    expect([...out].sort()).toEqual(["2026-08-03", "2026-08-04"]);
  });

  it("merges several busy ranges", () => {
    const out = disabledDates(RULES, AUGUST.concat({ startDate: "2026-08-10", endDate: "2026-08-12" }), TODAY);
    expect(out.size).toBe(11);
    expect(out.has("2026-08-10")).toBe(true);
    expect(out.has("2026-08-12")).toBe(false);
  });

  it("ignores an empty busy range", () => {
    expect(disabledDates(RULES, [{ startDate: "2026-08-01", endDate: "2026-08-01" }], TODAY).size).toBe(0);
    expect(disabledDates(RULES, [], TODAY).size).toBe(0);
  });

  it("agrees with checkRequest about what is selectable", () => {
    const gap1 = rules({ gapDays: 1 });
    const out = disabledDates(gap1, AUGUST, TODAY);
    expect(out.has("2026-08-10")).toBe(true);
    expect(codeOf(ask("2026-08-10", "2026-08-13", { busy: AUGUST, rules: gap1 }))).toBe("GAP");
    expect(out.has("2026-08-11")).toBe(false);
    expect(ask("2026-08-11", "2026-08-14", { busy: AUGUST, rules: gap1 })).toEqual({ ok: true });
  });
});

describe("bookableWindow", () => {
  it("opens at bookableFrom while the season is ahead", () => {
    expect(bookableWindow(RULES, TODAY)).toEqual({ min: "2026-06-01", max: "2026-09-30" });
  });

  it("opens at today once the season has started", () => {
    expect(bookableWindow(RULES, "2026-07-04")).toEqual({ min: "2026-07-04", max: "2026-09-30" });
  });

  it("has no upper bound when the owner set none", () => {
    expect(bookableWindow(rules({ bookableTo: null }), TODAY).max).toBeNull();
  });
});
