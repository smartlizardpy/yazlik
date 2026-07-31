"use client";

/**
 * Asking for a week: four questions in a sheet, one at a time.
 *
 * A cousin opening this link is not filling in a booking form, they are asking
 * a favour of someone they know. So it asks what a host would ask, one thing at
 * a time, in the order a person would say it out loud:
 *
 *   1. When would you like to come?           — the nights
 *   2. Who's coming?                          — a name and how many of you
 *   3. Anything the owner should know?        — the note, and where to reply
 *   4. Does this look right?                  — the ask, written out
 *
 * ### Two grids, one selection — and they are doing different jobs
 *
 * The month on the page is not a duplicate of the month in the sheet, because
 * *browsing is not asking*. The first thing anyone opening this link wants is
 * to know whether August is free, and they are owed that answer without
 * starting a request. So the grid stays on the invitation, where it is also the
 * thing that makes the page worth opening at all.
 *
 * The grid in the sheet is the first step of the ask. Both are bound to the one
 * `range` in this component, which is what keeps the flow honest in either
 * direction: pick the nights on the page and WHEN opens with them already made,
 * so the step reads as confirming a decision rather than repeating one; pick
 * them in the sheet and the page behind it has moved by the time you close it.
 *
 * That is also the answer to the objection this file used to carry — that a
 * sheet opening on a copy of what is behind it reads as a flow that did
 * nothing. What made that true was a grid arriving with nothing on it and
 * nothing around it. What arrives now is a question, four dots, a Next button,
 * and — whenever the guest has already chosen — their own week, filled in.
 *
 * "Ask to stay" therefore always opens the sheet, at the earliest unfinished
 * step. A primary action whose one job is to open a thing and which sometimes
 * refuses to open it is the single loudest way for a product to feel broken,
 * and with no nights chosen the flow now has somewhere to put the guest: a
 * calendar, on step one, which is exactly what the button promised.
 *
 * ### Red means refused
 *
 * `--destructive` is for a refusal, and the only thing that can refuse a
 * request is the server. A field the guest has simply not filled in yet is not
 * a refusal: it says what is missing in ink, in the same sentence, and puts the
 * caret there. Nobody should meet a red ring before they have typed a
 * character.
 *
 * ### Three places dates are checked, one function
 *
 * 1. The grid refuses to build a range across a night in `disabledDates`.
 * 2. `checkRequest` runs here, on every selection, so "stays here are 2 nights
 *    or more" arrives while the calendar is still on screen.
 * 3. `requestBooking` runs it again on the server, which is the answer that
 *    counts. The client cannot be trusted and is not. When the server is the
 *    one to refuse the dates the flow walks back to WHEN, like any other
 *    refusal walks back to the step that owns its field, and the refusal is
 *    said under the grid that has to fix it.
 *
 * The check here passes `busy: []` deliberately. Overlap and gap days are
 * already in `disabledDates`, which the grid enforces by construction, and
 * shipping every busy range to the client to re-derive them would hand a guest
 * the shape of everyone else's stays for nothing.
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
import { cn } from "@/lib/utils";

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
 * line on a screen that has nothing to do with it. Every field the action can
 * name is in here, dates included: there is no refusal this flow has to close
 * itself to deliver.
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
 * The two names a date refusal can arrive under. They are one control in here —
 * the grid on WHEN — so both of them land in the same line under it, and both
 * are answered the same way: move the nights.
 */
const DATE_FIELDS: readonly string[] = ["startDate", "endDate"];

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
   * The one line under a control, whoever objected — and in what voice.
   *
   * The server's refusal and this step's own "not yet" land in the same slot,
   * so a control never grows two sentences and there is never a question about
   * which one is current. `refused` is what separates them: the server saying
   * no is the only thing in the guest's half of this product allowed to be red.
   *
   * The grid is the one control with two names on it. `startDate` and `endDate`
   * are separate fields to the Server Action and a single act to a guest, so
   * asking under the name `startDate` answers for the pair — there is only one
   * calendar to change either of them on.
   */
  const noteFor = (field: string): { text: string; refused: boolean } | null => {
    const owned = field === "startDate" ? DATE_FIELDS : [field];
    if (failed?.field !== undefined && owned.includes(failed.field)) {
      return { text: failed.error, refused: true };
    }
    if (stepProblem?.field === field) {
      return { text: stepProblem.message, refused: false };
    }
    return null;
  };

  /** That note, rendered. Ink for a gap, destructive for a refusal. */
  const fieldNote = (field: string) => {
    const note = noteFor(field);
    if (!note) return null;
    return (
      <p
        id={`${idFor(field)}-note`}
        role={note.refused ? "alert" : "status"}
        className={cn("text-sm", note.refused && "text-destructive")}
      >
        {note.text}
      </p>
    );
  };

  /** The props every control needs so its note is announced with it. */
  const noteProps = (field: string) => {
    const note = noteFor(field);
    return {
      "aria-invalid": note?.refused ? (true as const) : undefined,
      "aria-describedby": note ? `${idFor(field)}-note` : undefined,
    };
  };

  const formError = failed && !failed.field ? failed.error : null;

  function touched() {
    setDismissed(state);
    setStepProblem(null);
  }

  /**
   * One handler for both grids, because there is one selection.
   *
   * The month on the page and the month on WHEN are the same `range` seen
   * twice, so whichever one the guest taps, the other has already moved. And
   * moving the nights is the answer to every objection about them — the house's
   * own and the server's alike — so moving them is what takes it off screen.
   */
  function pickNights(next: StayRange | null) {
    setRange(next);
    touched();
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
        // Half a range is not a stay: an arrival with no departure yet is the
        // same "not chosen" as an empty grid, said in one sentence rather than
        // two.
        if (!range || range.end == null) {
          return {
            message: t("form.step.when.missing", language),
            field: "startDate",
          };
        }
        // The house's own rules, already worked out above by the one function
        // allowed to decide this. Next is blocked by exactly what blocks the
        // last button, so nobody walks three screens to be told about a
        // two-night minimum.
        if (dateProblem) {
          return { message: dateProblem, field: "startDate" };
        }
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

  // There is nothing behind WHEN — the X in the corner is how you leave — so
  // Back is not rendered there at all. A button whose only job is to do what
  // the control above it already does is a button that has to be read and
  // dismissed.
  function goBack() {
    setStepProblem(null);
    setStep((current) => Math.max(current - 1, WHEN));
  }

  /**
   * The one button on the house page, and it opens the sheet. Always.
   *
   * It opens at the earliest step that is not finished, which with nothing
   * chosen is WHEN: a calendar, inside the flow, which is what a button reading
   * "Ask to stay" promised. It used to refuse — a line saying to pick the
   * nights first and the page grid scrolled back under the thumb — and a
   * primary action that declines to do the thing it is named after is the
   * loudest way for a product to read as broken.
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
    // that name — except for the dates, which are two names over one grid, and
    // the grid carries the `startDate` id. No smooth scroll: reduced motion is
    // a setting.
    const owner = DATE_FIELDS.includes(state.field) ? "startDate" : state.field;
    const node = document.getElementById(`${baseId}-${owner}`);
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    // A no-op on the grid, which is a wrapper and not tabbable: the refusal
    // renders inside it as a live region, which is what does the announcing.
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

  // One line above the buttons in the sheet, for a refusal that belongs to no
  // single control.
  const footerMessage = step === CHECK ? formError : null;

  /**
   * The one line above the button on the page, and only ever one.
   *
   * A refusal from the server outranks the house's own rules; below both, the
   * stay itself, once there is one to state. Nothing here ever says "pick your
   * dates": with the sheet opening on the grid, an instruction on the page to
   * do something before pressing the button is an instruction to do the
   * button's job for it.
   *
   * The server's refusal is said twice on purpose — here and under the grid on
   * WHEN. It is the same sentence about the same nights, and the nights can be
   * changed in either place, so both places have to be able to say why.
   */
  const dateRefusal =
    failed?.field && DATE_FIELDS.includes(failed.field) ? failed.error : null;
  const barNote = dateRefusal ?? dateProblem;

  return (
    <>
      {/* Calendar ------------------------------------------------------------ */}
      {/* The month on the invitation. It is here, and not only inside the flow,
          because the first thing anyone opening this link wants is to know
          whether August is free — and being told to start a request before you
          can find that out is a door with a form on it. Browsing is not asking.
          Picking here is not asking either: it carries into WHEN, where the
          same nights come back as a decision to confirm. */}
      <StayCalendar
        disabledDates={takenNights}
        pendingDates={pendingNights}
        min={min}
        max={max}
        value={range}
        onChange={pickNights}
        explain
        language={language}
      />

      {/* Pinned bar ---------------------------------------------------------- */}
      {/* `fixed`, which means it escapes the layout's centred column and has to
          rebuild it. The page pads its own bottom by this bar's height. */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 supports-backdrop-filter:bg-background/80 supports-backdrop-filter:backdrop-blur">
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-2 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {barNote ? (
            <p
              role={dateRefusal ? "alert" : "status"}
              className={cn("text-sm", dateRefusal && "text-destructive")}
            >
              {barNote}
            </p>
          ) : range?.end != null && nights !== null ? (
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
          aria-describedby={undefined}
          // `bg-background`, not shadcn's white `bg-popover`. Two reasons, and
          // the second is the real one: the whole product is warm paper and a
          // stark white panel sliding over it is the surface admin software
          // uses; and shadcn's calendar paints itself `bg-background`, so on
          // white it showed up as a stray grey slab with a hard edge. Matching
          // the surface removes the slab without overriding anything.
          //
          // `max-h`, not `h`. A fixed 88svh was one height for every screen,
          // and the three that are not the calendar are two controls and a
          // card: the sheet held roughly 335px of empty paper between the last
          // of them and the button underneath, which between a question and the
          // button that answers it reads as something still loading. Each
          // screen is now as tall as what it is asking — a month on WHEN, two
          // fields on WHO — and 88svh is the ceiling the calendar and a long
          // note stop at rather than the height they all start from.
          className="gap-0 rounded-t-xl bg-background p-0 data-[side=bottom]:max-h-[88svh]"
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
              {/* The same `range` the page grid is bound to, so this opens on
                  whatever the guest already chose out there and anything they
                  choose in here is on the page by the time they close it. One
                  selection, seen twice — never two selections to reconcile.

                  The wrapper carries the `startDate` id because the grid is
                  what a date refusal is about, and that is the id the Server
                  Action's field name resolves to. */}
              {step === WHEN ? (
                <div id={idFor("startDate")} className="flex flex-col gap-3">
                  <StayCalendar
                    disabledDates={takenNights}
                    pendingDates={pendingNights}
                    min={min}
                    max={max}
                    value={range}
                    onChange={pickNights}
                    explain
                    language={language}
                  />
                  {/* Whatever there is to say about the nights — the server's
                      no, the house's own rules, or "not chosen yet" — under the
                      grid that answers it. */}
                  {fieldNote("startDate")}
                </div>
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
                      // An empty bordered box under a label reads as a control
                      // that failed to render. It also has something worth
                      // saying: this is a family, not a passport desk, and one
                      // name is enough.
                      placeholder={t("form.name.placeholder", language)}
                      autoComplete="name"
                      autoCapitalize="words"
                      spellCheck={false}
                      maxLength={80}
                      // No autoFocus anywhere in this flow. On a phone it
                      // throws the keyboard up over the Back and Next pair
                      // before the guest has read the question.
                      disabled={busy}
                      {...noteProps("guestName")}
                      className="h-12 text-base"
                    />
                    {fieldNote("guestName")}
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
                    {fieldNote("guests")}
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
                      {...noteProps("note")}
                      className="min-h-32 text-base"
                    />
                    {fieldNote("note")}
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
                      {...noteProps("guestEmail")}
                      className="h-12 text-base"
                    />
                    {fieldNote("guestEmail")}
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
                      {/* The nights are a question in here now, so this is a
                          jump straight back to it rather than three taps on
                          Back — and, unlike the version that closed the sheet
                          onto the page grid, it does not make changing your
                          mind about the dates look like abandoning the ask. */}
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => {
                          setStepProblem(null);
                          setStep(WHEN);
                        }}
                        disabled={busy}
                        className="-ms-2 mt-1 h-11 self-start px-2 text-muted-foreground"
                      >
                        {t("form.dates.change", language)}
                      </Button>
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
                {/* No Back on WHEN: there is nothing behind it, and a button
                    that only closes the sheet is the X in the corner said a
                    second time, in a heavier voice. */}
                {step > WHEN ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={goBack}
                    disabled={busy}
                    className="h-12 flex-1 text-base"
                  >
                    {t("common.back", language)}
                  </Button>
                ) : null}
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
                    className={cn(
                      "h-12 text-base",
                      step === WHEN ? "w-full" : "flex-[2]",
                    )}
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
