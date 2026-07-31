"use client";

import { useActionState, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { updateHouse, type HouseFormState } from "@/app/_actions/house";
import type { HouseLanguage } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/**
 * Everything about the house an owner can change, on one screen.
 *
 * Three groups, in the order someone actually thinks about them: what the house
 * is, what you will say yes to, and how much a stranger holding the link gets
 * to see. The four counts explain themselves once, above all of them, rather
 * than four times underneath: a row that reads "Shortest stay · 2 · nights" has
 * already said what it means, and four hints stacked under four spinners is a
 * control panel. The one exception is a gap of zero — the single value whose
 * meaning is not on its face — so that line appears only when it is zero.
 *
 * The save bar is mounted by a change, not by the screen. At rest there is
 * nothing to save, and a permanent bar offering it both lies and covers the
 * last line of the form.
 *
 * Values live in React state rather than the DOM. React resets an uncontrolled
 * form once its action settles, and someone who mistyped one number should not
 * lose the other ten answers to find that out.
 *
 * Two contracts from `updateHouse` shape this file:
 *  - `showGuestNames` needs an explicit "true"/"false", because an unchecked box
 *    sends nothing and nothing means "unchanged". Hence the hidden input.
 *  - a failure names one field at a time and `field` is the input's `name`, so
 *    the `name` attributes below are exactly the action's keys.
 */

/** Only what the form writes. The slug and the feed token stay on the server. */
export type HouseSettings = {
  id: string;
  name: string;
  town: string;
  country: string;
  language: HouseLanguage;
  blurb: string | null;
  minNights: number;
  maxNights: number;
  gapDays: number;
  maxGuests: number;
  bookableFrom: string | null;
  bookableTo: string | null;
  showGuestNames: boolean;
};

type TextField =
  | "name"
  | "town"
  | "country"
  | "language"
  | "blurb"
  | "minNights"
  | "maxNights"
  | "gapDays"
  | "maxGuests"
  | "bookableFrom"
  | "bookableTo";

type CountName = "minNights" | "maxNights" | "gapDays" | "maxGuests";

/**
 * Each language in its own language. Also what the trigger renders: a bare
 * `<SelectValue />` resolves its text from the items, which only exist once the
 * popover has mounted, so the server sends an empty box and the choice appears
 * a beat later. Passing the label explicitly renders it in the first HTML.
 */
const LANGUAGE_LABELS: Record<HouseLanguage, string> = {
  en: "English",
  tr: "Türkçe",
};

type FieldName = TextField | "showGuestNames";

/** Digits only — a count field should never be able to hold "2 nights". */
function digits(value: string) {
  return value.replace(/\D/g, "");
}

/**
 * The house as the form holds it: strings, because that is what an input has.
 * Called twice — once to seed the state, once per render as the baseline the
 * save bar compares against — so the two can never describe different fields.
 */
function toValues(house: HouseSettings): Record<TextField, string> {
  return {
    name: house.name,
    town: house.town,
    country: house.country,
    language: house.language,
    blurb: house.blurb ?? "",
    minNights: String(house.minNights),
    maxNights: String(house.maxNights),
    gapDays: String(house.gapDays),
    maxGuests: String(house.maxGuests),
    bookableFrom: house.bookableFrom ?? "",
    bookableTo: house.bookableTo ?? "",
  };
}

/**
 * Label, control, and one line underneath: the explanation, or the problem.
 * `row` puts the label and a compact control on one line, the way a settings
 * list reads; the default stacks them, which is what a full-width text box needs.
 *
 * Defined at module level on purpose. A component declared inside the form gets
 * a new identity every render, which remounts its inputs and drops the caret
 * mid-word.
 */
function Field({
  id,
  label,
  hint,
  error,
  row = false,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  row?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={
          row
            ? "flex min-h-11 items-center justify-between gap-4"
            : "flex flex-col gap-2"
        }
      >
        <Label htmlFor={id} className={row ? "flex-1" : undefined}>
          {label}
        </Label>
        {children}
      </div>
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** Whichever line is currently under the field is the one to announce. */
function describedBy(id: string, error: string | null, hint?: string) {
  if (error) return `${id}-error`;
  return hint ? `${id}-hint` : undefined;
}

/** A whole number with its unit beside it, so the row reads as a sentence. */
function CountField({
  id,
  name,
  label,
  unit,
  hint,
  value,
  error,
  disabled,
  onChange,
}: {
  id: string;
  name: CountName;
  label: string;
  unit: string;
  /** Only where the number does not speak for itself. Usually absent. */
  hint?: string;
  value: string;
  error: string | null;
  disabled: boolean;
  /** Receives the value already stripped to digits. */
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={label} hint={hint} error={error} row>
      <div className="flex shrink-0 items-center gap-2">
        <Input
          id={id}
          name={name}
          value={value}
          onChange={(event) => onChange(digits(event.target.value))}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          maxLength={3}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, error, hint)}
          className="num h-11 w-16 text-center text-base"
        />
        <span className="w-11 text-xs text-muted-foreground">{unit}</span>
      </div>
    </Field>
  );
}

export function SettingsForm({ house }: { house: HouseSettings }) {
  const baseId = useId();

  const [state, formAction, pending] = useActionState<HouseFormState, FormData>(
    updateHouse,
    null,
  );

  const [values, setValues] = useState<Record<TextField, string>>(() =>
    toValues(house),
  );
  const [showGuestNames, setShowGuestNames] = useState(house.showGuestNames);

  // An error stands until the person starts fixing it. Holding the dismissed
  // result rather than a flag means the next submission arrives as a new object
  // and shows its message with nothing to reset.
  const [dismissed, setDismissed] = useState<HouseFormState>(null);

  useEffect(() => {
    if (!state) return;

    if (state.ok) {
      // One id, so saving twice replaces the toast rather than stacking it.
      toast.success("Changes saved.", { id: "house-settings" });
      return;
    }

    // Long form, one error at a time: take the person to it instead of
    // describing where it is. Every control's id is `${baseId}-${name}` and the
    // action's `field` is that name, so the lookup needs no ref plumbing. No
    // smooth scroll — reduced motion is a setting, not a preference to guess at.
    if (!state.field) return;
    const node = document.getElementById(`${baseId}-${state.field}`);
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    node.focus();
  }, [state, baseId]);

  const failed = state && !state.ok && dismissed !== state ? state : null;
  const formError = failed && !failed.field ? failed.error : null;

  // What is on screen against what is stored. A saved change revalidates
  // `/app`, so the house arrives back equal to the form and the bar leaves on
  // its own — no flag to reset and nothing to keep in step.
  const saved = toValues(house);
  const changed =
    showGuestNames !== house.showGuestNames ||
    (Object.keys(saved) as TextField[]).some(
      (field) => values[field] !== saved[field],
    );

  function errorFor(field: FieldName) {
    return failed?.field === field ? failed.error : null;
  }

  function set(field: TextField, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setDismissed(state);
  }

  /** The id the error effect looks up. Keep it equal to the input's `name`. */
  function idFor(field: FieldName) {
    return `${baseId}-${field}`;
  }

  const houseGroupId = `${baseId}-group-house`;
  const rulesGroupId = `${baseId}-group-rules`;
  const privacyGroupId = `${baseId}-group-privacy`;
  const seasonHintId = `${baseId}-season-hint`;
  const privacyHintId = `${baseId}-privacy-hint`;

  const nameHint = "Whatever your family calls it. Guests see this first.";
  const townHint =
    "Guests see the town. The address stays private until you approve them.";
  const languageHint =
    "The language your link and your guests' emails are written in.";
  const blurbHint =
    "A few lines about the house — what it is like, what is nearby. Optional.";

  // "0 days" reads as no rule at all, which is the one thing it is not.
  const gapHint =
    values.gapDays === "0"
      ? "Someone can arrive the same day the last person leaves."
      : undefined;

  const privacyError = errorFor("showGuestNames");

  // Only ever "en" or "tr" — it starts from the row and only changes through
  // the two items below. The guard is here so the label lookup is total.
  const languageValue: HouseLanguage =
    values.language === "tr" ? "tr" : "en";

  return (
    <form action={formAction} noValidate className="flex flex-col gap-8">
      <input type="hidden" name="houseId" value={house.id} />

      {/* The house ---------------------------------------------------------- */}
      <section aria-labelledby={houseGroupId} className="flex flex-col gap-5">
        {/* 22px Fraunces, the size a section heading is everywhere else in the
            product. At `text-sm font-medium` it was smaller than the fields it
            was introducing, which made it read as a caption about itself. */}
        <h2 id={houseGroupId} className="text-lg">
          The house
        </h2>

        <Field
          id={idFor("name")}
          label="House name"
          hint={nameHint}
          error={errorFor("name")}
        >
          <Input
            id={idFor("name")}
            name="name"
            value={values.name}
            onChange={(event) => set("name", event.target.value)}
            maxLength={80}
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            required
            disabled={pending}
            aria-invalid={errorFor("name") ? true : undefined}
            aria-describedby={describedBy(idFor("name"), errorFor("name"), nameHint)}
            className="h-11 text-base"
          />
        </Field>

        <Field
          id={idFor("town")}
          label="Town"
          hint={townHint}
          error={errorFor("town")}
        >
          <Input
            id={idFor("town")}
            name="town"
            value={values.town}
            onChange={(event) => set("town", event.target.value)}
            maxLength={80}
            autoComplete="address-level2"
            autoCapitalize="words"
            spellCheck={false}
            required
            disabled={pending}
            aria-invalid={errorFor("town") ? true : undefined}
            aria-describedby={describedBy(idFor("town"), errorFor("town"), townHint)}
            className="h-11 text-base"
          />
        </Field>

        <Field
          id={idFor("country")}
          label="Country"
          error={errorFor("country")}
        >
          <Input
            id={idFor("country")}
            name="country"
            value={values.country}
            onChange={(event) => set("country", event.target.value)}
            maxLength={80}
            autoComplete="country-name"
            autoCapitalize="words"
            spellCheck={false}
            required
            disabled={pending}
            aria-invalid={errorFor("country") ? true : undefined}
            aria-describedby={describedBy(idFor("country"), errorFor("country"))}
            className="h-11 text-base"
          />
        </Field>

        <Field
          id={idFor("language")}
          label="Guest language"
          hint={languageHint}
          error={errorFor("language")}
          row
        >
          <Select
            value={values.language}
            onValueChange={(next) => set("language", next)}
            disabled={pending}
          >
            <SelectTrigger
              id={idFor("language")}
              aria-invalid={errorFor("language") ? true : undefined}
              aria-describedby={describedBy(
                idFor("language"),
                errorFor("language"),
                languageHint,
              )}
              // The trigger's own height is `data-[size=default]:h-8`, and an
              // attribute selector out-specifies a plain `h-11`. Qualify it the
              // same way or the control ships at 32px.
              className="w-36 shrink-0 text-base data-[size=default]:h-11"
            >
              <SelectValue>{LANGUAGE_LABELS[languageValue]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LANGUAGE_LABELS) as HouseLanguage[]).map((code) => (
                <SelectItem key={code} value={code} className="min-h-11">
                  {LANGUAGE_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Radix keeps the value in React, not in the DOM. This is what the
              action reads. */}
          <input type="hidden" name="language" value={values.language} />
        </Field>

        <Field
          id={idFor("blurb")}
          label="Description"
          hint={blurbHint}
          error={errorFor("blurb")}
        >
          <Textarea
            id={idFor("blurb")}
            name="blurb"
            value={values.blurb}
            onChange={(event) => set("blurb", event.target.value)}
            maxLength={600}
            rows={4}
            disabled={pending}
            placeholder="Five minutes from the sea, three bedrooms, a fig tree that drops fruit on the terrace all August."
            aria-invalid={errorFor("blurb") ? true : undefined}
            aria-describedby={describedBy(
              idFor("blurb"),
              errorFor("blurb"),
              blurbHint,
            )}
            className="min-h-28 text-base"
          />
        </Field>
      </section>

      {/* What you'll say yes to --------------------------------------------- */}
      <section aria-labelledby={rulesGroupId} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h2 id={rulesGroupId} className="text-lg">
            What you&rsquo;ll say yes to
          </h2>
          <p className="text-sm text-muted-foreground">
            Nobody can ask for anything outside these, so you are never the one
            saying no.
          </p>
        </div>

        <CountField
          id={idFor("minNights")}
          name="minNights"
          label="Shortest stay"
          unit="nights"
          value={values.minNights}
          error={errorFor("minNights")}
          disabled={pending}
          onChange={(next) => set("minNights", next)}
        />

        <CountField
          id={idFor("maxNights")}
          name="maxNights"
          label="Longest stay"
          unit="nights"
          value={values.maxNights}
          error={errorFor("maxNights")}
          disabled={pending}
          onChange={(next) => set("maxNights", next)}
        />

        <CountField
          id={idFor("gapDays")}
          name="gapDays"
          label="Gap between stays"
          unit="days"
          // Every other row means what it says. Zero does not — it looks like
          // "no rule" and is in fact a decision about the changeover day — so
          // this is the one line that stays, and only while it is zero.
          hint={gapHint}
          value={values.gapDays}
          error={errorFor("gapDays")}
          disabled={pending}
          onChange={(next) => set("gapDays", next)}
        />

        <CountField
          id={idFor("maxGuests")}
          name="maxGuests"
          label="Room for"
          unit="people"
          value={values.maxGuests}
          error={errorFor("maxGuests")}
          disabled={pending}
          onChange={(next) => set("maxGuests", next)}
        />

        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium">Season</p>
            <p id={seasonHintId} className="text-xs text-muted-foreground">
              Guests can only ask for dates inside this window. Leave both empty
              and the house is open all year.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field
              id={idFor("bookableFrom")}
              label="First day"
              error={errorFor("bookableFrom")}
            >
              <Input
                id={idFor("bookableFrom")}
                name="bookableFrom"
                type="date"
                value={values.bookableFrom}
                onChange={(event) => set("bookableFrom", event.target.value)}
                disabled={pending}
                aria-invalid={errorFor("bookableFrom") ? true : undefined}
                aria-describedby={
                  errorFor("bookableFrom")
                    ? `${idFor("bookableFrom")}-error`
                    : seasonHintId
                }
                className="num h-11 text-base"
              />
            </Field>

            <Field
              id={idFor("bookableTo")}
              label="Last day"
              error={errorFor("bookableTo")}
            >
              <Input
                id={idFor("bookableTo")}
                name="bookableTo"
                type="date"
                value={values.bookableTo}
                onChange={(event) => set("bookableTo", event.target.value)}
                disabled={pending}
                aria-invalid={errorFor("bookableTo") ? true : undefined}
                aria-describedby={
                  errorFor("bookableTo")
                    ? `${idFor("bookableTo")}-error`
                    : seasonHintId
                }
                className="num h-11 text-base"
              />
            </Field>
          </div>
        </div>
      </section>

      {/* Privacy ------------------------------------------------------------ */}
      <section aria-labelledby={privacyGroupId} className="flex flex-col gap-4">
        <h2 id={privacyGroupId} className="text-lg">
          Privacy
        </h2>

        <div className="flex flex-col gap-1.5">
          <Label
            htmlFor={idFor("showGuestNames")}
            className="min-h-11 cursor-pointer justify-between gap-4"
          >
            <span className="flex-1">Show guest names on the calendar</span>
            <input
              id={idFor("showGuestNames")}
              type="checkbox"
              checked={showGuestNames}
              onChange={(event) => {
                setShowGuestNames(event.target.checked);
                setDismissed(state);
              }}
              disabled={pending}
              aria-invalid={privacyError ? true : undefined}
              aria-describedby={
                privacyError
                  ? `${idFor("showGuestNames")}-error`
                  : privacyHintId
              }
              className="size-5 shrink-0 accent-foreground"
            />
          </Label>

          {privacyError ? (
            <p
              id={`${idFor("showGuestNames")}-error`}
              role="alert"
              className="text-xs text-destructive"
            >
              {privacyError}
            </p>
          ) : (
            <p id={privacyHintId} className="text-xs text-muted-foreground">
              {showGuestNames
                ? "Anyone with your link sees who is staying on each date."
                : "Anyone with your link sees that a date is taken, not who has it."}
            </p>
          )}

          {/* An unchecked box sends nothing, and nothing means "unchanged". */}
          <input
            type="hidden"
            name="showGuestNames"
            value={String(showGuestNames)}
          />
        </div>
      </section>

      {/* Save ---------------------------------------------------------------
          Only once there is something to save. It is opaque, not
          `bg-background/90 backdrop-blur`: a translucent bar that is always
          there leaves the last line of the form legible *through* the button,
          which reads as a rendering fault rather than as depth. Kept mounted
          while a save is in flight, and while an error from it is unread. */}
      {changed || pending || formError ? (
        <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {formError ? (
            <p role="alert" className="text-xs text-destructive">
              {formError}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="h-11 w-full">
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
