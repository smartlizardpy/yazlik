/**
 * The five emails, and the only place any of them is written.
 *
 * | Function | Reader | Language | Carries |
 * | --- | --- | --- | --- |
 * | {@link sendRequestReceived} | owner | English | who asked, their note, approve/decline |
 * | {@link sendBookingConfirmed} | guest | the house's | the `.ics`, the booking link |
 * | {@link sendBookingDeclined} | guest | the house's | the owner's reason, the calendar |
 * | {@link sendArrivalReminder} | guest | the house's | the booking link, three days out |
 * | {@link sendGuestCancelled} | owner | English | the dates that came back |
 *
 * ### Four rules hold across all five
 *
 * 1. **Guest mail is in `house.language`, owner mail is English.** That is the
 *    plan's split, and it is the same one the pages use: `/h/[slug]` and
 *    `/b/[token]` render in the house's language, `/app` is English in v1.
 *
 * 2. **Every value a person typed is HTML-escaped.** Guest name, note and
 *    decline reason all reach a mail client as markup if they are not, and a
 *    guest called `<script>` is a real thing that a real family member will
 *    type. The escape happens at the boundary in {@link p} and friends — every
 *    text node goes through one of them, so there is no path that forgets. The
 *    only unescaped strings are hrefs, which this file builds itself out of the
 *    app URL and a nanoid.
 *
 * 3. **Sending never throws into the caller.** An approval that succeeded must
 *    not fail because a mail provider is down — the row is already committed and
 *    the guest can still see `/b/[token]`. Same principle the plan applies to
 *    the Google sync: the write lands first, the notification is best effort.
 *    {@link dispatch} catches everything, including a bad row that makes the
 *    body throw while it is being built.
 *
 * 4. **Written for a phone.** A short subject with the dates in it, the dates
 *    again on the first line of the body, one link, one line saying who sent it.
 *    No columns, no images, no button that renders as a grey box in Outlook.
 *
 * The `*Mail` builders are pure and exported: they touch no database and no
 * clock, which is what makes `lib/emails.test.ts` able to assert the escaping
 * without a connection string.
 */

import { eq } from "drizzle-orm";

import type { Booking, House } from "@/db/schema";
import { formatDay, nightsBetween, type DateStr } from "@/lib/dates";
import { send, type Attachment } from "@/lib/email";
import { bookingInvite, icsFilename } from "@/lib/ics";
import { dayLabel, rangeLabel, t, tn, toLang, type Lang } from "@/lib/i18n";

/* ============================================================
   TYPES
   ============================================================ */

/**
 * The house columns an email reads. A `Pick`, so a caller holding a partial
 * house — or a test — does not have to invent a `feedToken`. A full row
 * satisfies it, which is what every caller actually passes.
 */
export type MailHouse = Pick<
  House,
  "ownerId" | "slug" | "name" | "town" | "country" | "language"
>;

/** The booking columns an email reads. `id` is what the `.ics` UID is built from. */
export type MailBooking = Pick<
  Booking,
  | "id"
  | "kind"
  | "guestName"
  | "guestEmail"
  | "guests"
  | "note"
  | "startDate"
  | "endDate"
  | "status"
  | "declineReason"
  | "token"
>;

/** A message, built but not yet addressed. `to` is resolved by the sender. */
export type Mail = {
  subject: string;
  html: string;
  attachments?: Attachment[];
};

/* ============================================================
   ADDRESSES AND URLS
   ============================================================ */

/**
 * Read at call time rather than at import, so a test — or a preview deployment
 * that sets the variable late — gets the URL it actually configured.
 */
function appUrl(): string {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? "http://localhost:3100";
  return url.replace(/\/+$/, "");
}

/** `/b/[token]` — the guest's own page, and the only booking URL they ever get. */
function bookingUrl(token: string): string {
  return `${appUrl()}/b/${encodeURIComponent(token)}`;
}

/** `/h/[slug]` — the house, with the calendar on it. */
function houseUrl(slug: string): string {
  return `${appUrl()}/h/${encodeURIComponent(slug)}`;
}

/** `/app` — the dashboard. Owner mail links here and nowhere else. */
function dashboardUrl(): string {
  return `${appUrl()}/app`;
}

/**
 * The owner's address.
 *
 * `@/db` is imported lazily on purpose: it throws at module load without
 * `DATABASE_URL`, and importing it at the top would make this whole file — the
 * escaping included — impossible to unit test without a database.
 */
async function ownerEmail(ownerId: string): Promise<string | null> {
  const [{ db }, { user }] = await Promise.all([
    import("@/db"),
    import("@/db/auth-schema"),
  ]);
  const [row] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, ownerId))
    .limit(1);
  return row?.email ?? null;
}

/* ============================================================
   HTML
   ============================================================ */

/**
 * Everything a person typed passes through here before it is markup.
 *
 * Dictionary strings go through it too. They contain no HTML and never will —
 * escaping them costs nothing and means the rule is "escape every text node",
 * which is a rule that can actually be followed, rather than "escape the ones
 * that came from a person", which is a rule that gets forgotten once.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The one accent, matching `--primary`. Hex, because mail has no CSS variables. */
// Ink, matching the app: this product has no accent hue. Email clients
// handle dark mode badly and inconsistently, so these stay light-only.
const ACCENT = "#141210";
const INK = "#0a0a0a";
const MUTED = "#737373";

function p(text: string, style = ""): string {
  const css = style ? `margin:0 0 16px;${style}` : "margin:0 0 16px";
  return `<p style="${css}">${escapeHtml(text)}</p>`;
}

/** The dates. First line of every message, so the subject's promise is kept. */
function lead(text: string): string {
  return p(text, "font-weight:600;font-variant-numeric:tabular-nums");
}

/**
 * Somebody's own words — a guest's note, an owner's reason for declining.
 * Quoted rather than paraphrased, and `pre-line` so the line breaks they typed
 * survive into a mail client that would otherwise collapse them.
 */
function quote(text: string): string {
  return `<p style="margin:0 0 16px;padding-left:12px;border-left:2px solid #e5e5e5;white-space:pre-line;color:#525252">${escapeHtml(text)}</p>`;
}

/** One link per message. A plain anchor: a "button" is a grey box in Outlook. */
function action(href: string, label: string): string {
  return `<p style="margin:0 0 16px"><a href="${href}" style="color:${ACCENT}">${escapeHtml(label)}</a></p>`;
}

/** Who sent this and why it arrived. Every message ends with one. */
function footer(text: string): string {
  return `<p style="margin:24px 0 0;font-size:13px;color:${MUTED}">${escapeHtml(text)}</p>`;
}

function layout(blocks: (string | null | false | undefined)[]): string {
  return [
    `<div style="font-family:${FONT};font-size:16px;line-height:1.5;color:${INK};max-width:560px">`,
    ...blocks.filter((block): block is string => Boolean(block)),
    `</div>`,
  ].join("");
}

/* ============================================================
   THE STAY, IN WORDS
   ============================================================ */

/**
 * A range short enough for a subject line: `4–10 August 2026`.
 *
 * Not a dictionary key, because the string would be identical in both
 * languages and the parity test rightly refuses those. The month name and the
 * day/month/year order still come from the dictionary, via `dayLabel` — the
 * compact form only holds when the day number leads, which is what the guard on
 * `format.day` checks. Any locale that orders it differently falls back to the
 * long form rather than producing something wrong.
 */
export function shortRange(start: DateStr, end: DateStr, lang: Lang): string {
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  const dayLeads = t("format.day", lang).startsWith("{day}");
  if (sameMonth && dayLeads) {
    return `${Number(start.slice(8, 10))}–${dayLabel(end, lang)}`;
  }
  return rangeLabel(start, end, lang);
}

/** The guest's dates, in the house's language: `1 – 8 August · 7 nights · 4 guests`. */
function guestStay(booking: MailBooking, lang: Lang): string {
  const nights = nightsBetween(booking.startDate, booking.endDate);
  return [
    rangeLabel(booking.startDate, booking.endDate, lang),
    tn("count.nights", nights, lang),
    tn("count.guests", booking.guests, lang),
  ].join(" · ");
}

/**
 * The same line for the owner, in English — the dashboard's language.
 *
 * The en dash between the days is the one `app/app/page.tsx` draws, so a stay
 * looks the same in the mail as it does in the list the mail links to.
 */
function ownerStay(booking: MailBooking): string {
  const nights = nightsBetween(booking.startDate, booking.endDate);
  const nightWord = nights === 1 ? "night" : "nights";
  const guestWord = booking.guests === 1 ? "guest" : "guests";
  return `${formatDay(booking.startDate)} – ${formatDay(booking.endDate)} · ${nights} ${nightWord} · ${booking.guests} ${guestWord}`;
}

/** Matches `app/app/page.tsx` and the calendar: a nameless guest is still somebody. */
function guestName(booking: MailBooking): string {
  return booking.guestName?.trim() || "Someone";
}

function houseLang(house: MailHouse): Lang {
  return toLang(house.language);
}

/* ============================================================
   THE CALENDAR FILE
   ============================================================ */

/**
 * The `.ics` for the confirmation, or nothing.
 *
 * A calendar file that fails to build is not a reason to withhold the mail that
 * says the stay is confirmed — so it degrades to an email with one fewer
 * attachment, and the sentence announcing the attachment is dropped with it
 * rather than left promising a file that is not there.
 */
function invite(house: MailHouse, booking: MailBooking): Attachment[] {
  try {
    return [
      {
        filename: icsFilename(house.name),
        content: bookingInvite(house, booking, { baseUrl: appUrl() }),
      },
    ];
  } catch (error) {
    console.error("[emails] the calendar file did not build", error);
    return [];
  }
}

/* ============================================================
   THE BUILDERS
   ============================================================ */

/**
 * To the owner: somebody asked for dates.
 *
 * English, and it carries everything needed to decide without opening the app —
 * the dates, the headcount, the note, and how to reach them — because the
 * decision often happens on a phone in a queue somewhere. The link is still
 * there for the tap that actually does it.
 */
export function requestReceivedMail(house: MailHouse, booking: MailBooking): Mail {
  const name = guestName(booking);
  const note = booking.note?.trim();
  const email = booking.guestEmail?.trim();

  return {
    subject: `${name} asked for ${shortRange(booking.startDate, booking.endDate, "en")}`,
    html: layout([
      lead(ownerStay(booking)),
      p(`${name} asked to stay at ${house.name}.`),
      note ? quote(note) : null,
      email ? p(`${name} · ${email}`) : null,
      action(dashboardUrl(), "Approve or decline"),
      footer(`Yazlık sent this because you own ${house.name}.`),
    ]),
  };
}

/**
 * To the guest: the house is yours.
 *
 * The `.ics` rides along, because the moment a stay is confirmed is the moment
 * somebody wants it in their phone. The link goes to `/b/[token]`, which is
 * where the arrival packet lives — the door code stays on a page behind an
 * unguessable token rather than in an inbox that gets forwarded.
 */
export function bookingConfirmedMail(house: MailHouse, booking: MailBooking): Mail {
  const lang = houseLang(house);
  const attachments = invite(house, booking);

  return {
    subject: t("email.confirmed.subject", lang, {
      house: house.name,
      range: shortRange(booking.startDate, booking.endDate, lang),
    }),
    html: layout([
      lead(guestStay(booking, lang)),
      p(t("email.confirmed.body", lang, { house: house.name })),
      attachments.length > 0 ? p(t("email.confirmed.attached", lang)) : null,
      action(bookingUrl(booking.token), t("form.sent.view", lang)),
      footer(t("email.signoff", lang, { house: house.name })),
    ]),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

/**
 * To the guest: not these dates.
 *
 * The owner's reason is quoted whenever they wrote one, unedited and
 * unsoftened — it is the part of a decline that keeps it a conversation. The
 * link goes to the house rather than the booking, because the useful next move
 * is picking other dates, and it carries the same words as the button it lands
 * on.
 */
export function bookingDeclinedMail(house: MailHouse, booking: MailBooking): Mail {
  const lang = houseLang(house);
  const reason = booking.declineReason?.trim();

  return {
    subject: t("email.declined.subject", lang, {
      house: house.name,
      range: shortRange(booking.startDate, booking.endDate, lang),
    }),
    html: layout([
      lead(guestStay(booking, lang)),
      p(t("email.declined.body", lang, { house: house.name })),
      reason ? p(t("booking.declineReason", lang), `color:${MUTED};font-size:13px`) : null,
      reason ? quote(reason) : null,
      action(houseUrl(house.slug), t("house.cta", lang)),
      footer(t("email.signoff", lang, { house: house.name })),
    ]),
  };
}

/**
 * To the guest: this is the week.
 *
 * Sent three days out by `/api/cron/reminders`. It says one thing the guest may
 * not have thought about — the arrival details are already on their booking
 * page — and links straight to them.
 */
export function arrivalReminderMail(house: MailHouse, booking: MailBooking): Mail {
  const lang = houseLang(house);

  return {
    subject: t("email.reminder.subject", lang, {
      house: house.name,
      range: shortRange(booking.startDate, booking.endDate, lang),
    }),
    html: layout([
      lead(guestStay(booking, lang)),
      p(
        t("email.reminder.body", lang, {
          house: house.name,
          from: dayLabel(booking.startDate, lang),
        }),
      ),
      action(bookingUrl(booking.token), t("form.sent.view", lang)),
      footer(t("email.signoff", lang, { house: house.name })),
    ]),
  };
}

/**
 * To the owner: those dates came back.
 *
 * The one email whose subject is the whole message — an owner reading it on a
 * lock screen already knows everything that matters. The body repeats it for
 * the archive, and the link is the dashboard, where the week is now free.
 */
export function guestCancelledMail(house: MailHouse, booking: MailBooking): Mail {
  const name = guestName(booking);

  return {
    subject: `${name} cancelled ${shortRange(booking.startDate, booking.endDate, "en")}`,
    html: layout([
      lead(ownerStay(booking)),
      p(`${name} cancelled their stay at ${house.name}. The dates are free again.`),
      action(dashboardUrl(), "Open the dashboard"),
      footer(`Yazlık sent this because you own ${house.name}.`),
    ]),
  };
}

/* ============================================================
   SENDING
   ============================================================ */

/**
 * Resolve an address, build the message, hand it to Resend — and swallow
 * anything that goes wrong on the way.
 *
 * The booking is already committed by the time any of this runs. A missing
 * address, a dead provider, a row with a date the builder chokes on: each of
 * them costs one notification and nothing else. They are logged, loudly enough
 * to find in a terminal, because a silent catch is how mail stops working for a
 * month without anyone noticing.
 */
async function dispatch(
  label: string,
  resolveTo: () => Promise<string | null | undefined> | string | null | undefined,
  build: () => Mail,
): Promise<void> {
  try {
    const to = await resolveTo();
    if (!to) {
      console.warn(`[emails] ${label}: no address to send to`);
      return;
    }
    await send({ to, ...build() });
  } catch (error) {
    console.error(`[emails] ${label} did not send`, error);
  }
}

/** A guest asked for dates. To the owner, in English. */
export async function sendRequestReceived(
  house: MailHouse,
  booking: MailBooking,
): Promise<void> {
  await dispatch(
    "request received",
    () => ownerEmail(house.ownerId),
    () => requestReceivedMail(house, booking),
  );
}

/** The owner said yes. To the guest, in the house's language, with the `.ics`. */
export async function sendBookingConfirmed(
  house: MailHouse,
  booking: MailBooking,
): Promise<void> {
  await dispatch(
    "booking confirmed",
    () => booking.guestEmail,
    () => bookingConfirmedMail(house, booking),
  );
}

/** The owner said no. To the guest, in the house's language, with their reason. */
export async function sendBookingDeclined(
  house: MailHouse,
  booking: MailBooking,
): Promise<void> {
  await dispatch(
    "booking declined",
    () => booking.guestEmail,
    () => bookingDeclinedMail(house, booking),
  );
}

/** Three days out. To the guest, in the house's language. */
export async function sendArrivalReminder(
  house: MailHouse,
  booking: MailBooking,
): Promise<void> {
  await dispatch(
    "arrival reminder",
    () => booking.guestEmail,
    () => arrivalReminderMail(house, booking),
  );
}

/** A guest gave the dates back. To the owner, in English. */
export async function sendGuestCancelled(
  house: MailHouse,
  booking: MailBooking,
): Promise<void> {
  await dispatch(
    "guest cancelled",
    () => ownerEmail(house.ownerId),
    () => guestCancelledMail(house, booking),
  );
}
