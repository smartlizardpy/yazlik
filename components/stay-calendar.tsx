"use client";

/**
 * The date-range picker a guest uses to choose a stay.
 *
 * ### One cell is one night
 *
 * This is the single idea the whole component turns on. Every square in the
 * grid is a *night you sleep in the house*, not a day you are vaguely
 * associated with it. So a selection of six squares is six nights, and the
 * check-out day — the morning you leave — is the day *after* the last square,
 * which is why it is never highlighted.
 *
 * That choice makes three otherwise fiddly things fall out for free:
 *
 * - `disabledDates` from {@link import("@/lib/availability").disabledDates} is
 *   already a set of *nights*, so a selection can never touch a taken night.
 * - Same-day changeover works: the guest leaving on the 8th holds nights up to
 *   the 7th, so the 8th is still tappable by the next guest.
 * - The nights count is just the number of highlighted squares, so the number
 *   on screen and the number a person is deciding about are the same number.
 *
 * The `value` it emits speaks the app's language instead: `start` is the
 * check-in day and `end` is the check-out day, half-open `[start, end)` exactly
 * like `bookings.startDate` / `bookings.endDate` and
 * {@link import("@/lib/availability").checkRequest}. `end: null` means the
 * guest has picked an arrival and is still choosing when to leave.
 *
 * ### What it does not do
 *
 * It never imports the database, never fetches, and does not know what a
 * booking is. Dates in, dates back. Every rule — minimum nights, gap days, the
 * season window, headcount — belongs to `lib/availability.ts`, and the page
 * that owns this component is the one that asks. The most this does is refuse
 * to build a range that swallows a night the caller marked unavailable, which
 * is not a rule so much as a refusal to produce nonsense.
 *
 * ### Colour carries no meaning
 *
 * Free is plain, taken is a filled neutral struck through, pending is a dashed
 * outline, and your selection is solid black. Four states, four different
 * *shapes*, so the calendar survives greyscale and colourblindness. shadcn's
 * calendar paints the selection with the blue accent — that is overridden below
 * and must stay overridden.
 *
 * ### A run of nights is one shape
 *
 * Five nights somebody has asked for are not five events, they are one week
 * somebody asked about, and the grid has to say so. Every cell used to carry
 * its own rounded outline, which drew 18, 19, 20, 21 and 22 as five separate
 * dashed boxes with stray dashes between them — a rendering fault, not a
 * sentence. So the two bands are drawn from run **edges**: the first and last
 * night of a stretch get the rounding and the closing dash, everything between
 * them is square, and adjacent cells sit flush, so a run reads as one
 * continuous band however long it is.
 *
 * ### `explain`
 *
 * Off by default, because the owner blocking their own dates does not need the
 * grid explained to them. On, for the guest, it adds two things: a one-line key
 * under the grid naming the marks that are actually on it, and a hollow ink
 * square on the morning you leave — the day the footer names but the grid, which
 * only ever fills *nights*, would otherwise leave blank.
 */

import { useCallback, useMemo } from "react";
import { RotateCcwIcon } from "lucide-react";
import { labelDayButton as defaultLabelDayButton } from "react-day-picker";
import type { Labels, Locale, Matcher, Modifiers } from "react-day-picker";
import { enGB } from "react-day-picker/locale/en-GB";
import { tr } from "react-day-picker/locale/tr";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  addDaysStr,
  compareDates,
  eachDayInRange,
  nightsBetween,
  toDate,
  toStr,
  type DateStr,
} from "@/lib/dates";
import { DEFAULT_LANG, humanDay, humanRange, t, tn, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/* ============================================================
   TYPES
   ============================================================ */

/**
 * A stay in the app's own terms: half-open `[start, end)`.
 *
 * `start` is the check-in day and the first night slept. `end` is the check-out
 * day and is **not** slept — it is free for the next arrival. While the guest
 * is mid-pick, `end` is `null`: an arrival is chosen and a departure is not.
 */
export type StayRange = {
  start: DateStr;
  end: DateStr | null;
};

export type StayCalendarProps = {
  /**
   * Nights that are gone, from
   * {@link import("@/lib/availability").disabledDates}. Not tappable, in either
   * role — a stay can neither start on one nor span one.
   */
  disabledDates: ReadonlySet<DateStr>;
  /**
   * Nights someone has asked for but the owner has not decided on. Still
   * tappable: two pending requests on the same week is the correct state, and
   * the owner is the one who chooses between them.
   */
  pendingDates?: ReadonlySet<DateStr>;
  /** Earliest check-in — `bookableWindow().min`. */
  min: DateStr;
  /**
   * Latest check-out — `bookableWindow().max`. `null` when the owner set no end
   * to the season. A stay must *leave* by this day, so the last night on offer
   * is the day before it.
   */
  max?: DateStr | null;
  value: StayRange | null;
  onChange: (next: StayRange | null) => void;
  /**
   * Explain the grid to someone who has never seen it: a one-line key under it
   * naming the marks it is actually showing, and the morning you leave drawn as
   * a hollow square at the end of the band. Guest-facing screens want this; the
   * owner blocking their own dates does not.
   */
  explain?: boolean;
  /** The house's language. Picks the month and weekday names, and the copy. */
  language?: Lang;
  className?: string;
};

/* ============================================================
   COPY
   ============================================================ */

// Every string here comes from lib/i18n/{en,tr}.json via `t`. The wording is
// deliberately **night**, not day: one cell is one night slept, and check-out
// is the morning after the last square. The old `house.calendar.hint` said
// "pick the day you arrive and the day you leave", which was out by one against
// this grid, and has been removed rather than left to mislead someone.

const LOCALES: Record<Lang, Locale> = { en: enGB, tr };

/** Hoisted so the default never changes identity between renders. */
const NO_DATES: ReadonlySet<DateStr> = new Set<DateStr>();

/* ============================================================
   STYLING
   ============================================================ */

/**
 * The four states, as four fills rather than four hues.
 *
 * These land on the day *cell*, underneath the button. The button's background
 * is transparent until it is selected, so a cell fill shows through and a black
 * selection covers it — which is the priority we want.
 */
const MODIFIER_CLASS_NAMES = {
  // Taken: a fill and a line through the number. `bg-muted` used to do this
  // and it is 1.5% off the paper — on a phone in daylight the taken nights
  // were simply invisible. `bg-taken` is --border under another name: still no
  // hue, but a fill you can actually see. The strike is drawn at a stronger
  // contrast than the number it crosses out, so "gone" reads before "12th".
  taken:
    "bg-taken [&>button]:line-through [&>button]:decoration-2 [&>button]:decoration-foreground/50",
  // The fill is continuous because the cells are flush; only the two ends of
  // the run are rounded, which is why the base cell carries no radius.
  takenStart: "rounded-l-(--cell-radius)",
  takenEnd: "rounded-r-(--cell-radius)",
  // Pending: a dashed rule along the top and bottom of every night in the run,
  // closed off at the two ends. Drawn on a pseudo-element rather than the cell
  // itself so it costs no layout — a real border would shrink the cell by 4px
  // and push the 44px button out of it. Still tappable, so it stays lighter
  // than a free night's number: nobody should read "asked for" as "gone".
  pending:
    "before:pointer-events-none before:absolute before:inset-0 before:border-y-2 before:border-dashed before:border-muted-foreground/55",
  pendingStart: "before:rounded-l-(--cell-radius) before:border-l-2",
  pendingEnd: "before:rounded-r-(--cell-radius) before:border-r-2",
  // The morning you leave. Not a night, so it is never filled — the same square
  // as the band next to it, drawn hollow. `outline` rather than `border` for
  // the same reason as above, and inset so it cannot spill into its neighbours.
  leaving:
    "rounded-(--cell-radius) outline-2 outline-foreground -outline-offset-2",
} satisfies Record<string, string>;

const CALENDAR_CLASS_NAMES = {
  // shadcn ships `w-fit`; a phone wants the whole column.
  root: "w-full",
  // Tighter than shadcn's `gap-4`: the caption, the weekday row and the grid
  // are one object, not three stacked panels.
  month: "flex w-full flex-col gap-1.5",
  // Caption hard left, the two chevrons hard right. shadcn centres the caption
  // between them, which is the layout every date picker in every admin panel
  // has; a month is a title, and titles start at the left margin.
  nav: "absolute top-0 right-0 flex items-center",
  month_caption: "flex h-(--cell-size) w-full items-center justify-start pe-24",
  // The guest's only orientation cue, and it was 15px — the same size as the
  // hint text under it. Display face, real size, no weight: this is what the
  // second family is *for*.
  caption_label: "font-heading text-xl font-normal select-none",
  weekday: "flex-1 text-xs font-normal text-muted-foreground select-none",
  // Rows sit flush and are exactly one touch target tall. shadcn's cells are
  // square, which at 390px makes each row 51px, and `mt-2` added 8 more: a
  // month came to 354px of mostly air, so half a season needed scrolling.
  // 44px flush rows give back 90px — most of a sixth week.
  week: "flex w-full [&>td]:aspect-auto [&>td]:h-(--cell-size)",
  // No radius on the cell itself. shadcn rounds every day, which turned a
  // six-night taken band into six rounded tiles with notches between them and
  // the pending week into five dashed boxes. The rounding belongs to the *run*,
  // so it is applied by the run-edge modifiers above and nowhere else. The two
  // child rules are shadcn's own and stay: they round a selection where it
  // meets the edge of a week rather than leaving it cut off mid-row.
  day: [
    "group/day relative h-full w-full p-0 text-center select-none",
    "[&:first-child[data-selected=true]_button]:rounded-l-(--cell-radius)",
    "[&:last-child[data-selected=true]_button]:rounded-r-(--cell-radius)",
  ].join(" "),
  // shadcn marks today with `bg-muted`, which is a competing fill. A dot under
  // the number instead: a different shape, not another wash of grey.
  today:
    "after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-foreground",
  // "You cannot tap this", said properly. The old rule left the number at
  // --muted-foreground, the same token that marks ordinary secondary text, so
  // a dead day and a live one differed by a shade nobody reads as a state.
  // Ink at 40% is unmistakably off — still legible enough to find the 12th,
  // never mistakable for something you can press. shadcn's Button also dims
  // `:disabled` by half, which would compound to invisible, so it is switched
  // off here and the contrast is set in exactly one place.
  disabled: "text-foreground/40 [&>button:disabled]:opacity-100",
  // The cell fills and the ±16px bleed shadcn uses to bridge a gutter between
  // cells are dropped: our cells sit flush, so the buttons already form a
  // continuous bar and the bleed would only paint past the ends.
  range_start: "rounded-l-(--cell-radius)",
  range_middle: "rounded-none",
  range_end: "rounded-r-(--cell-radius)",
  footer: "mt-3 w-full border-t border-border pt-3",
  day_button: [
    // Cells are no longer square, so the button fills the row rather than
    // forcing it back to its own width. The number gets 17px and a little
    // weight: it is the content of this screen, not a label on it.
    "aspect-auto h-(--cell-size) text-base font-medium",
    // THE override. shadcn selects with `bg-primary`, which is the one blue
    // accent this product reserves for the primary action. Selection here is
    // solid black — foreground on background, so it inverts correctly in dark
    // mode and stays the strongest thing on the grid in greyscale.
    "data-[selected-single=true]:bg-foreground data-[selected-single=true]:text-background",
    "data-[range-start=true]:bg-foreground data-[range-start=true]:text-background",
    "data-[range-middle=true]:bg-foreground data-[range-middle=true]:text-background",
    "data-[range-end=true]:bg-foreground data-[range-end=true]:text-background",
    // shadcn rounds all four corners of both ends, which notches the bar where
    // a rounded end meets a square middle. Square off the inner corners — and
    // put them back when one night is both ends at once.
    "data-[range-start=true]:rounded-r-none data-[range-end=true]:rounded-l-none",
    "data-[range-start=true]:data-[range-end=true]:rounded-(--cell-radius)",
  ].join(" "),
};

/* ============================================================
   SELECTION
   ============================================================ */

/**
 * What one tap on `night` does to the current selection.
 *
 * Pure, so the whole interaction is one readable function:
 *
 * - Nothing picked, or a finished stay → this tap is a new check-in. That is
 *   the third tap starting over, and it needs no modifier key, which a phone
 *   does not have.
 * - A tap on or before the current check-in → move the check-in. A departure
 *   can only ever be after an arrival, so a backwards tap is a correction.
 * - Otherwise → close the range. The tapped square is the last night, so
 *   check-out is the morning after it.
 * - A range that would swallow a taken night is refused and restarts at the
 *   tapped night, rather than silently producing something the owner can never
 *   approve.
 */
export function nextSelection(
  current: StayRange | null,
  night: DateStr,
  taken: ReadonlySet<DateStr>,
): StayRange {
  const startOver: StayRange = { start: night, end: null };

  if (!current || current.end !== null) return startOver;
  if (compareDates(night, current.start) < 0) return startOver;

  const end = addDaysStr(night, 1);
  for (const held of eachDayInRange(current.start, end)) {
    if (taken.has(held)) return startOver;
  }
  return { start: current.start, end };
}

/**
 * A season with no end still has to stop somewhere. A year is longer than any
 * house has ever been booked solid for, and it keeps these scans bounded.
 */
const SCAN_LIMIT = 366;

/**
 * How many free nights a month needs before it is worth opening on.
 *
 * A week, because a week is the unit this product is actually about — a cousin
 * asks for "a week in August", not for a night. A month with fewer than that
 * left is a month you would immediately swipe past.
 */
const MEANINGFUL_NIGHTS = 7;

/** The first selectable night at or after `from`, or `null` if there is none. */
function findOpenNight(
  from: DateStr,
  lastNight: DateStr | null,
  taken: ReadonlySet<DateStr>,
): DateStr | null {
  let night = from;
  for (let i = 0; i < SCAN_LIMIT; i++) {
    if (lastNight && compareDates(night, lastNight) > 0) return null;
    if (!taken.has(night)) return night;
    night = addDaysStr(night, 1);
  }
  return null;
}

/**
 * The first night a guest could actually take, at or after `min`.
 *
 * Falls back to `min` when the season has nothing left: the guest should still
 * see where they are, and the copy above the grid says the rest.
 */
export function firstOpenNight(
  min: DateStr,
  lastNight: DateStr | null,
  taken: ReadonlySet<DateStr>,
): DateStr {
  return findOpenNight(min, lastNight, taken) ?? min;
}

/** `YYYY-MM` — two nights are in the same month when this matches. */
function monthOf(day: DateStr): string {
  return day.slice(0, 7);
}

function firstOfNextMonth(day: DateStr): DateStr {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/**
 * Free nights from `night` to the end of its month. Stops counting at `cap`,
 * because the only question ever asked is "are there at least this many".
 */
function openNightsInMonth(
  night: DateStr,
  lastNight: DateStr | null,
  taken: ReadonlySet<DateStr>,
  cap: number,
): number {
  const month = monthOf(night);
  let count = 0;
  let day = night;
  for (let i = 0; i < 31 && monthOf(day) === month; i++) {
    if (lastNight && compareDates(day, lastNight) > 0) break;
    if (!taken.has(day) && ++count >= cap) return count;
    day = addDaysStr(day, 1);
  }
  return count;
}

/**
 * The month the calendar opens on — the product's first impression.
 *
 * `min` is `bookableWindow().min`, which is **today** once the season has
 * started, and opening on today's month is how a cousin tapping the link on
 * 31 July met a July with thirty dead squares and a single live one. Worse,
 * the house's shortest stay is two nights, so that one square could not even
 * become a request: the first thing the product showed was a month in which
 * nothing was possible.
 *
 * "The first month containing a selectable night" is not enough on its own —
 * July *did* contain one. So this asks the stronger question a person is
 * actually asking: **where do my options begin?** A month is worth opening on
 * when it still has a week in it. Otherwise skip to the next month that does,
 * and fall back to the first open night when no month clears the bar (a season
 * with a fortnight left is still a season, and the guest should see it).
 *
 * Navigating back is never blocked — `startMonth` is still `min`, so the
 * chevron reaches July for anyone who genuinely wants its last night.
 */
export function openingNight(
  min: DateStr,
  lastNight: DateStr | null,
  taken: ReadonlySet<DateStr>,
): DateStr {
  const first = firstOpenNight(min, lastNight, taken);
  let night: DateStr | null = first;

  // Twelve hops is a whole year of months; the season ends long before this.
  for (let i = 0; i < 12 && night; i++) {
    if (
      openNightsInMonth(night, lastNight, taken, MEANINGFUL_NIGHTS) >=
      MEANINGFUL_NIGHTS
    ) {
      return night;
    }
    night = findOpenNight(firstOfNextMonth(night), lastNight, taken);
  }

  return first;
}

/* ============================================================
   COMPONENT
   ============================================================ */

export function StayCalendar({
  disabledDates,
  pendingDates = NO_DATES,
  min,
  max = null,
  value,
  onChange,
  explain = false,
  language = DEFAULT_LANG,
  className,
}: StayCalendarProps) {
  const locale = LOCALES[language];

  // The season's last *night*, one day before the last permitted check-out.
  const lastNight = max ? addDaysStr(max, -1) : null;

  // A `value` whose end is not after its start is treated as still being
  // picked, so a caller cannot paint a backwards range on the grid.
  const chosenLastNight =
    value?.end != null && nightsBetween(value.start, value.end) > 0
      ? addDaysStr(value.end, -1)
      : null;

  const selected = useMemo(
    () =>
      value
        ? {
            from: toDate(value.start),
            to: chosenLastNight ? toDate(chosenLastNight) : undefined,
          }
        : undefined,
    [value, chosenLastNight],
  );

  const disabled = useMemo<Matcher[]>(() => {
    const matchers: Matcher[] = [{ before: toDate(min) }];
    if (lastNight) matchers.push({ after: toDate(lastNight) });
    matchers.push((date: Date) => disabledDates.has(toStr(date)));
    return matchers;
  }, [min, lastNight, disabledDates]);

  // The check-out day, and only when there is a real stay to leave from. It is
  // the one square the footer names that the grid would otherwise leave blank,
  // which is how "Tue 11 – Sat 15 Aug" ended up sitting under a grid with
  // nothing on the 15th.
  const leavingDay = explain && chosenLastNight != null ? value?.end : null;

  const modifiers = useMemo(() => {
    // A night is the start of a run when the night before it is not in the same
    // set; the end, when the night after it is not. That is the whole of it —
    // week boundaries need no special case, because a run that carries over a
    // Sunday simply has no closing dash there and picks up again on the Monday.
    const startsRun = (nights: ReadonlySet<DateStr>) => (date: Date) => {
      const night = toStr(date);
      return nights.has(night) && !nights.has(addDaysStr(night, -1));
    };
    const endsRun = (nights: ReadonlySet<DateStr>) => (date: Date) => {
      const night = toStr(date);
      return nights.has(night) && !nights.has(addDaysStr(night, 1));
    };
    return {
      taken: (date: Date) => disabledDates.has(toStr(date)),
      takenStart: startsRun(disabledDates),
      takenEnd: endsRun(disabledDates),
      pending: (date: Date) => pendingDates.has(toStr(date)),
      pendingStart: startsRun(pendingDates),
      pendingEnd: endsRun(pendingDates),
      leaving: (date: Date) => leavingDay != null && toStr(date) === leavingDay,
    };
  }, [disabledDates, pendingDates, leavingDay]);

  // Say out loud what the fills say visually. Delegates to the locale's own
  // label so the Turkish calendar keeps its Turkish aria labels.
  const labels = useMemo<Partial<Labels>>(
    () => ({
      labelDayButton: (
        date: Date,
        dayModifiers: Modifiers,
        options?: Parameters<typeof defaultLabelDayButton>[2],
        dateLib?: Parameters<typeof defaultLabelDayButton>[3],
      ) => {
        // A locale may hand back a plain string instead of a formatter; that is
        // how react-day-picker's own `resolveLabel` treats it too.
        const translated = locale.labels?.labelDayButton;
        const base =
          typeof translated === "function"
            ? translated(date, dayModifiers, options, dateLib)
            : (translated ??
              defaultLabelDayButton(date, dayModifiers, options, dateLib));
        if (dayModifiers.taken) return `${base}, ${t("house.legend.taken", language)}`;
        if (dayModifiers.pending)
          return `${base}, ${t("house.legend.pending", language)}`;
        if (dayModifiers.leaving)
          return `${base}, ${t("house.legend.leaving", language)}`;
        return base;
      },
    }),
    [locale, language],
  );

  const handleSelect = useCallback(
    (_range: unknown, night: Date) => {
      onChange(nextSelection(value, toStr(night), disabledDates));
    },
    [onChange, value, disabledDates],
  );

  const handleReset = useCallback(() => onChange(null), [onChange]);

  // Read once, on mount — the guest navigates from here on their own.
  const openMonth = useMemo(
    () => toDate(value?.start ?? openingNight(min, lastNight, disabledDates)),
    [value?.start, min, lastNight, disabledDates],
  );

  // The footer used to be three labelled fields — "Check in", "Check out",
  // nights — which is a database row with a border on it. A chosen stay is one
  // thing, so it is said as one line, in the display face, in the words a
  // person would use out loud: "Tue 18 – Sun 23 Aug · 5 nights".
  let footerLine;
  if (!value) {
    footerLine = (
      <p className="text-sm text-muted-foreground">{t("calendar.empty", language)}</p>
    );
  } else if (value.end == null || chosenLastNight == null) {
    footerLine = (
      <p className="text-sm text-muted-foreground">
        {t("calendar.picking", language, { day: humanDay(value.start, language) })}
      </p>
    );
  } else {
    footerLine = (
      <div className="flex w-full flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="num font-heading text-lg">
          {humanRange(value.start, value.end, language)}
        </p>
        <p className="num text-sm text-muted-foreground">
          {tn("count.nights", nightsBetween(value.start, value.end), language)}
        </p>
      </div>
    );
  }

  // The key to the grid — and only ever to the marks that are on it. A house
  // with nothing taken and nobody waiting shows a grid of plain numbers, and a
  // key explaining marks it is not showing is furniture. There has to be
  // something to explain before it appears at all, which is what `length > 1`
  // is asking: the ink square alone explains nothing.
  const marks: { key: string; label: string; swatch: string }[] = [];
  if (explain) {
    if (disabledDates.size > 0) {
      marks.push({
        key: "taken",
        label: t("house.legend.taken", language),
        swatch:
          "relative bg-taken after:absolute after:inset-x-0 after:top-1/2 after:h-0.5 after:-translate-y-1/2 after:bg-foreground/50",
      });
    }
    if (pendingDates.size > 0) {
      marks.push({
        key: "pending",
        label: t("house.legend.pending", language),
        swatch: "border-2 border-dashed border-muted-foreground/55",
      });
    }
    // Only one of these two, ever. Before a stay is picked the ink square says
    // what picking one will look like; once it is picked the line above the key
    // has already named it, and the only mark left unexplained is the hollow
    // square on the morning you leave.
    marks.push(
      leavingDay != null
        ? {
            key: "leaving",
            label: t("house.legend.leaving", language),
            swatch: "border-2 border-foreground",
          }
        : {
            key: "selected",
            label: t("house.legend.selected", language),
            swatch: "bg-foreground",
          },
    );
  }

  // `aria-hidden`, and deliberately. Every day button already says which of
  // these it is in its own accessible name, so a reader that also read the key
  // would hear the whole thing again on every tap — the footer is a polite live
  // region. This is the same information, drawn, for the eye that cannot ask a
  // cell what it means.
  const legend =
    marks.length > 1 ? (
      <ul
        aria-hidden="true"
        className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
      >
        {marks.map((mark) => (
          <li key={mark.key} className="flex items-center gap-2">
            <span className={cn("size-3.5 shrink-0 rounded-sm", mark.swatch)} />
            {mark.label}
          </li>
        ))}
      </ul>
    ) : null;

  return (
    <div
      role="group"
      aria-label={t("house.calendar", language)}
      className={cn("flex flex-col items-start", className)}
    >
      <Calendar
        mode="range"
        selected={selected}
        onSelect={handleSelect}
        disabled={disabled}
        modifiers={modifiers}
        modifiersClassNames={MODIFIER_CLASS_NAMES}
        classNames={CALENDAR_CLASS_NAMES}
        labels={labels}
        locale={locale}
        // One month at a time. Two side by side at 390px means a sideways
        // scroll, and a calendar you have to scroll is a calendar you misread.
        numberOfMonths={1}
        // Days borrowed from the neighbouring month are the easiest way to tap
        // the wrong date on a phone.
        showOutsideDays={false}
        startMonth={toDate(min)}
        endMonth={lastNight ? toDate(lastNight) : undefined}
        // Not `min`: see openingNight. A month you cannot book is not a
        // month worth opening on.
        defaultMonth={openMonth}
        footer={
          <>
            {footerLine}
            {legend}
          </>
        }
        // 44px: the floor for a touch target, and it sizes the previous and
        // next buttons as well as the day cells.
        className="w-full p-0 [--cell-size:--spacing(11)]"
      />

      {value ? (
        <Button
          type="button"
          variant="ghost"
          onClick={handleReset}
          className="-ms-3 mt-1 h-11 px-3 text-muted-foreground"
        >
          <RotateCcwIcon aria-hidden="true" />
          {t("calendar.startAgain", language)}
        </Button>
      ) : null}
    </div>
  );
}
