"use client";

/**
 * The whole request flow: the calendar, the pinned bar, and the sheet.
 *
 * These are one component because they are one piece of state. The dates a
 * guest taps on the grid are the dates the bar summarises and the dates the
 * form submits; splitting them across three components would mean lifting that
 * state into a fourth, and the page is a Server Component so there is nowhere
 * above to lift it to.
 *
 * ### Three places dates are checked, one function
 *
 * 1. The grid refuses to build a range across a night in `disabledDates`.
 * 2. `checkRequest` runs here, on every selection, so "stays here are 2 nights
 *    or more" arrives while the guest is still looking at the calendar — not
 *    after they have typed their name, their email and a note.
 * 3. `requestBooking` runs it again on the server, which is the answer that
 *    counts. The client cannot be trusted and is not.
 *
 * Step 2 passes `busy: []` deliberately. Overlap and gap days are already in
 * `disabledDates`, which the grid enforces by construction, and shipping every
 * busy range to the client to re-derive them would hand a guest the shape of
 * everyone else's stays for nothing.
 *
 * ### The bar
 *
 * `fixed` to the bottom of the viewport, which means it escapes the layout's
 * `max-w-[560px] mx-auto px-4` wrapper and has to rebuild that column itself.
 * The page pads its own bottom by the bar's height so the last row of the
 * calendar is never underneath it.
 */

import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { XIcon } from "lucide-react";

import { requestBooking } from "@/app/_actions/booking";
import type { RequestBookingResult } from "@/app/_actions/booking";
import { StayCalendar, type StayRange } from "@/components/stay-calendar";
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
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { checkRequest, type HouseRules } from "@/lib/availability";
import { nightsBetween, type DateStr } from "@/lib/dates";
import { failureMessage, rangeLabel, t, tn, type Lang } from "@/lib/i18n";

/* ============================================================
   TYPES
   ============================================================ */

export type RequestSheetProps = {
  /** The house's public slug. The Server Action looks the house up by it. */
  slug: string;
  language: Lang;
  /** From `houseRules()`. Used for the pre-flight check and the guest cap. */
  rules: HouseRules;
  /** The server's day, so a wrong phone clock cannot move it. */
  today: DateStr;
  /** `bookableWindow().min` — the earliest night on offer. */
  min: DateStr;
  /** `bookableWindow().max` — the latest check-out, or `null` for no end. */
  max: DateStr | null;
  /** Nights that are gone. Arrays in, Sets here: the payload stays small. */
  disabledDates: readonly DateStr[];
  /** Nights someone has asked for. Still tappable — the owner decides. */
  pendingDates: readonly DateStr[];
};

/** The action's `field` values that have a control on this form. */
const FOCUSABLE_FIELDS = new Set(["guestName", "guestEmail", "guests", "note"]);

/* ============================================================
   FIELD
   ============================================================ */

/**
 * Label, control, and one line underneath — the hint, or the problem.
 *
 * Module level on purpose: a component declared inside the form gets a new
 * identity on every render, which remounts its input and drops the caret
 * mid-word.
 */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
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

/** Whichever line is under the field right now is the one to announce. */
function describedBy(id: string, error: string | null, hint?: string) {
  if (error) return `${id}-error`;
  return hint ? `${id}-hint` : undefined;
}

/* ============================================================
   COMPONENT
   ============================================================ */

export function RequestSheet({
  slug,
  language,
  rules,
  today,
  min,
  max,
  disabledDates,
  pendingDates,
}: RequestSheetProps) {
  const baseId = useId();
  const router = useRouter();

  const takenNights = useMemo(() => new Set(disabledDates), [disabledDates]);
  const pendingNights = useMemo(() => new Set(pendingDates), [pendingDates]);

  const [range, setRange] = useState<StayRange | null>(null);
  const [open, setOpen] = useState(false);

  // Controlled, because React resets an uncontrolled form once its action
  // settles — and someone who mistyped their email should not lose their note
  // to find that out.
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [note, setNote] = useState("");
  const [guests, setGuests] = useState(() =>
    String(Math.min(2, Math.max(1, rules.maxGuests))),
  );

  const [state, formAction, pending] = useActionState<
    RequestBookingResult | null,
    FormData
  >(async (_previous, formData) => requestBooking(formData), null);

  // Derived, not stored. It holds past the action's own `pending` flag — the
  // request succeeded and the router is on its way to /b/[token] — so the
  // button never flicks back to "Send request" mid-navigation and invites a
  // second submit.
  const sent = state?.ok === true;

  // An error stands until the guest starts fixing it. Holding the dismissed
  // result rather than a flag means the next submission arrives as a new object
  // and shows its own message with nothing to reset.
  const [dismissed, setDismissed] = useState<RequestBookingResult | null>(null);

  const calendarRef = useRef<HTMLDivElement>(null);

  const idFor = useCallback((field: string) => `${baseId}-${field}`, [baseId]);

  useEffect(() => {
    if (!state) return;

    if (state.ok) {
      // The booking exists and this token is the only way back to it.
      router.push(`/b/${state.token}`);
      return;
    }

    // One error at a time, and take the guest to it rather than describing
    // where it is. Every control's id is `${baseId}-${name}` and the action's
    // `field` is that name. No smooth scroll: reduced motion is a setting.
    if (!state.field || !FOCUSABLE_FIELDS.has(state.field)) return;
    const node = document.getElementById(`${baseId}-${state.field}`);
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    node.focus();
  }, [state, router, baseId]);

  const failed = state && !state.ok && dismissed !== state ? state : null;

  const errorFor = (field: string) =>
    failed?.field === field ? failed.error : null;

  /** Both date keys land on the one control that owns them: the calendar. */
  const dateError =
    failed && (failed.field === "startDate" || failed.field === "endDate")
      ? failed.error
      : null;

  const formError = failed && !failed.field ? failed.error : null;

  function touched() {
    setDismissed(state);
  }

  const complete = range?.end != null;

  /**
   * The house's own rules, checked while the calendar is still on screen.
   *
   * `busy: []` because the grid has already answered the overlap and gap
   * questions — those nights are not tappable. What is left is length, the
   * season and the past, none of which a set of disabled days can express.
   * `guests: 1` keeps this about dates: the headcount has its own control and
   * its own message.
   */
  const dateProblem = useMemo(() => {
    if (!range || range.end == null) return null;
    const result = checkRequest(
      rules,
      [],
      { startDate: range.start, endDate: range.end, guests: 1 },
      today,
    );
    if (result.ok) return null;
    return failureMessage(result.code, language, rules, {
      startDate: range.start,
    });
  }, [range, rules, today, language]);

  const ready = complete && !dateProblem;

  const summary =
    range?.end != null
      ? t("form.dates.summary", language, {
          range: rangeLabel(range.start, range.end, language),
          nights: tn(
            "count.nights",
            nightsBetween(range.start, range.end),
            language,
          ),
        })
      : t("form.dates.placeholder", language);

  function focusCalendar() {
    const node = calendarRef.current;
    if (!node) return;
    node.focus({ preventScroll: true });
    node.scrollIntoView({ block: "center" });
  }

  /**
   * The one button on the screen, and it always does something.
   *
   * With no dates picked it takes the guest to the calendar instead of sitting
   * there greyed out. A disabled primary action on a phone reads as a broken
   * page, and the thing it wants is often scrolled off-screen.
   */
  function handleCta() {
    if (ready) {
      setOpen(true);
      return;
    }
    focusCalendar();
  }

  // Up to the house's cap. The control cannot express a number the owner has
  // already refused, so TOO_MANY_GUESTS is a server-side backstop, not a
  // message anybody should see.
  const guestOptions = useMemo(() => {
    const cap = Math.max(1, Math.min(rules.maxGuests, 30));
    return Array.from({ length: cap }, (_, index) => index + 1);
  }, [rules.maxGuests]);

  const emailHint = t("form.email.hint", language);
  const busy = pending || sent;

  return (
    <>
      {/* Calendar ------------------------------------------------------------ */}
      {/* Focusable so the bar has somewhere definite to send someone who has
          not picked dates yet, and so that landing there is announced. */}
      <div ref={calendarRef} tabIndex={-1} className="outline-none">
        <StayCalendar
          disabledDates={takenNights}
          pendingDates={pendingNights}
          min={min}
          max={max}
          value={range}
          // The setter itself: stable, and the calendar only ever hands back a
          // value, never an updater.
          onChange={setRange}
          language={language}
        />
      </div>

      {dateProblem ? (
        <p role="status" className="text-xs text-destructive">
          {dateProblem}
        </p>
      ) : null}

      {/* Pinned bar ---------------------------------------------------------- */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 supports-backdrop-filter:bg-background/80 supports-backdrop-filter:backdrop-blur">
        {/* The layout's column, rebuilt: `fixed` left the wrapper behind. */}
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
          <p
            className={
              dateProblem
                ? "truncate text-xs text-destructive"
                : "num truncate text-xs text-muted-foreground"
            }
          >
            {dateProblem ?? summary}
          </p>
          <Button
            type="button"
            onClick={handleCta}
            aria-haspopup="dialog"
            aria-expanded={open}
            className="h-11 w-full text-base"
          >
            {t("house.cta", language)}
          </Button>
        </div>
      </div>

      {/* Sheet --------------------------------------------------------------- */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          // shadcn's own close control is 28px, under the 44px floor, and lives
          // in a file this slice does not own. Ours is below, at 44.
          showCloseButton={false}
          className="max-h-[92svh] gap-0 overflow-y-auto rounded-t-xl p-0"
        >
          <SheetHeader className="flex-row items-start justify-between gap-2 px-4 pt-4 pb-2">
            <div className="flex flex-col gap-0.5">
              <SheetTitle>{t("form.title", language)}</SheetTitle>
              <SheetDescription>{t("form.intro", language)}</SheetDescription>
            </div>
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label={t("common.close", language)}
                className="size-11 shrink-0 p-0"
              >
                <XIcon className="size-5" aria-hidden="true" />
              </Button>
            </SheetClose>
          </SheetHeader>

          <form action={formAction} noValidate className="flex flex-col">
            {/* The action reads these; the calendar owns them. */}
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="startDate" value={range?.start ?? ""} />
            <input type="hidden" name="endDate" value={range?.end ?? ""} />

            <div className="flex flex-col gap-5 px-4 pb-4">
              {/* Dates ------------------------------------------------------ */}
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">{t("form.dates", language)}</p>
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
                  <p className="num text-sm">{summary}</p>
                  <SheetClose asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-11 shrink-0 px-3 text-xs text-muted-foreground"
                    >
                      {t("form.dates.change", language)}
                    </Button>
                  </SheetClose>
                </div>
                {dateError ? (
                  <p role="alert" className="text-xs text-destructive">
                    {dateError}
                  </p>
                ) : null}
              </div>

              {/* Name ------------------------------------------------------- */}
              <Field
                id={idFor("guestName")}
                label={t("form.name", language)}
                error={errorFor("guestName")}
              >
                <Input
                  id={idFor("guestName")}
                  name="guestName"
                  value={guestName}
                  onChange={(event) => {
                    setGuestName(event.target.value);
                    touched();
                  }}
                  placeholder={t("form.name.placeholder", language)}
                  autoComplete="name"
                  autoCapitalize="words"
                  spellCheck={false}
                  maxLength={80}
                  required
                  disabled={busy}
                  aria-invalid={errorFor("guestName") ? true : undefined}
                  aria-describedby={describedBy(
                    idFor("guestName"),
                    errorFor("guestName"),
                  )}
                  className="h-11 text-base"
                />
              </Field>

              {/* Email ------------------------------------------------------ */}
              <Field
                id={idFor("guestEmail")}
                label={t("form.email", language)}
                hint={emailHint}
                error={errorFor("guestEmail")}
              >
                <Input
                  id={idFor("guestEmail")}
                  name="guestEmail"
                  type="email"
                  inputMode="email"
                  value={guestEmail}
                  onChange={(event) => {
                    setGuestEmail(event.target.value);
                    touched();
                  }}
                  placeholder={t("form.email.placeholder", language)}
                  autoComplete="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  maxLength={254}
                  required
                  disabled={busy}
                  aria-invalid={errorFor("guestEmail") ? true : undefined}
                  aria-describedby={describedBy(
                    idFor("guestEmail"),
                    errorFor("guestEmail"),
                    emailHint,
                  )}
                  className="h-11 text-base"
                />
              </Field>

              {/* Guests ----------------------------------------------------- */}
              <Field
                id={idFor("guests")}
                label={t("form.guests", language)}
                error={errorFor("guests")}
              >
                <Select
                  value={guests}
                  onValueChange={(next) => {
                    setGuests(next);
                    touched();
                  }}
                  disabled={busy}
                >
                  <SelectTrigger
                    id={idFor("guests")}
                    aria-invalid={errorFor("guests") ? true : undefined}
                    aria-describedby={describedBy(
                      idFor("guests"),
                      errorFor("guests"),
                    )}
                    // The trigger's own height is `data-[size=default]:h-8`,
                    // and an attribute selector out-specifies a plain `h-11`.
                    className="w-full text-base data-[size=default]:h-11"
                  >
                    <SelectValue>
                      {tn("count.guests", Number(guests), language)}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {guestOptions.map((count) => (
                      <SelectItem
                        key={count}
                        value={String(count)}
                        className="min-h-11"
                      >
                        {tn("count.guests", count, language)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Radix keeps the value in React, not in the DOM. */}
                <input type="hidden" name="guests" value={guests} />
              </Field>

              {/* Note ------------------------------------------------------- */}
              <Field
                id={idFor("note")}
                label={t("form.note", language)}
                error={errorFor("note")}
              >
                <Textarea
                  id={idFor("note")}
                  name="note"
                  value={note}
                  onChange={(event) => {
                    setNote(event.target.value);
                    touched();
                  }}
                  placeholder={t("form.note.placeholder", language)}
                  maxLength={500}
                  rows={3}
                  disabled={busy}
                  aria-invalid={errorFor("note") ? true : undefined}
                  aria-describedby={describedBy(idFor("note"), errorFor("note"))}
                  className="min-h-24 text-base"
                />
              </Field>
            </div>

            {/* Send --------------------------------------------------------- */}
            <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-popover px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {formError ? (
                <p role="alert" className="text-xs text-destructive">
                  {formError}
                </p>
              ) : null}
              <Button
                type="submit"
                disabled={busy || !complete}
                className="h-11 w-full text-base"
              >
                {sent
                  ? t("form.sent", language)
                  : pending
                    ? t("form.submitting", language)
                    : t("form.submit", language)}
              </Button>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
