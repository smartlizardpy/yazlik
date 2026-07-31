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
 * *shapes*, so the calendar survives greyscale and colourblindness with no
 * legend. shadcn's calendar paints the selection with the blue accent — that is
 * overridden below and must stay overridden.
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
import { DEFAULT_LANG, dayLabel, t, tn, type Lang } from "@/lib/i18n";
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
  // Taken: a filled neutral, the number struck through and dropped in
  // contrast. Three signals, none of them colour.
  taken: "bg-muted [&>button]:text-muted-foreground [&>button]:line-through",
  // Pending: a dashed outline and nothing else. Still tappable, so it must not
  // read as heavier than a free night.
  pending: "outline-2 outline-dashed -outline-offset-2 outline-muted-foreground",
} satisfies Record<string, string>;

const CALENDAR_CLASS_NAMES = {
  // shadcn ships `w-fit`; a phone wants the whole column.
  root: "w-full",
  // shadcn marks today with `bg-muted`, which is the exact fill "taken" uses.
  // A dot under the number instead: a different shape, not a competing fill.
  today:
    "after:absolute after:bottom-1 after:left-1/2 after:size-1 after:-translate-x-1/2 after:rounded-full after:bg-foreground",
  // No `opacity-50`: it would wash out the taken fill until it vanished. Days
  // outside the season get muted text and no fill, so they read as absent
  // rather than as booked.
  disabled: "text-muted-foreground",
  // The cell fills and the ±16px bleed shadcn uses to bridge a gutter between
  // cells are dropped: our cells sit flush, so the buttons already form a
  // continuous bar and the bleed would only paint past the ends.
  range_start: "rounded-l-(--cell-radius)",
  range_middle: "rounded-none",
  range_end: "rounded-r-(--cell-radius)",
  footer: "mt-4 border-t border-border pt-3",
  day_button: [
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

  const modifiers = useMemo(
    () => ({
      taken: (date: Date) => disabledDates.has(toStr(date)),
      pending: (date: Date) => pendingDates.has(toStr(date)),
    }),
    [disabledDates, pendingDates],
  );

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

  let footer;
  if (!value) {
    footer = <p className="text-sm text-muted-foreground">{t("calendar.empty", language)}</p>;
  } else if (value.end == null || chosenLastNight == null) {
    footer = (
      <p className="text-sm text-muted-foreground">
        {t("calendar.picking", language, { day: dayLabel(value.start, language) })}
      </p>
    );
  } else {
    footer = (
      <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-3">
        <div>
          <p className="text-xs text-muted-foreground">{t("calendar.checkIn", language)}</p>
          <p className="text-sm font-medium tabular-nums">
            {dayLabel(value.start, language)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{t("calendar.checkOut", language)}</p>
          <p className="text-sm font-medium tabular-nums">
            {dayLabel(value.end, language)}
          </p>
        </div>
        <p className="text-sm font-medium tabular-nums">
          {tn("count.nights", nightsBetween(value.start, value.end), language)}
        </p>
      </div>
    );
  }

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
        defaultMonth={toDate(value?.start ?? min)}
        footer={footer}
        // 44px: the floor for a touch target, and it sizes the previous and
        // next buttons as well as the day cells.
        className="w-full p-0 [--cell-size:--spacing(11)]"
      />

      {value ? (
        <Button
          type="button"
          variant="ghost"
          onClick={handleReset}
          className="mt-1 h-11 px-3 text-muted-foreground"
        >
          <RotateCcwIcon aria-hidden="true" />
          {t("calendar.startAgain", language)}
        </Button>
      ) : null}
    </div>
  );
}
