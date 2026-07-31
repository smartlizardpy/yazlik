"use client";

/**
 * Asking for a week, as four questions instead of one form.
 *
 * A cousin opening this link is not filling in a booking form, they are asking
 * a favour of someone they know. So the sheet asks what a host would ask, one
 * thing at a time, in the order a person would say it out loud:
 *
 *   1. When would you like to come?          — the calendar
 *   2. Who's coming?                          — a name and how many of you
 *   3. Anything the owner should know?        — the note, and where to reply
 *   4. Does this look right?                  — the ask, written out
 *
 * Four screens, dots at the top, Back and Next at the bottom. The last button
 * says "Ask for these dates", because that is what pressing it does.
 *
 * ### Next is never dead
 *
 * A disabled primary button on a phone reads as a broken page — the thing it
 * wants is usually off-screen and it never says what. So Next is always ink and
 * always tappable; a step that is not finished answers with a sentence saying
 * what is missing and puts the caret in the field that is missing it. Checking
 * happens per step, which is the point of steps: nobody should reach the end and
 * be sent back.
 *
 * ### Three places dates are checked, one function
 *
 * 1. The grid refuses to build a range across a night in `disabledDates`.
 * 2. `checkRequest` runs here, on every selection, so "stays here are 2 nights
 *    or more" arrives while the calendar is still on screen.
 * 3. `requestBooking` runs it again on the server, which is the answer that
 *    counts. The client cannot be trusted and is not.
 *
 * Step 2 passes `busy: []` deliberately. Overlap and gap days are already in
 * `disabledDates`, which the grid enforces by construction, and shipping every
 * busy range to the client to re-derive them would hand a guest the shape of
 * everyone else's stays for nothing.
 *
 * ### Where the values live
 *
 * In React, all of them, always — never in the DOM of the step that is showing.
 * A step that is not on screen is unmounted, so an input with a `name` on it
 * would drop out of the FormData the moment the guest moved on. The visible
 * controls are therefore nameless and a single block of hidden inputs, rendered
 * on every step, is what the Server Action actually reads. One place, one value,
 * no step ordering to get wrong later.
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
import { StepDots } from "@/components/step-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { checkRequest, type HouseRules } from "@/lib/availability";
import { nightsBetween, type DateStr } from "@/lib/dates";
import { failureMessage, humanRange, t, tn, type Lang } from "@/lib/i18n";

/* ============================================================
   TYPES
   ============================================================ */

export type RequestSheetProps = {
  /** The house's public slug. The Server Action looks the house up by it. */
  slug: string;
  /** Shown on the last screen, so the ask reads as an ask about a place. */
  houseName: string;
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

/* ============================================================
   STEPS
   ============================================================ */

const WHEN = 0;
const WHO = 1;
const SAY = 2;
const CHECK = 3;
const TOTAL_STEPS = 4;

/**
 * Which screen owns each `field` the Server Action can blame.
 *
 * The server checks everything again, and it is allowed to disagree with the
 * client — a night can go while someone is typing their name. When it does, the
 * flow walks back to the step that owns the problem rather than showing a red
 * line on a screen that has nothing to do with it.
 */
const STEP_OF_FIELD: Record<string, number> = {
  startDate: WHEN,
  endDate: WHEN,
  guestName: WHO,
  guests: WHO,
  guestEmail: SAY,
  note: SAY,
};

/**
 * Enough to catch a typo, and nothing more. `zod`'s `z.email()` on the server is
 * the real answer; this only exists so the guest hears about a missing `@`
 * before they press the last button rather than after.
 */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * What a step says when it is not finished, and which control it is about.
 *
 * `field` is not decoration. A message that belongs to a control is rendered
 * *under that control*, never down in the button bar: tapping Next puts the
 * caret in the empty field, the keyboard comes up, and on a phone the keyboard
 * covers the bar. An answer the guest cannot see is not an answer.
 */
type StepProblem = { message: string; field?: string };

/* ============================================================
   COMPONENT
   ============================================================ */

export function RequestSheet({
  slug,
  houseName,
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
  const [step, setStep] = useState(WHEN);
  const [stepProblem, setStepProblem] = useState<StepProblem | null>(null);

  // Controlled, because React resets an uncontrolled form once its action
  // settles — and someone who mistyped their email should not lose their note
  // to find that out. It is also what lets a step unmount without taking its
  // value with it.
  const [guestName, setGuestName] = useState("");
  const [guestEmail, setGuestEmail] = useState("");
  const [note, setNote] = useState("");
  const [guests, setGuests] = useState(() =>
    String(Math.min(2, Math.max(1, rules.maxGuests))),
  );

  const [state, formAction, pending] = useActionState<
    RequestBookingResult | null,
    FormData
  >(async (_previous, formData) => {
    const result = await requestBooking(formData);
    // The server checks everything again, and it is allowed to disagree — a
    // night can go while somebody is typing their name. When it does, walk
    // back to the screen that owns the field it blamed, here, in the same
    // update that stores the refusal. Doing it afterwards in an effect would
    // render the red line once on the wrong screen first.
    if (!result.ok && result.field !== undefined) {
      const target = STEP_OF_FIELD[result.field];
      if (target !== undefined) setStep(target);
    }
    return result;
  }, null);

  // Derived, not stored. It holds past the action's own `pending` flag — the
  // request succeeded and the router is on its way to /b/[token] — so the
  // button never flicks back to "Ask for these dates" mid-navigation and
  // invites a second submit.
  const sent = state?.ok === true;
  const busy = pending || sent;

  // An error stands until the guest starts fixing it. Holding the dismissed
  // result rather than a flag means the next submission arrives as a new object
  // and shows its own message with nothing to reset.
  const [dismissed, setDismissed] = useState<RequestBookingResult | null>(null);
  const failed = state && !state.ok && dismissed !== state ? state : null;

  const idFor = useCallback((field: string) => `${baseId}-${field}`, [baseId]);

  /**
   * The one line under a control, whoever objected.
   *
   * The server's refusal and this step's own refusal land in the same slot, so
   * a control never grows two red sentences and there is never a question about
   * which one is current.
   */
  const messageFor = (field: string) =>
    (failed?.field === field ? failed.error : null) ??
    (stepProblem?.field === field ? stepProblem.message : null);

  const formError = failed && !failed.field ? failed.error : null;

  function touched() {
    setDismissed(state);
    setStepProblem(null);
  }

  /**
   * The house's own rules, checked while the calendar is still on screen.
   *
   * `busy: []` because the grid has already answered the overlap and gap
   * questions — those nights are not tappable. What is left is length, the
   * season and the past, none of which a set of disabled days can express.
   * `guests: 1` keeps this about dates: the headcount has its own screen and
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

  const nights =
    range?.end != null ? nightsBetween(range.start, range.end) : null;

  /* ---------- per-step checking ------------------------------------- */

  /**
   * What is stopping this step, if anything.
   *
   * Every message is a sentence a person can act on, and every one of them
   * names the control it belongs to, so the answer to "what's missing" is both
   * said and pointed at.
   */
  const problemOn = useCallback(
    (index: number): StepProblem | null => {
      if (index === WHEN) {
        if (range?.end == null) return { message: t("form.step.when.missing", language) };
        if (dateProblem) return { message: dateProblem };
        return null;
      }
      if (index === WHO) {
        if (guestName.trim() === "") {
          return { message: t("form.name.required", language), field: "guestName" };
        }
        return null;
      }
      if (index === SAY) {
        const email = guestEmail.trim();
        if (email === "") {
          return { message: t("form.email.required", language), field: "guestEmail" };
        }
        if (!LOOKS_LIKE_EMAIL.test(email)) {
          return { message: t("form.email.invalid", language), field: "guestEmail" };
        }
        return null;
      }
      return null;
    },
    [range, dateProblem, guestName, guestEmail, language],
  );

  /** The earliest step that is not finished, or `from` if they all are. */
  const firstUnfinished = useCallback(
    (from: number) => {
      for (let index = 0; index < from; index++) {
        if (problemOn(index)) return index;
      }
      return from;
    },
    [problemOn],
  );

  function goNext() {
    const problem = problemOn(step);
    if (problem) {
      setStepProblem(problem);
      if (problem.field) {
        // The message is already rendering under this control, so the keyboard
        // arriving over the button bar costs nothing.
        document.getElementById(idFor(problem.field))?.focus();
      }
      return;
    }
    setStepProblem(null);
    setStep((current) => Math.min(current + 1, CHECK));
  }

  function goBack() {
    setStepProblem(null);
    // Back from the first question is back to the house. The pair stays put
    // rather than appearing on step two, so the buttons never move under a
    // thumb that is already reaching for them.
    if (step === WHEN) {
      setOpen(false);
      return;
    }
    setStep((current) => Math.max(current - 1, WHEN));
  }

  /**
   * The one button on the house page, and it always opens the flow.
   *
   * It used to send anyone without dates to the calendar instead, which on a
   * phone looked exactly like nothing happening. Step one *is* the calendar now,
   * so there is nothing to pick first. If dates were picked on the page and have
   * since gone stale, the flow opens on the step that needs fixing.
   */
  function handleCta() {
    setStepProblem(null);
    setStep((current) => firstUnfinished(current));
    setOpen(true);
  }

  /* ---------- focus and scroll -------------------------------------- */

  const titleRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const shownStep = useRef(step);

  // A new question is a new screen. Move focus to it so a screen reader reads
  // it out, and put the scroll back at the top so the next question is not
  // half-way down where the last one ended.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    titleRef.current?.focus();
  }, [step]);

  // The server's answer, acted on once. The step has already moved by the time
  // this runs — the action did that — so all that is left is to navigate on a
  // yes, or land the caret on the offending control on a no. `handled` is what
  // stops a refusal from five taps ago grabbing focus again on a later render.
  const handled = useRef<RequestBookingResult | null>(null);

  useEffect(() => {
    if (!state || handled.current === state) return;
    handled.current = state;

    if (state.ok) {
      // The booking exists and this token is the only way back to it.
      router.push(`/b/${state.token}`);
      return;
    }

    if (!state.field) return;
    // Every control's id is `${baseId}-${name}` and the action's `field` is
    // that name. No smooth scroll: reduced motion is a setting.
    const node = document.getElementById(`${baseId}-${state.field}`);
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    node.focus();
  }, [state, router, baseId]);

  /* ---------- copy --------------------------------------------------- */

  const question = [
    t("form.step.when", language),
    t("form.step.who", language),
    t("form.step.say", language),
    t("form.step.check", language),
  ][step];

  // Up to the house's cap. The control cannot express a number the owner has
  // already refused, so TOO_MANY_GUESTS is a server-side backstop, not a
  // message anybody should see.
  const guestOptions = useMemo(() => {
    const cap = Math.max(1, Math.min(rules.maxGuests, 30));
    return Array.from({ length: cap }, (_, index) => index + 1);
  }, [rules.maxGuests]);

  // One line above the buttons, for the refusals that belong to no single
  // control: the dates (which own a whole screen) and whatever the server said
  // about the request as a whole.
  const footerMessage =
    (stepProblem && !stepProblem.field ? stepProblem.message : null) ??
    (step === CHECK ? formError : null) ??
    (step === WHEN ? dateProblem : null);

  return (
    <>
      {/* Calendar ------------------------------------------------------------ */}
      {/* Also on the page, not only inside the flow: someone who was sent this
          link wants to know whether August is free before they commit to
          answering four questions. Same state as step one, so a night tapped
          here is already chosen when the sheet opens. */}
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

      {dateProblem ? (
        <p role="status" className="text-sm text-destructive">
          {dateProblem}
        </p>
      ) : null}

      {/* Pinned bar ---------------------------------------------------------- */}
      {/* `fixed`, which means it escapes the layout's centred column and has to
          rebuild it. The page pads its own bottom by this bar's height. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 supports-backdrop-filter:bg-background/80 supports-backdrop-filter:backdrop-blur">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {/* Nothing here until there is something to say. The bar used to
              carry a grey "Pick your dates" at all times, which is an
              instruction, not information. */}
          {range?.end != null && nights !== null && !dateProblem ? (
            <p className="num truncate font-heading text-base">
              {humanRange(range.start, range.end, language)}
              <span className="text-muted-foreground">
                {" · "}
                {tn("count.nights", nights, language)}
              </span>
            </p>
          ) : null}
          <Button
            type="button"
            onClick={handleCta}
            aria-haspopup="dialog"
            aria-expanded={open}
            className="h-12 w-full text-base"
          >
            {t("house.ask", language)}
          </Button>
        </div>
      </div>

      {/* Sheet --------------------------------------------------------------- */}
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          // The sheet is portalled onto `document.body`, outside the article
          // that carries the house's language, so it has to say so itself or a
          // screen reader reads a Turkish house in English.
          lang={language}
          // Radix would otherwise put the opening focus on the first tabbable
          // thing in the sheet, which is the close button — so the flow opened
          // with a heavy focus ring boxing an X, the loudest thing on screen
          // and the one control nobody wants. The question takes it instead,
          // which is also what a screen reader should hear first.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            titleRef.current?.focus();
          }}
          // shadcn's own close control is 28px, under the 44px floor, and lives
          // in a file this slice does not own. Ours is below, at 44.
          showCloseButton={false}
          // One height for all four screens. A sheet that grows and shrinks as
          // the questions change makes the Back and Next pair jump around under
          // the thumb, and a stepped flow is supposed to feel like one screen
          // being answered four times.
          aria-describedby={undefined}
          // `bg-background`, not shadcn's white `bg-popover`. Two reasons, and
          // the second is the real one: the whole product is warm paper and a
          // stark white panel sliding over it is the surface admin software
          // uses; and shadcn's calendar paints itself `bg-background`, so on
          // white it showed up as a stray grey slab with a hard edge. Matching
          // the surface removes the slab without overriding anything.
          className="gap-0 rounded-t-xl bg-background p-0 data-[side=bottom]:h-[88svh]"
        >
          <div className="flex items-center justify-between gap-2 px-4 pt-3">
            <StepDots
              total={TOTAL_STEPS}
              current={step}
              label={t("form.step.progress", language, {
                step: step + 1,
                total: TOTAL_STEPS,
              })}
            />
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label={t("common.close", language)}
                className="-me-2 size-11 shrink-0 p-0"
              >
                <XIcon className="size-5" aria-hidden="true" />
              </Button>
            </SheetClose>
          </div>

          <SheetTitle
            ref={titleRef}
            tabIndex={-1}
            className="px-4 pt-4 pb-1 text-xl font-normal text-balance outline-none"
          >
            {question}
          </SheetTitle>

          <form
            action={formAction}
            noValidate
            onKeyDown={(event) => {
              // Enter means "next" until the last screen, where it means what
              // it says. Without this, a return key pressed in the name field
              // would send a request with no email on it.
              if (event.key !== "Enter") return;
              if (event.target instanceof HTMLTextAreaElement) return;
              if (step === CHECK) return;
              event.preventDefault();
              goNext();
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            {/* Every value, on every step. See the note at the top of the file. */}
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="startDate" value={range?.start ?? ""} />
            <input type="hidden" name="endDate" value={range?.end ?? ""} />
            <input type="hidden" name="guestName" value={guestName} />
            <input type="hidden" name="guestEmail" value={guestEmail} />
            <input type="hidden" name="guests" value={guests} />
            <input type="hidden" name="note" value={note} />

            <div ref={bodyRef} className="min-h-0 flex-1 overflow-y-auto px-4 pt-2 pb-6">
              {/* 1 · When ---------------------------------------------------- */}
              {step === WHEN ? (
                <StayCalendar
                  disabledDates={takenNights}
                  pendingDates={pendingNights}
                  min={min}
                  max={max}
                  value={range}
                  onChange={(next) => {
                    setRange(next);
                    setStepProblem(null);
                  }}
                  language={language}
                  className="w-full"
                />
              ) : null}

              {/* 2 · Who ----------------------------------------------------- */}
              {step === WHO ? (
                <div className="flex flex-col gap-7">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor={idFor("guestName")}>
                      {t("form.name", language)}
                    </Label>
                    <Input
                      id={idFor("guestName")}
                      value={guestName}
                      onChange={(event) => {
                        setGuestName(event.target.value);
                        touched();
                      }}
                      autoComplete="name"
                      autoCapitalize="words"
                      spellCheck={false}
                      maxLength={80}
                      // No autoFocus anywhere in this flow. On a phone it
                      // throws the keyboard up over the Back and Next pair
                      // before the guest has read the question.
                      disabled={busy}
                      aria-invalid={messageFor("guestName") ? true : undefined}
                      aria-describedby={
                        messageFor("guestName")
                          ? `${idFor("guestName")}-error`
                          : undefined
                      }
                      className="h-12 text-base"
                    />
                    {messageFor("guestName") ? (
                      <p
                        id={`${idFor("guestName")}-error`}
                        role="alert"
                        className="text-sm text-destructive"
                      >
                        {messageFor("guestName")}
                      </p>
                    ) : null}
                  </div>

                  {/* A row of numbers to tap, not a dropdown. Nobody has ever
                      enjoyed opening a select to say "four". Real radios, so
                      the arrow keys and the screen reader work for free. */}
                  <fieldset className="flex flex-col gap-3">
                    <legend className="text-sm font-medium">
                      {t("form.step.count", language)}
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      {guestOptions.map((count) => (
                        <label key={count} className="cursor-pointer">
                          <input
                            type="radio"
                            // Grouped for the arrow keys; the Server Action
                            // reads the hidden `guests` input above.
                            name="guests-choice"
                            id={count === 1 ? idFor("guests") : undefined}
                            value={count}
                            checked={guests === String(count)}
                            onChange={() => {
                              setGuests(String(count));
                              touched();
                            }}
                            disabled={busy}
                            className="peer sr-only"
                          />
                          <span className="num flex size-12 items-center justify-center rounded-lg border border-border text-base peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50">
                            {count}
                          </span>
                        </label>
                      ))}
                    </div>
                    {messageFor("guests") ? (
                      <p role="alert" className="text-sm text-destructive">
                        {messageFor("guests")}
                      </p>
                    ) : null}
                  </fieldset>
                </div>
              ) : null}

              {/* 3 · Anything to say ----------------------------------------- */}
              {step === SAY ? (
                <div className="flex flex-col gap-7">
                  <div className="flex flex-col gap-2">
                    {/* The question is the heading above; repeating it over the
                        box would be the third time of asking. */}
                    <Label htmlFor={idFor("note")} className="sr-only">
                      {t("form.step.say", language)}
                    </Label>
                    <Textarea
                      id={idFor("note")}
                      value={note}
                      onChange={(event) => {
                        setNote(event.target.value);
                        touched();
                      }}
                      placeholder={t("form.note.example", language)}
                      maxLength={500}
                      rows={4}
                      disabled={busy}
                      aria-invalid={messageFor("note") ? true : undefined}
                      className="min-h-32 text-base"
                    />
                    {messageFor("note") ? (
                      <p role="alert" className="text-sm text-destructive">
                        {messageFor("note")}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-col gap-2">
                    <Label htmlFor={idFor("guestEmail")}>
                      {t("form.step.reply", language)}
                    </Label>
                    <Input
                      id={idFor("guestEmail")}
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
                      disabled={busy}
                      aria-invalid={messageFor("guestEmail") ? true : undefined}
                      aria-describedby={
                        messageFor("guestEmail")
                          ? `${idFor("guestEmail")}-error`
                          : undefined
                      }
                      className="h-12 text-base"
                    />
                    {messageFor("guestEmail") ? (
                      <p
                        id={`${idFor("guestEmail")}-error`}
                        role="alert"
                        className="text-sm text-destructive"
                      >
                        {messageFor("guestEmail")}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {/* 4 · Does this look right? ----------------------------------- */}
              {/* Not a list of labelled values. One object: a place, a stretch
                  of time, the people coming, and what they said. */}
              {step === CHECK ? (
                <div className="flex flex-col gap-5">
                  {/* White on paper — the one card in the flow, and the only
                      place `bg-card` earns its keep. */}
                  <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
                    <div className="flex flex-col gap-1">
                      <p className="text-sm text-muted-foreground">{houseName}</p>
                      <p className="num font-heading text-2xl text-balance">
                        {range?.end != null
                          ? humanRange(range.start, range.end, language)
                          : t("form.dates.placeholder", language)}
                      </p>
                      {nights !== null ? (
                        <p className="num text-base">
                          {t("form.check.line", language, {
                            nights: tn("count.nights", nights, language),
                            people: tn("count.people", Number(guests), language),
                          })}
                        </p>
                      ) : null}
                    </div>

                    <div className="flex flex-col gap-0.5 border-t border-border pt-4">
                      <p className="text-base">{guestName.trim()}</p>
                      <p className="text-sm break-all text-muted-foreground">
                        {guestEmail.trim()}
                      </p>
                    </div>

                    {/* `<q>` rather than typed quote marks: the browser picks
                        the pair the reader's language uses, from the `lang` on
                        the sheet. Two glyphs not worth a dictionary key. */}
                    {note.trim() ? (
                      <p className="font-heading text-base whitespace-pre-line">
                        <q>{note.trim()}</q>
                      </p>
                    ) : null}
                  </div>

                  {/* The one thing genuinely worth saying twice: no money is
                      involved anywhere in this product. */}
                  <p className="text-sm text-muted-foreground">
                    {t("form.intro", language)}
                  </p>
                </div>
              ) : null}
            </div>

            {/* Back and Next ------------------------------------------------- */}
            <div className="border-t border-border bg-background px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              {footerMessage ? (
                <p role="alert" className="pb-3 text-sm text-destructive">
                  {footerMessage}
                </p>
              ) : null}
              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={goBack}
                  disabled={busy}
                  className="h-12 flex-1 text-base"
                >
                  {t("common.back", language)}
                </Button>
                {step === CHECK ? (
                  <Button
                    type="submit"
                    disabled={busy}
                    className="h-12 flex-[2] text-base"
                  >
                    {sent
                      ? t("form.sent", language)
                      : pending
                        ? t("form.submitting", language)
                        : t("form.ask", language)}
                  </Button>
                ) : (
                  <Button
                    type="button"
                    onClick={goNext}
                    className="h-12 flex-[2] text-base"
                  >
                    {t("common.next", language)}
                  </Button>
                )}
              </div>
            </div>
          </form>
        </SheetContent>
      </Sheet>
    </>
  );
}
