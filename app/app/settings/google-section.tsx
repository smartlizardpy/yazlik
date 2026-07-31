"use client";

/**
 * Google Calendar, on the owner's own screen, in three honest states.
 *
 * The states are not decoration — they are three genuinely different situations
 * and each one has exactly one thing to say:
 *
 * 1. **Not set up on this install.** No `GOOGLE_CLIENT_ID`, no
 *    `GOOGLE_CLIENT_SECRET`, so there is no OAuth client for a Connect button to
 *    lead to. This is where every deployment starts and where this one is today.
 *    One sentence and a pointer at `SETUP-GOOGLE.md`. **No button.** A Connect
 *    button here would round-trip to a 400 and look like the app was broken,
 *    when in fact nothing is wrong and nothing is missing except twenty minutes
 *    in somebody's calendar.
 * 2. **Set up, nothing connected.** A Connect button, and then the choice of
 *    which calendar. The part that has to be said out loud is what two-way
 *    actually means, because it is the thing that surprises people after the
 *    fact rather than before.
 * 3. **Connected.** Which calendar, when it last went out, how many stays did
 *    not make it, and the way out.
 *
 * ### Why this component fetches its own state
 *
 * `configured` arrives as a prop because only the server can answer it —
 * `process.env` in a client component describes the browser, not the
 * deployment — and because it decides the *first* paint. State 1 is today's
 * state and it must render immediately, with no flash of a spinner and no flash
 * of a Connect button that is about to disappear.
 *
 * Everything else is asked for after mount, from the actions. The settings page
 * stays a plain server component with one sticky Save button and knows nothing
 * about Google; mounting this is one line and no plumbing.
 *
 * ### Probing rather than asking
 *
 * There is no "is the Google account linked" flag being read here. When no
 * calendar has been chosen, this asks `listCalendars()`: if a list comes back,
 * the grant exists and the choice is what is missing, so the picker is shown; if
 * it does not, there is no usable grant and Connect is the right thing on
 * screen. One round trip, in a state an owner passes through once, and it fails
 * for exactly the reason that makes the Connect button correct.
 *
 * ### The shapes are read, not assumed
 *
 * `app/_actions/google.ts` was written alongside this file. The contract between
 * them is the five exported **names** — `connectStatus`, `listCalendars`,
 * `chooseCalendar`, `createCalendar`, `disconnect` — and the app-wide Server
 * Action result shape. The rest is read out of `unknown` by the small readers at
 * the top, the same way `lib/google/client.ts` reads a Google error it did not
 * write. It costs a dozen lines and it means a field named `lastSynced` instead
 * of `lastSyncedAt` degrades to "not yet" rather than to a build failure.
 *
 * When both files are in front of one person, tighten `readConnection` and
 * `readCalendars` against the real types and delete the aliases.
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
   READING SHAPES THIS FILE DID NOT DEFINE
   ============================================================ */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The first of `keys` that holds a non-blank string. */
function readString(source: unknown, ...keys: string[]): string | null {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

/** The first of `keys` that holds a finite number. Absent counts as zero. */
function readCount(source: unknown, ...keys: string[]): number {
  if (!isRecord(source)) return 0;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  }
  return 0;
}

/** A `Date`, an ISO string, or milliseconds — whichever came back. */
function readDate(source: unknown, ...keys: string[]): Date | null {
  if (!isRecord(source)) return null;
  for (const key of keys) {
    const value = source[key];
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "string" || typeof value === "number") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return date;
    }
  }
  return null;
}

/* ============================================================
   WHAT THE SCREEN NEEDS TO KNOW
   ============================================================ */

type Connection = {
  /** A calendar has been chosen and stays are going to it. */
  connected: boolean;
  /** What to call it on screen. Falls back to the id, which is at least true. */
  calendarName: string | null;
  lastSyncedAt: Date | null;
  /** Stays that were said yes to and never reached the calendar. */
  failedCount: number;
};

/**
 * The one rule: **connected means we can name the calendar.**
 *
 * Not "the Google account is linked" — that is a different fact and it is not
 * what state 3 renders. If the status says connected but names no calendar,
 * this falls through to the picker, which is recoverable; the reverse would
 * render a panel with a blank where the calendar's name goes.
 *
 * An explicit `connected: false` still wins, so a disconnect that leaves a stale
 * id behind does not keep the old panel on screen.
 */
function readConnection(raw: unknown): Connection {
  const calendarId = readString(raw, "calendarId", "googleCalendarId");
  const calendarName =
    readString(raw, "calendarName", "calendarSummary", "summary", "name") ?? calendarId;

  const stated = isRecord(raw) && typeof raw.connected === "boolean" ? raw.connected : null;

  return {
    connected: stated === false ? false : calendarName !== null,
    calendarName,
    lastSyncedAt: readDate(raw, "lastSyncedAt", "lastSyncAt", "lastSynced", "syncedAt"),
    failedCount: readCount(raw, "failedCount", "failedRows", "failed"),
  };
}

type CalendarChoice = { id: string; name: string };

/**
 * The calendars on offer, or `null` for "there is no usable grant".
 *
 * An **empty array is not null** and the difference is the whole point: it means
 * Google answered and had nothing to show, which is exactly what happens on the
 * narrow `calendar.app.created` scope before this app has made its first
 * calendar. That owner should be offered "make a new one", not "connect again".
 */
function readCalendars(raw: unknown): CalendarChoice[] | null {
  if (isRecord(raw) && raw.ok === false) return null;

  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw)
      ? [raw.calendars, raw.items, raw.data].find(Array.isArray)
      : undefined;

  if (!Array.isArray(list)) return null;

  const choices: CalendarChoice[] = [];
  for (const entry of list) {
    const id = readString(entry, "id", "calendarId");
    if (!id) continue;
    choices.push({ id, name: readString(entry, "name", "summary", "title") ?? id });
  }
  return choices;
}

/**
 * `{ ok: true } | { ok: false, error }`, the shape every action in this app
 * returns. An action that returns nothing at all counts as success — there is
 * no third answer, and a thrown error never gets here.
 */
function readResult(raw: unknown, fallback: string): { ok: true } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true };
  if (isRecord(raw) && raw.ok === true) return { ok: true };
  return { ok: false, error: readString(raw, "error", "message") ?? fallback };
}

/* ============================================================
   WORDS
   ============================================================ */

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * When, in the way somebody actually asks it.
 *
 * Relative up to a day, then the date. Safe to compute in the browser because
 * this never renders on the server — the whole panel arrives after mount — so
 * there is no clock to disagree with.
 */
function whenSynced(at: Date): string {
  const minutes = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (minutes < 1) return "a moment ago";
  if (minutes < 60) return `${plural(minutes, "minute", "minutes")} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${plural(hours, "hour", "hours")} ago`;
  if (hours < 48) return "yesterday";
  return at.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
}

/* ============================================================
   THE SECTION
   ============================================================ */

/** Loading, then whichever of the three states turned out to be true. */
type View =
  | { kind: "loading" }
  | { kind: "connect" }
  | { kind: "choose"; calendars: CalendarChoice[] }
  | { kind: "connected"; connection: Connection };

export type GoogleSectionProps = {
  /**
   * `isGoogleConfigured()`, answered on the server. False on every deployment
   * that has no OAuth client — which is the state this app is designed to sit in
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
        const connection = readConnection(await connectStatus());
        if (connection.connected) {
          next = { kind: "connected", connection };
        } else {
          // The probe. A list means the grant is good and only the choice is
          // missing; anything else means Connect is the honest thing to show.
          const calendars = readCalendars(await listCalendars());
          next = calendars ? { kind: "choose", calendars } : { kind: "connect" };
        }
      } catch {
        next = { kind: "connect" };
      }
      if (alive) setView(next);
    })();

    return () => {
      alive = false;
    };
  }, [configured, reloads]);

  /**
   * Ask Google for the calendar permission, on top of the identity the owner
   * already granted at sign-in.
   *
   * This is deliberately a second, later consent. Signing in asks for a name and
   * an email address and nothing else, so an owner who never wants a calendar is
   * never asked about one. `linkSocial` adds the scope to the account that is
   * already there rather than starting a new one.
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
      const url = readString(data, "url");
      if (url) window.location.href = url;
    } catch {
      setLeaving(false);
      setError("We couldn't reach the server. Check your connection and try again.");
    }
  }

  /** Every action lands here: one place that reports, refreshes, and reloads. */
  function run(work: () => Promise<unknown>, success: string, fallback: string) {
    setError(null);
    startWork(async () => {
      try {
        const result = readResult(await work(), fallback);
        if (result.ok) {
          toast.success(success, { id: "google-calendar" });
          router.refresh();
          reload();
        } else {
          setError(result.error);
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
          Calendar sync is not set up on this install. SETUP-GOOGLE.md, in the
          project folder, is the twenty minutes it takes.
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

  const problem = error ? (
    <p role="alert" className="text-sm text-pretty text-destructive">
      {error}
    </p>
  ) : null;

  /* --- 3. Connected ------------------------------------------------------- */

  if (view.kind === "connected") {
    const { calendarName, lastSyncedAt, failedCount } = view.connection;

    return (
      <Frame headingId={headingId}>
        <div className="flex flex-col gap-1">
          <p className="text-base text-pretty">
            Stays are going to{" "}
            <span className="font-medium">{calendarName}</span>.
          </p>
          <p className="text-sm text-muted-foreground">
            {lastSyncedAt
              ? `Last went out ${whenSynced(lastSyncedAt)}.`
              : "Nothing has gone out yet."}
          </p>
        </div>

        {failedCount > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="text-sm text-pretty">
              {plural(failedCount, "stay", "stays")} did not reach the calendar.
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

  /* --- 2b. Granted, no calendar chosen yet -------------------------------- */

  if (view.kind === "choose") {
    const { calendars } = view;
    const selected = chosen || calendars[0]?.id || "";
    const selectedName = calendars.find((c) => c.id === selected)?.name;

    return (
      <Frame headingId={headingId}>
        <p className="text-base text-pretty">
          Google is connected. One thing left: which calendar the house lives in.
        </p>

        <TwoWay />

        {calendars.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Label htmlFor={pickerId}>Use one you already keep</Label>

            <Select
              value={selected}
              onValueChange={setChosen}
              disabled={busy}
            >
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
                  <SelectItem key={calendar.id} value={calendar.id} className="min-h-11">
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

  /* --- 2a. Set up, nothing connected -------------------------------------- */

  return (
    <Frame headingId={headingId}>
      <p className="text-sm text-pretty text-muted-foreground">
        Connecting lets the house write to one calendar, and read that same one.
        Nothing else in your Google account is read or changed, and nobody is
        emailed from Google — a guest&rsquo;s invitation is still the file on
        their confirmation email.
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
   PIECES
   ============================================================ */

/**
 * The heading and the box, identical in all four renders above.
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
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
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
