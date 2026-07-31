/**
 * `/api/ics/[token]` — the guest's own stay, as a calendar file.
 *
 * Public, like `/b/[token]`, and for the same reason: the token *is* the
 * credential. The confirmation email carries the same bytes as an attachment;
 * this route is the version a guest can re-open a week later from the link they
 * still have, without us keeping a copy of the attachment anywhere.
 *
 * ### Everything that is not a confirmed guest stay is 404
 *
 * A wrong token, a request nobody has answered, a declined or cancelled one, and
 * an owner's `kind: 'block'` row all get the same four bytes. Never 403, never a
 * different message per case — the difference between "no such booking" and
 * "that booking is not confirmed" is exactly the fact a prober is fishing for,
 * and a block's note ("Roof repair") is the owner talking to themselves.
 *
 * The status check is also what keeps the *file* honest. A pending request is
 * not a plan; putting one in somebody's calendar would show a week as booked
 * that the owner has not agreed to.
 *
 * ### The header is the part that breaks
 *
 * `Content-Disposition` is a byte string, not a Unicode one. A Turkish house
 * name reaches some clients as `Ã‡eÅme.ics` and, worse, a name carrying a quote
 * or a newline would end the parameter early and let the rest of the name write
 * its own header. {@link icsFilename} already transliterates and slugs to
 * `[a-z0-9-]+\.ics`; {@link SAFE_FILENAME} is the assertion that it did, checked
 * here because this is the line that writes the header. If it ever fails the
 * name is dropped, not repaired — `stay.ics` is a fine name and a corrupt header
 * is not a fine header.
 *
 * No `filename*=UTF-8''…` companion parameter, deliberately. It would put the
 * accented form back on every client that understands it, which is the thing
 * the ASCII slug exists to avoid.
 */

import { bookingByToken } from "@/lib/bookings";
import { ICS_CONTENT_TYPE, bookingInvite, icsFilename } from "@/lib/ics";

/**
 * What may appear between the quotes of `filename="…"`.
 *
 * ASCII letters, digits, dot, dash, underscore — so no quote, no backslash, no
 * semicolon, no CR or LF, and nothing above U+007F can reach the header.
 */
const SAFE_FILENAME = /^[A-Za-z0-9._-]{1,80}$/;

/** The name a house whose slug came out empty gets. Also the fallback above. */
const FALLBACK_FILENAME = "stay.ics";

/** One answer for "no such token", "not confirmed", and "that is a block". */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;

  const found = await bookingByToken(token);
  if (!found) return notFound();

  const { booking, house } = found;

  // A block has a token because the column is NOT NULL UNIQUE, never because
  // anybody was meant to hold one.
  if (booking.kind !== "guest") return notFound();
  if (booking.status !== "confirmed") return notFound();

  let body: string;
  try {
    // `baseUrl` is left to the module's own APP_URL rather than taken from this
    // request: the link inside the file must not be steerable by a Host header.
    body = bookingInvite(house, booking);
  } catch (error) {
    // Only reachable if a `date` column stopped holding a date. A fault should
    // look like a fault — dressing it as a 404 would send someone hunting for a
    // missing booking that is right there.
    console.error("[api/ics] could not build the invite", error);
    return new Response("Could not build the calendar file", {
      status: 500,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  const slugged = icsFilename(house.name);
  const filename = SAFE_FILENAME.test(slugged) ? slugged : FALLBACK_FILENAME;

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": ICS_CONTENT_TYPE,
      "content-disposition": `attachment; filename="${filename}"`,
      // The answer changes the moment the owner or the guest changes their mind,
      // and the URL is a credential either way. Nothing caches this.
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // A booking link should not turn up in a search result.
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
