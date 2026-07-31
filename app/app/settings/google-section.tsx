"use client";

/**
 * Google Calendar, on the owner's own screen, in the states it can really be in.
 *
 * Each one is a genuinely different situation with exactly one thing to say:
 *
 * 1. **Not set up on this install.** No `GOOGLE_CLIENT_ID`, no
 *    `GOOGLE_CLIENT_SECRET`, so there is no OAuth client for a Connect button to
 *    lead to. Two sentences: what is true, and who can change it. **No button.**
 *    A Connect button here would round-trip to a 400 and look like the app was
 *    broken, when in fact nothing is wrong.
 *
 *    Nothing here names a file. The person holding this phone owns a house, not
 *    a checkout of this repository — there is no project folder on their side of
 *    the screen, and `SETUP-GOOGLE.md` is addressed to whoever deployed it. That
 *    pointer belongs in the README, which is where it is.
 * 2. **Set up, never connected.** A Connect button, and a plain description of
 *    what Google is about to ask for — worded to match what Google's own screen
 *    will say, so that screen is a confirmation rather than a surprise.
 * 3. **Connected, but the grant is short.** They gave calendar access once and
 *    this app has since asked for more. The button is the same button; the
 *    explanation must not be, because "you never connected Google" would be a
 *    lie and would read as their mistake. See `reconsent` in
 *    `app/_actions/google.ts`.
 * 4. **Granted, no calendar chosen.** Pick one they already keep, or make a
 *    fresh one. **Both must always be on offer**, including when the list comes
 *    back empty and including when it fails to come back at all.
 * 5. **Connected.** Which calendar, how the stays have fared, and the way out.
 *
 * ### Why this component fetches its own state
 *
 * `configured` arrives as a prop because only the server can answer it —
 * `process.env` in a client component describes the browser, not the
 * deployment — and because it decides the *first* paint. State 1 must render
 * immediately, with no flash of a spinner and no flash of a Connect button that
 * is about to disappear.
 *
 * Everything else is asked for after mount, from the actions. The settings page
 * stays a plain server component with one sticky Save button and knows nothing
 * about Google; mounting this is one line and no plumbing.
 *
 * ### One authority, not two
 *
 * This file used to decide between "connect" and "choose a calendar" by
 * *probing*: call `listCalendars()` and see whether it worked. That is why an
 * owner could be stuck. The probe conflated three different answers — no grant,
 * a grant too narrow to list anything, and Google having a bad minute — into the
 * single verdict "not connected", which put a Connect button in front of someone
 * whose account was fine and whose press could not change anything.
 *
 * `connectStatus()` is now the only authority. It reads the environment, the
 * stored grant and the house, calls Google zero times, and cannot be wrong about
 * which of the five states this is. `listCalendars()` is called in exactly one
 * state — the one whose entire purpose is choosing — and **its failure downgrades
 * the picker, never the state**: no list still means "make one", because that
 * offer works whether or not the list arrived.
 *
 * ### The shapes are the real ones
 *
 * An earlier draft read these results out of `unknown` with hand-rolled key
 * probes, against the day the two files disagreed. They disagreed immediately
 * and it did not help: `connectStatus()` answers `{ ok, status }` and the reader
 * looked for `calendarId` on the envelope, so `connected` was false for every
 * owner who had ever connected anything. The types are imported now and the
 * compiler checks the shape, which is the job those readers were failing at.
 */

import { useCallback, useEffect, useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import {
  chooseCalendar,
  connectStatus,
  createCalendar,
  disconnect,
  listCalendars,
  type ConnectStatus,
} from "@/app/_actions/google";
import { authClient } from "@/lib/auth-client";
import { GOOGLE_CALENDAR_SCOPES } from "@/lib/google/types";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/* ============================================================
   WHAT THE SCREEN NEEDS TO KNOW
   ============================================================ */

/**
 * One calendar on offer. Structurally the action's own row, declared here so
 * this client component never reaches into `lib/google/sync.ts` — that module
 * carries the database and `googleapis` behind it.
 */
type CalendarChoice = { calendarId: string; name: string };

/** Loading, then whichever state turned out to be true. */
type View =
  | { kind: "loading" }
  /** Nothing to offer and nothing to press: no house yet, or a read that failed. */
  | { kind: "unavailable"; message: string }
  /** Never connected. */
  | { kind: "connect" }
  /** Connected once, with less than this now needs. `again` picks the wording. */
  | { kind: "consent"; message: string; again: boolean }
  /**
   * Granted; the calendar is the only thing missing. `calendars` may be empty and
   * `trouble` may be set — both still offer making a fresh one, which is the
   * point.
   */
  | { kind: "choose"; calendars: CalendarChoice[]; trouble: string | null }
  | { kind: "connected"; status: ConnectStatus };

/** When the server did not answer at all. Everything else says its own piece. */
const TROUBLE = "We could not reach the server. Check your connection and try again.";

/* ============================================================
   WORDS
   ============================================================ */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/* ============================================================
   THE SECTION
   ============================================================ */

export type GoogleSectionProps = {
  /**
   * `isGoogleConfigured()`, answered on the server. False on every deployment
   * that has no OAuth client — which is a state this app is designed to sit in
   * indefinitely, not an error.
   */
  configured: boolean;
  /** The name a calendar made by this app is given. The house's own name. */
  houseName: string;
};

export function GoogleSection({ configured, houseName }: GoogleSectionProps) {
  const router = useRouter();
  const headingId = useId();
  const pickerId = useId();

  const [view, setView] = useState<View>({ kind: "loading" });
  const [chosen, setChosen] = useState<string>("");
  /** The chosen calendar's own name, once it can be had. The id is the fallback. */
  const [calendarName, setCalendarName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [working, startWork] = useTransition();

  // Bumped after anything that changes the answer, which re-runs the effect
  // below. One number instead of a second copy of the loading logic.
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(() => {
    if (!configured) return;

    let alive = true;

    void (async () => {
      let next: View;
      try {
        const result = await connectStatus();
        next = result.ok ? await viewFor(result.status) : { kind: "unavailable", message: result.error };
      } catch {
        next = { kind: "unavailable", message: TROUBLE };
      }
      if (alive) setView(next);
    })();

    return () => {
      alive = false;
    };
  }, [configured, reloads]);

  /**
   * The chosen calendar's name, asked for after the panel is already on screen.
   *
   * Nothing waits for this and nothing breaks without it: the panel renders the
   * calendar id straight away, and the id is at least true. Worth one call
   * because the id of a secondary calendar is a forty-character machine string,
   * and "Stays are going to c_9f3…@group.calendar.google.com" tells the owner
   * nothing about which calendar that is.
   */
  useEffect(() => {
    if (view.kind !== "connected") return;
    const id = view.status.calendarId;
    if (!id) return;

    let alive = true;

    void (async () => {
      try {
        const result = await listCalendars();
        if (!alive || !result.ok) return;
        const match = result.calendars.find((choice) => choice.calendarId === id);
        if (match) setCalendarName(match.name);
      } catch {
        // The id stays on screen. Nothing about the connection is in doubt.
      }
    })();

    return () => {
      alive = false;
    };
  }, [view]);

  /**
   * Ask Google for the calendar permission, on top of the identity the owner
   * already granted at sign-in.
   *
   * This is deliberately a second, later consent. Signing in asks for a name and
   * an email address and nothing else, so an owner who never wants a calendar is
   * never asked about one. `linkSocial` adds the scopes to the account that is
   * already there rather than starting a new one — and it is also the way *back*
   * through consent for an owner whose grant is too narrow, because better-auth
   * updates the stored scope from the callback and `lib/auth.ts` sets
   * `prompt: "consent"`, which is what makes Google show the screen again
   * instead of silently re-issuing the grant it already has.
   *
   * The browser leaves during this call — better-auth's own fetch plugin follows
   * the returned url — so there is no "back to idle" on the happy path and the
   * button stays disabled on the way out.
   */
  async function connect() {
    if (leaving) return;
    setError(null);
    setLeaving(true);

    try {
      const { data, error: linkError } = await authClient.linkSocial({
        provider: "google",
        scopes: [...GOOGLE_CALENDAR_SCOPES],
        callbackURL: "/app/settings",
        errorCallbackURL: "/app/settings",
      });

      if (linkError) {
        setLeaving(false);
        setError("Google couldn't be reached. Try again in a moment.");
        return;
      }

      // Belt and braces: if the redirect plugin has already sent the browser,
      // assigning the same address again is a no-op.
      const url = typeof data?.url === "string" ? data.url : null;
      if (url) window.location.href = url;
    } catch {
      setLeaving(false);
      setError(TROUBLE);
    }
  }

  /** Every action lands here: one place that reports, refreshes, and reloads. */
  function run(work: () => Promise<{ ok: boolean; error?: string }>, success: string, fallback: string) {
    setError(null);
    startWork(async () => {
      try {
        const result = await work();
        if (result.ok) {
          toast.success(success, { id: "google-calendar" });
          setCalendarName(null);
          router.refresh();
          reload();
        } else {
          setError(result.error ?? fallback);
        }
      } catch {
        setError(fallback);
      }
    });
  }

  const busy = working || leaving;

  /* --- 1. Not set up on this install ------------------------------------- */

  if (!configured) {
    return (
      <Frame headingId={headingId}>
        <p className="text-sm text-pretty text-muted-foreground">
          This house does not put stays in Google Calendar. Whoever set it up for
          you can turn that on.
        </p>
      </Frame>
    );
  }

  if (view.kind === "loading") {
    return (
      <Frame headingId={headingId}>
        <p className="text-sm text-muted-foreground">Checking what is connected.</p>
      </Frame>
    );
  }

  if (view.kind === "unavailable") {
    return (
      <Frame headingId={headingId}>
        <p className="text-sm text-pretty text-muted-foreground">{view.message}</p>
      </Frame>
    );
  }

  const problem = error ? (
    <p role="alert" className="text-sm text-pretty text-destructive">
      {error}
    </p>
  ) : null;

  /* --- 5. Connected ------------------------------------------------------- */

  if (view.kind === "connected") {
    const { calendarId, synced, failed } = view.status;

    return (
      <Frame headingId={headingId}>
        <div className="flex flex-col gap-1">
          <p className="text-base text-pretty">
            Stays are going to{" "}
            <span className="font-medium">{calendarName ?? calendarId}</span>.
          </p>
          <p className="text-sm text-muted-foreground">
            {synced > 0
              ? `${plural(synced, "stay is", "stays are")} on it.`
              : "Nothing has gone out yet."}
          </p>
        </div>

        {failed > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-pretty">
              {plural(failed, "stay", "stays")} did not reach the calendar.
            </p>
            <p className="text-xs text-pretty text-muted-foreground">
              An expired grant is the usual cause. Disconnect, connect again, and
              they go out on the next pass.
            </p>
          </div>
        ) : null}

        <TwoWay />

        {problem}

        {/* Grey and underlined, the way the rest of the product offers the thing
            you probably do not want. The house keeps working without it. */}
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={() =>
            run(
              () => disconnect(),
              "Disconnected. The calendar itself is untouched.",
              "It did not disconnect. Try again in a moment.",
            )
          }
          className="h-11 justify-start self-start px-0 text-sm font-normal text-muted-foreground underline underline-offset-4 hover:bg-transparent hover:text-foreground"
        >
          {working ? "Disconnecting…" : "Disconnect"}
        </Button>
      </Frame>
    );
  }

  /* --- 4. Granted, no calendar chosen yet --------------------------------- */

  if (view.kind === "choose") {
    const { calendars, trouble } = view;
    const selected = chosen || calendars[0]?.calendarId || "";
    const selectedName = calendars.find((c) => c.calendarId === selected)?.name;

    return (
      <Frame headingId={headingId}>
        <p className="text-base text-pretty">
          Google is connected. One thing left: which calendar the house lives in.
        </p>

        <TwoWay />

        {calendars.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={pickerId}>Use one you already keep</Label>

            <Select value={selected} onValueChange={setChosen} disabled={busy}>
              {/* The trigger's own height is `data-[size=default]:h-8` and an
                  attribute selector out-specifies a plain `h-11`. */}
              <SelectTrigger
                id={pickerId}
                className="w-full text-base data-[size=default]:h-11"
              >
                <SelectValue>{selectedName}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {calendars.map((calendar) => (
                  <SelectItem
                    key={calendar.calendarId}
                    value={calendar.calendarId}
                    className="min-h-11"
                  >
                    {calendar.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              type="button"
              variant="outline"
              disabled={busy || selected === ""}
              onClick={() =>
                run(
                  () => chooseCalendar(selected),
                  "The house is on that calendar now.",
                  "That calendar could not be used. Try another, or make a new one.",
                )
              }
              className="h-12 w-full text-base"
            >
              {working ? "One moment…" : "Use this calendar"}
            </Button>
          </div>
        ) : null}

        {/* The list not arriving is worth saying, and worth saying *here* —
            beside the offer that still works without it. */}
        {trouble ? (
          <p role="alert" className="text-sm text-pretty text-destructive">
            {trouble} Your own calendars could not be listed, but a new one can
            still be made.
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <p className="text-sm text-pretty text-muted-foreground">
            {calendars.length > 0
              ? "Or keep the house out of everything else, in a calendar of its own."
              : "Nothing to choose from yet. Give the house a calendar of its own."}
          </p>
          <Button
            type="button"
            variant={calendars.length > 0 ? "outline" : "default"}
            disabled={busy}
            onClick={() =>
              run(
                // No argument: the action reads the house itself and names the
                // calendar after it, so the name cannot be spoofed from here.
                () => createCalendar(),
                `Made a calendar called ${houseName}.`,
                "The calendar was not made. Try again in a moment.",
              )
            }
            className="h-12 w-full text-base"
          >
            {working ? "One moment…" : `Make a calendar called ${houseName}`}
          </Button>
        </div>

        {problem}
      </Frame>
    );
  }

  /* --- 3. Connected once, with less than this needs ----------------------- */

  if (view.kind === "consent") {
    return (
      <Frame headingId={headingId}>
        <p className="text-base text-pretty">{view.message}</p>

        {view.again ? (
          <p className="text-sm text-pretty text-muted-foreground">
            Nothing you set up is lost. Google will show you what it is asking
            for, and you land back here.
          </p>
        ) : null}

        <TwoWay />

        {problem}

        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={connect}
          className="h-12 w-full text-base"
        >
          {leaving
            ? "Taking you to Google…"
            : view.again
              ? "Ask Google again"
              : "Give Google Calendar access"}
        </Button>
      </Frame>
    );
  }

  /* --- 2. Set up, never connected ----------------------------------------- */

  return (
    <Frame headingId={headingId}>
      <p className="text-sm text-pretty text-muted-foreground">
        Google will ask for two things: the names of your calendars, so you can
        pick one — and permission to read and write events on the calendars you
        own. This house only ever touches the single calendar you pick. Calendars
        other people have shared with you stay out of reach, nothing is renamed
        or deleted, and nobody is emailed from Google — a guest&rsquo;s
        invitation is still the file on their confirmation email.
      </p>

      <TwoWay />

      {problem}

      <Button
        type="button"
        variant="outline"
        disabled={busy}
        onClick={connect}
        className="h-12 w-full text-base"
      >
        {leaving ? "Taking you to Google…" : "Connect Google Calendar"}
      </Button>
    </Frame>
  );
}

/* ============================================================
   STATUS → VIEW
   ============================================================ */

/**
 * The one place a status becomes a panel.
 *
 * Only `not-chosen` calls Google, and only because choosing is what it is for.
 * Every other state is decided from data the server already had.
 */
async function viewFor(status: ConnectStatus): Promise<View> {
  switch (status.state) {
    case "not-configured":
      return { kind: "unavailable", message: status.message };

    case "not-linked":
      return { kind: "connect" };

    case "needs-consent":
      return { kind: "consent", message: status.message, again: status.reconsent };

    case "not-chosen": {
      // A list that does not arrive downgrades the picker and nothing else. The
      // owner is connected either way, and "make me one" works either way.
      try {
        const result = await listCalendars();
        return result.ok
          ? { kind: "choose", calendars: result.calendars, trouble: null }
          : { kind: "choose", calendars: [], trouble: result.error };
      } catch {
        return { kind: "choose", calendars: [], trouble: TROUBLE };
      }
    }

    case "connected":
      return { kind: "connected", status };
  }
}

/* ============================================================
   PIECES
   ============================================================ */

/**
 * The heading and the box, identical in every render above.
 *
 * `text-lg` and the `gap-4` column are what every other section on this screen
 * uses — Photos, The house, What you'll say yes to — so this one lands as
 * another section rather than as a panel bolted on.
 */
function Frame({
  headingId,
  children,
}: {
  headingId: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className="flex scroll-mt-20 flex-col gap-4"
    >
      <h2 id={headingId} className="text-lg">
        Google Calendar
      </h2>
      {children}
    </section>
  );
}

/**
 * The paragraph that stops the surprise.
 *
 * People hear "sync" and picture stays going out. The half nobody expects is the
 * half coming back, and they find out about it when a week they did not block
 * turns out to be blocked — or, more often, when a Tuesday afternoon at the
 * dentist does not block a week and they assume the whole thing is broken. Both
 * questions are answered here, before either is asked, in the order they arrive.
 */
function TwoWay() {
  return (
    <div className="flex flex-col gap-2 border-l border-border pl-4">
      <p className="text-sm text-pretty text-muted-foreground">
        It goes both ways. Every stay you say yes to appears in that calendar. And
        an all-day event in that calendar takes the house — put &ldquo;roof being
        fixed&rdquo; across a week and nobody can ask for it.
      </p>
      <p className="text-sm text-pretty text-muted-foreground">
        Events with a time on them are ignored. Your dentist on Tuesday afternoon
        does not take the house for the day.
      </p>
    </div>
  );
}
