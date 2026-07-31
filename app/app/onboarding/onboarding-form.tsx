"use client";

/**
 * Setting the house up, as three questions instead of one form.
 *
 * The owner has just signed in and owns nothing. What was here was a heading, a
 * paragraph and three stacked inputs — the shape of an admin screen, asked of
 * someone who has not yet been told what they are getting. So it is built the
 * way the guest's request flow is built, and for the same reason: a cover that
 * makes the promise, then one question per screen with Back and Next, dots at
 * the top.
 *
 *   0. One link, and the people you love can ask for a week.  — the cover
 *   1. What do you call the house?                            — the name
 *   2. Where is it?                                            — town, country
 *   3. What should your guests read?                           — the language
 *
 * The fourth dot is the hand-over, and it is rendered by `page.tsx` once the
 * house exists. That is deliberate: onboarding ends when the owner has a link
 * in their hand, not when a row lands in the database.
 *
 * ### Next is never dead
 *
 * Same rule as the request sheet. A disabled primary button on a phone reads as
 * a broken page; a step that is not finished answers with a sentence saying
 * what is missing and puts the caret in the field that is missing it.
 *
 * ### Two calls, on purpose
 *
 * `makeHouse` runs `createHouse`, which asks "does this owner have a house?"
 * and gets a memoised **no** for the rest of that request. `updateHouse` asks
 * the same question, so calling it in the same breath would be told the house
 * does not exist. The language therefore travels in a second request, after the
 * first has finished — and only when it is not the default, so the common path
 * is one round trip.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { updateHouse, type ActionResult } from "@/app/_actions/house";
import { StepDots } from "@/components/step-dots";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { humanRange } from "@/lib/i18n";

/* ============================================================
   STEPS
   ============================================================ */

const COVER = 0;
const NAME = 1;
const PLACE = 2;
const LANGUAGE = 3;

/** Name, place, language, and the link. Kept in step with `page.tsx`. */
const TOTAL_STEPS = 4;

/**
 * Which screen owns each field `createHouse` can blame. The server checks
 * everything again and is allowed to disagree; when it does, the flow walks
 * back to the question that asked, rather than showing a refusal on a screen
 * that has nothing to do with it.
 */
const STEP_OF_FIELD: Record<string, number> = {
  name: NAME,
  town: PLACE,
  country: PLACE,
};

type Language = "en" | "tr";

const LANGUAGES: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "tr", label: "Türkçe" },
];

/**
 * A week in August, written out beside each choice — because a week written out
 * is the whole of what this choice changes for a guest.
 *
 * It goes through `humanRange`, the same formatter the house page uses, rather
 * than being two strings typed here: a hand-written sample is a promise about
 * somebody else's code, and it starts lying the day that code changes. The year
 * is passed as the current one so the sample never grows a stray "2026".
 */
const SAMPLE_START = "2026-08-18";
const SAMPLE_END = "2026-08-23";
const SAMPLE_YEAR = 2026;

/** What a step says when it is not finished, and which control it is about. */
type Problem = { message: string; field?: string };

/* ============================================================
   COMPONENT
   ============================================================ */

export type OnboardingFormProps = {
  /**
   * Makes the house and comes back here rather than jumping to the dashboard.
   * A Server Action from `page.tsx`; it wraps `createHouse` untouched.
   */
  makeHouse: (input: {
    name: string;
    town: string;
    country: string;
  }) => Promise<ActionResult>;
};

export function OnboardingForm({ makeHouse }: OnboardingFormProps) {
  const baseId = useId();
  const router = useRouter();

  const [step, setStep] = useState(COVER);
  const [name, setName] = useState("");
  const [town, setTown] = useState("");
  const [country, setCountry] = useState("");
  const [language, setLanguage] = useState<Language>("en");

  const [problem, setProblem] = useState<Problem | null>(null);
  // Held past the server's answer: on success the page is being replaced by
  // the hand-over, and the button must not flick back to offering a second go.
  const [busy, setBusy] = useState(false);

  const idFor = (field: string) => `${baseId}-${field}`;
  const messageFor = (field: string) =>
    problem?.field === field ? problem.message : null;

  /* ---------- per-step checking ------------------------------------- */

  function problemOn(index: number): Problem | null {
    if (index === NAME && name.trim() === "") {
      return {
        message: "Give the house a name — whatever your family calls it.",
        field: "name",
      };
    }
    if (index === PLACE) {
      if (town.trim() === "") {
        return {
          message: "Add the town, so people know where they are going.",
          field: "town",
        };
      }
      if (country.trim() === "") {
        return { message: "Add the country too.", field: "country" };
      }
    }
    return null;
  }

  function goNext() {
    const found = problemOn(step);
    if (found) {
      setProblem(found);
      // The message is already under the control, so the keyboard arriving
      // over the buttons costs nothing.
      if (found.field) document.getElementById(idFor(found.field))?.focus();
      return;
    }
    setProblem(null);
    setStep((current) => Math.min(current + 1, LANGUAGE));
  }

  function goBack() {
    setProblem(null);
    setStep((current) => Math.max(current - 1, COVER));
  }

  /* ---------- the last tap ------------------------------------------- */

  async function finish() {
    if (busy) return;
    setBusy(true);

    const created = await makeHouse({
      name: name.trim(),
      town: town.trim(),
      country: country.trim(),
    });

    if (!created.ok) {
      setBusy(false);
      setProblem({ message: created.error, field: created.field });
      const target =
        created.field === undefined ? undefined : STEP_OF_FIELD[created.field];
      if (target !== undefined) setStep(target);
      return;
    }

    // English is the column default, so the common answer costs nothing. A
    // refusal here is not worth blocking the link over: the house exists, and
    // the language is one tap away in settings.
    if (language !== "en") await updateHouse(null, { language });

    // The house exists now, so this page comes back as the hand-over. `busy`
    // stays true through it — there is nothing left to press.
    router.refresh();
  }

  /* ---------- focus --------------------------------------------------- */

  const headingRef = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef(step);

  // A new question is a new screen. Move focus to it so a screen reader reads
  // it out, and so Back and Next mean the thing that is now on screen.
  useEffect(() => {
    if (shownStep.current === step) return;
    shownStep.current = step;
    headingRef.current?.focus();
  }, [step]);

  /* ---------- copy ---------------------------------------------------- */

  const heading = [
    "One link for the house, so the people you love can ask for a week.",
    "What do you call the house?",
    "Where is it?",
    "What should your guests read?",
  ][step];

  // Refusals that belong to no single control — "You already have a house",
  // or anything the server said about the form as a whole.
  const footerMessage = problem && !problem.field ? problem.message : null;

  return (
    <section className="flex flex-1 flex-col pt-5 pb-6">
      {step > COVER ? (
        <StepDots
          total={TOTAL_STEPS}
          current={step - 1}
          label={`Step ${step} of ${TOTAL_STEPS}`}
          className="mb-9"
        />
      ) : null}

      <h1
        ref={headingRef}
        tabIndex={-1}
        // The cover has no dots above it, so it takes their height as padding
        // instead: the heading then lands in the same place on every screen of
        // the flow, and nothing jumps between the promise and the first
        // question.
        className={
          step === COVER
            ? "pt-11 text-3xl text-balance outline-none"
            : "text-2xl text-balance outline-none"
        }
      >
        {heading}
      </h1>

      {/* 0 · The cover ------------------------------------------------- */}
      {step === COVER ? (
        <p className="pt-5 text-base text-pretty text-muted-foreground">
          Three questions, and then the link is yours to send. Nobody pays
          anybody anything, here or later.
        </p>
      ) : null}

      {/* 1 · What do you call it? -------------------------------------- */}
      {step === NAME ? (
        <div className="flex flex-col gap-2 pt-7">
          {/* The heading is the question; a label over the box would be the
              second time of asking. */}
          <Label htmlFor={idFor("name")} className="sr-only">
            House name
          </Label>
          <Input
            id={idFor("name")}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setProblem(null);
            }}
            placeholder="The Çeşme house"
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            maxLength={80}
            disabled={busy}
            aria-invalid={messageFor("name") ? true : undefined}
            aria-describedby={
              messageFor("name") ? `${idFor("name")}-error` : `${idFor("name")}-hint`
            }
            className="h-12 text-base"
          />
          {messageFor("name") ? (
            <p
              id={`${idFor("name")}-error`}
              role="alert"
              className="text-sm text-destructive"
            >
              {messageFor("name")}
            </p>
          ) : (
            <p id={`${idFor("name")}-hint`} className="text-sm text-muted-foreground">
              It is the first thing anyone sees when the link opens.
            </p>
          )}
        </div>
      ) : null}

      {/* 2 · Where is it? ---------------------------------------------- */}
      {step === PLACE ? (
        <div className="flex flex-col gap-6 pt-7">
          <div className="flex flex-col gap-2">
            <Label htmlFor={idFor("town")}>Town</Label>
            <Input
              id={idFor("town")}
              value={town}
              onChange={(event) => {
                setTown(event.target.value);
                setProblem(null);
              }}
              placeholder="Çeşme"
              autoComplete="address-level2"
              autoCapitalize="words"
              spellCheck={false}
              maxLength={80}
              disabled={busy}
              aria-invalid={messageFor("town") ? true : undefined}
              aria-describedby={
                messageFor("town") ? `${idFor("town")}-error` : undefined
              }
              className="h-12 text-base"
            />
            {messageFor("town") ? (
              <p
                id={`${idFor("town")}-error`}
                role="alert"
                className="text-sm text-destructive"
              >
                {messageFor("town")}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={idFor("country")}>Country</Label>
            <Input
              id={idFor("country")}
              value={country}
              onChange={(event) => {
                setCountry(event.target.value);
                setProblem(null);
              }}
              placeholder="Turkey"
              autoComplete="country-name"
              autoCapitalize="words"
              spellCheck={false}
              maxLength={80}
              disabled={busy}
              aria-invalid={messageFor("country") ? true : undefined}
              aria-describedby={
                messageFor("country") ? `${idFor("country")}-error` : undefined
              }
              className="h-12 text-base"
            />
            {messageFor("country") ? (
              <p
                id={`${idFor("country")}-error`}
                role="alert"
                className="text-sm text-destructive"
              >
                {messageFor("country")}
              </p>
            ) : null}
          </div>

          <p className="text-sm text-muted-foreground text-pretty">
            The town is all anyone sees. Where the key is kept stays between you
            and whoever you said yes to.
          </p>
        </div>
      ) : null}

      {/* 3 · What should your guests read? ------------------------------ */}
      {/* Two rows to tap, not a dropdown. Real radios, so the arrow keys and
          the screen reader work without anything being written for them. */}
      {step === LANGUAGE ? (
        <fieldset className="flex flex-col gap-3 pt-7">
          <legend className="sr-only">The language your guests read</legend>
          {LANGUAGES.map((option) => (
            <label key={option.value} className="cursor-pointer">
              <input
                type="radio"
                name="language"
                value={option.value}
                checked={language === option.value}
                onChange={() => setLanguage(option.value)}
                disabled={busy}
                className="peer sr-only"
              />
              <span className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-border px-4 peer-checked:border-foreground peer-checked:bg-foreground peer-checked:text-background peer-focus-visible:ring-3 peer-focus-visible:ring-ring/50">
                <span className="font-heading text-lg">{option.label}</span>
                <span className="num text-sm opacity-70">
                  {humanRange(SAMPLE_START, SAMPLE_END, option.value, {
                    currentYear: SAMPLE_YEAR,
                  })}
                </span>
              </span>
            </label>
          ))}
          <p className="pt-1 text-sm text-muted-foreground text-pretty">
            Your own screens stay in English either way.
          </p>
        </fieldset>
      ) : null}

      {/* Back and Next --------------------------------------------------- */}
      <div className="mt-auto flex flex-col gap-3 pt-12">
        {footerMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {footerMessage}
          </p>
        ) : null}

        <div className="flex gap-3">
          {/* No Back on the cover: there is nowhere behind it, and a dead
              control is worse than an absent one. */}
          {step > COVER ? (
            <Button
              type="button"
              variant="outline"
              onClick={goBack}
              disabled={busy}
              className="h-12 flex-1 text-base"
            >
              Back
            </Button>
          ) : null}

          {step === LANGUAGE ? (
            <Button
              type="button"
              onClick={() => void finish()}
              disabled={busy}
              className="h-12 flex-[2] text-base"
            >
              {busy ? "One moment…" : "Get the link"}
            </Button>
          ) : (
            <Button
              type="button"
              onClick={goNext}
              className={
                step === COVER ? "h-12 w-full text-base" : "h-12 flex-[2] text-base"
              }
            >
              {step === COVER ? "Start" : "Next"}
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
