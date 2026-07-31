"use server";

/**
 * Connecting the house to one Google calendar, and letting go of it again.
 *
 * Five things an owner can do from Settings: see where they stand, look at the
 * calendars they already keep, point the app at one of them, ask for a fresh one
 * instead, or disconnect. Nothing here syncs anything — that is
 * `lib/google/sync.ts`. This file is the door.
 *
 * ### Not connected is not an error
 *
 * There are no Google credentials on this deployment yet, and there may never be
 * on some other one. So every action below asks three questions before it does
 * anything — is Google configured, has the owner linked an account, have they
 * granted calendar access — and answers with a plain sentence rather than a
 * thrown error when the answer is no. An owner who has not connected Google has
 * not failed at anything, and the screen should never suggest they have.
 *
 * ### Two consents, not one
 *
 * Signing in with Google asks for a name and an email address and stops
 * (`lib/auth.ts`). Calendar access is a **second, wider** consent, asked here
 * from Settings by someone who has already decided they want it. The scopes and
 * the reasoning behind each are in `lib/google/types.ts`; the short version is
 * that reading a calendar the owner already keeps needs more than reading one
 * this app created, and the owner explicitly asked for the former.
 *
 * The button that *asks* for that second consent belongs to the settings screen
 * and calls better-auth's `linkSocial` with `GOOGLE_CALENDAR_SCOPES`. This file
 * reports whether it has been granted (`state: 'needs-consent'`) so that screen
 * knows when to show it.
 *
 * ### The grant that is real, and still not enough
 *
 * A widened scope is **never** granted retroactively. An owner who consented
 * while this app asked for one narrow scope holds a grant Google will go on
 * handing back for ever, and nothing about it looks broken: the account is
 * linked, the refresh token works, the tokens refresh. It simply cannot do the
 * job. So {@link connectStatus} does not ask "is Google linked" — it asks
 * whether the *stored scope* still covers what the app now needs, and says which
 * of the two problems it is (`reconsent`). Sending that owner back through
 * consent is the fix; it takes one press and Google's `prompt: "consent"` makes
 * the screen appear again rather than silently re-issuing the old grant.
 *
 * Everything an owner reads here is English — the dashboard is English in v1.
 */

import { revalidatePath } from "next/cache";

import {
  connectionFor,
  googleAccount,
  isConnected,
  pullBlocks,
  setHouseCalendar,
  syncCounts,
  type CalendarChoice,
} from "@/lib/google/sync";
import { isGoogleConfigured } from "@/lib/google/config";
import {
  hasCalendarScope,
  hasPartialCalendarScope,
  isGoogleCalendarError,
  missingCalendarScopes,
} from "@/lib/google/types";
import { getOwnerHouse, requireOwner } from "@/lib/session";

/* ============================================================
   SHAPES
   ============================================================ */

/**
 * Where the owner stands, as one word.
 *
 * Deliberately ordered as a path: each state is the one before it, solved.
 */
export type ConnectState =
  /** No `GOOGLE_CLIENT_ID` on this deployment. Nothing to offer. */
  | "not-configured"
  /** They signed in by magic link and have never used Google. */
  | "not-linked"
  /** Google is linked, but only for their name and email. */
  | "needs-consent"
  /** Calendar access granted; they have not picked which calendar yet. */
  | "not-chosen"
  /** Done. Stays go out, blocks come in. */
  | "connected";

export type ConnectStatus = {
  state: ConnectState;
  /** One sentence, for the screen. */
  message: string;
  /** The calendar the house is pointed at, if any. */
  calendarId: string | null;
  /**
   * `needs-consent` only, and the difference between two very different
   * sentences: `true` means they granted calendar access once and this app has
   * since asked for more, `false` means they have never been asked at all. The
   * button is the same; the explanation must not be.
   */
  reconsent: boolean;
  /** Stays that reached the calendar. Zero unless `connected`. */
  synced: number;
  /** Stays that were said yes to and did not reach it. Zero unless `connected`. */
  failed: number;
};

/** The fields that are only ever interesting once a calendar is chosen. */
const NOT_YET = { reconsent: false, synced: 0, failed: 0 } as const;

export type ConnectStatusResult =
  | { ok: true; status: ConnectStatus }
  | { ok: false; error: string };

export type CalendarListResult =
  | { ok: true; calendars: CalendarChoice[] }
  | { ok: false; error: string };

/** The shape every other action in `app/_actions` returns. */
export type GoogleResult = { ok: true } | { ok: false; error: string; field?: string };

/* ============================================================
   COPY
   ============================================================ */

const NO_HOUSE = "You do not have a house yet. Add one, then connect a calendar to it.";

const NOT_CONFIGURED = "Google is not set up on this app yet.";
const NOT_LINKED = "Sign in with Google once, and your calendar can follow.";
const NEEDS_CONSENT = "Google has your name, not your calendar. Give it access to go on.";
/**
 * The upgrade case, said without blaming the owner — they granted exactly what
 * they were asked for, and the app changed its mind afterwards.
 */
const NEEDS_RECONSENT =
  "This needs more of your calendar than you gave it last time — the weeks already " +
  "in your own calendar can only be read with permission you have not granted yet. " +
  "Google will ask you again.";
const NOT_CHOSEN = "Pick the calendar the house should live on.";
const CONNECTED = "The house is on your Google calendar.";

/** A dead grant. The one failure an owner has to do something about. */
const RECONNECT = "Google would not let us in. Connect it again.";
const BUSY = "Google is busy. Try again in a minute.";
const GONE = "That calendar is not there any more. Pick another one.";
const TROUBLE = "Google did not answer properly. Try again in a moment.";

/**
 * A Google failure as one sentence.
 *
 * Four kinds, four answers, and only one of them asks the owner to do anything.
 * The underlying message is for the log — it is Google's English, not ours.
 */
function sentence(error: unknown): string {
  if (isGoogleCalendarError(error)) {
    if (error.kind === "auth") return RECONNECT;
    if (error.kind === "rateLimit") return BUSY;
    if (error.kind === "notFound") return GONE;
  }
  return TROUBLE;
}

/* ============================================================
   THE GUARD EVERY ACTION SHARES
   ============================================================ */

/**
 * The signed-in owner's house, or the sentence explaining why there is nothing
 * to connect. `requireOwner` redirects a signed-out caller, so past this line
 * there is always a person.
 */
async function ownerHouse() {
  await requireOwner();
  const house = await getOwnerHouse();
  return house;
}

/* ============================================================
   WHERE DO I STAND?
   ============================================================ */

/**
 * The one read this screen needs, and it calls Google zero times.
 *
 * Everything it reports comes from the environment, better-auth's `account` row
 * and the house — so a settings page can render it on every load without a
 * round trip to Google or a chance of an outage making the page fail.
 *
 * **This is the authority on which panel the settings screen draws.** It used to
 * be one of two, the other being "call `listCalendars()` and see whether it
 * works", and the two could disagree: a rate limit or a dropped connection made
 * that probe fail, and a failed probe rendered "not connected" at an owner whose
 * account was fine. A transient fault must never present as a missing grant —
 * the button it puts on screen sends them back through Google for no reason.
 */
export async function connectStatus(): Promise<ConnectStatusResult> {
  const house = await ownerHouse();
  if (!house) return { ok: false, error: NO_HOUSE };

  if (!isGoogleConfigured()) {
    return {
      ok: true,
      status: { state: "not-configured", message: NOT_CONFIGURED, calendarId: null, ...NOT_YET },
    };
  }

  let linked = null;
  try {
    linked = await googleAccount(house.ownerId);
  } catch (error) {
    console.error("[google] could not read the linked account", error);
    return { ok: false, error: TROUBLE };
  }

  if (!linked || !linked.usable) {
    return {
      ok: true,
      status: { state: "not-linked", message: NOT_LINKED, calendarId: null, ...NOT_YET },
    };
  }

  // The stored scope, not the stored account. An owner can be linked, refreshing
  // tokens happily, and still hold a grant that predates what this app asks for.
  if (!hasCalendarScope(linked.scope)) {
    const reconsent = hasPartialCalendarScope(linked.scope);

    // For whoever set the deployment up, not for the owner. A grant that stays
    // short *after* the owner has consented again means the scope is missing
    // from the OAuth consent screen in the Google Cloud console — Google drops
    // an undeclared scope silently, so this log line is the only place the
    // difference between "they have not pressed the button" and "the console is
    // wrong" ever shows up. Naming the exact strings makes the fix a copy-paste.
    if (reconsent) {
      console.warn(
        "[google] the stored grant is missing scopes:",
        missingCalendarScopes(linked.scope).join(" "),
        "— check the OAuth consent screen lists them. See SETUP-GOOGLE.md.",
      );
    }

    return {
      ok: true,
      status: {
        state: "needs-consent",
        message: reconsent ? NEEDS_RECONSENT : NEEDS_CONSENT,
        // Deliberately not `null`: an owner upgrading a grant may already have a
        // calendar chosen, and forgetting it here would make them pick again.
        calendarId: house.googleCalendarId,
        reconsent,
        synced: 0,
        failed: 0,
      },
    };
  }

  if (!house.googleCalendarId) {
    return {
      ok: true,
      status: { state: "not-chosen", message: NOT_CHOSEN, calendarId: null, ...NOT_YET },
    };
  }

  const counts = await syncCounts(house.id);

  return {
    ok: true,
    status: {
      state: "connected",
      message: CONNECTED,
      calendarId: house.googleCalendarId,
      reconsent: false,
      ...counts,
    },
  };
}

/* ============================================================
   WHICH CALENDAR?
   ============================================================ */

/**
 * The calendars the owner owns, their default one first.
 *
 * Anything they merely subscribe to or were given write access to — a holidays
 * feed, a shared work calendar — is filtered out by Google itself
 * (`minAccessRole: 'owner'`), because the grant this app holds is
 * `calendar.events.owned` and offering a calendar it cannot write to would be
 * offering a dead end.
 *
 * **An empty list is a success, not a failure.** It means Google answered and
 * the owner owns no calendar this app can use, which is a state with an obvious
 * next step — make one — and the caller must offer that rather than reading
 * `[]` as a broken connection.
 */
export async function listCalendars(): Promise<CalendarListResult> {
  const house = await ownerHouse();
  if (!house) return { ok: false, error: NO_HOUSE };

  // The calendar has not been chosen yet — that is the entire point of this
  // call — so a missing one is not a reason to refuse.
  const connection = await connectionFor(house, {}, { requireCalendar: false });
  if (!isConnected(connection)) {
    return { ok: false, error: connection.reason === "not-configured" ? NOT_CONFIGURED : NOT_LINKED };
  }
  if (!hasCalendarScope(connection.scope)) return { ok: false, error: NEEDS_CONSENT };

  try {
    return { ok: true, calendars: await connection.client.listCalendars() };
  } catch (error) {
    console.error("[google] could not list calendars", error);
    return { ok: false, error: sentence(error) };
  }
}

/** A Google calendar id is an email-ish string. Guard the shape, not the value. */
const MAX_CALENDAR_ID = 320;

/**
 * Point the house at a calendar the owner already keeps.
 *
 * The id is checked against their own list before it is stored, which costs one
 * call and rules out both a typo and a calendar they cannot write to. Then the
 * pull runs immediately: the whole reason for choosing an existing calendar is
 * the weeks already in it, and making the owner wait for a cron to discover them
 * would make the feature look broken on the one screen where it has to look
 * obvious.
 */
export async function chooseCalendar(calendarId: string): Promise<GoogleResult> {
  const house = await ownerHouse();
  if (!house) return { ok: false, error: NO_HOUSE };

  const wanted = typeof calendarId === "string" ? calendarId.trim() : "";
  if (!wanted || wanted.length > MAX_CALENDAR_ID) {
    return { ok: false, error: "Pick a calendar from the list.", field: "calendarId" };
  }

  const connection = await connectionFor(house, {}, { requireCalendar: false });
  if (!isConnected(connection)) {
    return { ok: false, error: connection.reason === "not-configured" ? NOT_CONFIGURED : NOT_LINKED };
  }
  if (!hasCalendarScope(connection.scope)) return { ok: false, error: NEEDS_CONSENT };

  try {
    const choices = await connection.client.listCalendars();
    if (!choices.some((choice) => choice.calendarId === wanted)) {
      return { ok: false, error: GONE, field: "calendarId" };
    }
  } catch (error) {
    console.error("[google] could not confirm the calendar", error);
    return { ok: false, error: sentence(error) };
  }

  try {
    await setHouseCalendar(house.id, wanted);
  } catch (error) {
    console.error("[google] could not save the calendar", error);
    return { ok: false, error: "That did not save. Try again in a moment." };
  }

  revalidateGoogle(house.slug);

  // Best effort, and deliberately not awaited into the result: the calendar is
  // connected either way, and a slow first pull must not read as a failure.
  const pulled = await pullBlocks({ ...house, googleCalendarId: wanted });
  if (pulled.state === "failed") {
    console.error("[google] the first pull did not finish", pulled);
  }
  revalidateGoogle(house.slug);

  return { ok: true };
}

/**
 * Make the house a calendar of its own instead.
 *
 * For the owner who does not want the summer mixed into the calendar they live
 * by. A fresh calendar starts empty, so there is nothing to pull.
 */
export async function createCalendar(): Promise<GoogleResult> {
  const house = await ownerHouse();
  if (!house) return { ok: false, error: NO_HOUSE };

  const connection = await connectionFor(house, {}, { requireCalendar: false });
  if (!isConnected(connection)) {
    return { ok: false, error: connection.reason === "not-configured" ? NOT_CONFIGURED : NOT_LINKED };
  }
  if (!hasCalendarScope(connection.scope)) return { ok: false, error: NEEDS_CONSENT };

  let calendarId: string;
  try {
    const made = await connection.client.createCalendar(house.name.trim() || "Yazlık");
    calendarId = made.calendarId;
  } catch (error) {
    console.error("[google] could not make a calendar", error);
    return { ok: false, error: sentence(error) };
  }

  try {
    await setHouseCalendar(house.id, calendarId);
  } catch (error) {
    console.error("[google] could not save the new calendar", error);
    return { ok: false, error: "That did not save. Try again in a moment." };
  }

  revalidateGoogle(house.slug);
  return { ok: true };
}

/* ============================================================
   LETTING GO
   ============================================================ */

/**
 * Stop syncing. The calendar and everything on it stay exactly where they are.
 *
 * Nothing is deleted from Google — the events describe real weeks, and quietly
 * wiping a summer off somebody's calendar because they pressed disconnect would
 * be the worst thing this integration could do. The app simply forgets the
 * calendar and every event id it stored, so a later connection starts clean.
 *
 * The Google *sign-in* is untouched: the owner can still use the button. This
 * gives back the calendar, not the door.
 */
export async function disconnect(): Promise<GoogleResult> {
  const house = await ownerHouse();
  if (!house) return { ok: false, error: NO_HOUSE };

  if (!house.googleCalendarId) {
    // Already disconnected. Saying so is friendlier than an error about it.
    return { ok: true };
  }

  try {
    await setHouseCalendar(house.id, null);
  } catch (error) {
    console.error("[google] could not disconnect", error);
    return { ok: false, error: "That did not save. Try again in a moment." };
  }

  revalidateGoogle(house.slug);
  return { ok: true };
}

/* ============================================================
   AFTER A WRITE
   ============================================================ */

/** The dashboard shows the connection; the house page shows what the blocks took. */
function revalidateGoogle(slug: string) {
  revalidatePath("/app", "layout");
  revalidatePath(`/h/${slug}`);
}
