/**
 * The two unguessable strings this product hands out.
 *
 * A house slug ends up in `/h/[slug]`, a booking token in `/b/[token]`, and a
 * feed token in a calendar subscription URL. All three get forwarded in
 * WhatsApp, read off one phone onto another, and occasionally said out loud
 * across a kitchen — so the alphabet drops every character that is hard to tell
 * apart at arm's length:
 *
 *   - no `0` / `O`, no `1` / `l` / `I`
 *   - lowercase only, so a phone keyboard's auto-capitalise cannot break a link
 *
 * What is left is 31 symbols. That is weaker per character than base64, so the
 * lengths compensate: 12 characters is ~59 bits, 16 is ~79. Both are far past
 * guessable, and neither is a security boundary on its own — a slug hides a
 * house from crawlers, it does not authenticate anyone.
 */

import { customAlphabet } from "nanoid";

/** URL-safe, lowercase, no visual lookalikes. */
export const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

/** Characters in a house slug. */
export const SLUG_LENGTH = 12;

/** Characters in a booking token or a feed token. */
export const TOKEN_LENGTH = 16;

const generate = customAlphabet(ID_ALPHABET);

/** A house slug: the public address of a house at `/h/[slug]`. */
export function newSlug(): string {
  return generate(SLUG_LENGTH);
}

/**
 * A private token. Used for `bookings.token` (the guest's own booking page) and
 * `houses.feedToken` (the calendar subscribe URL). Longer than a slug because
 * these two are the closest thing a guest has to a credential.
 */
export function newToken(): string {
  return generate(TOKEN_LENGTH);
}

/**
 * Does `value` look like something this module made? Cheap shape check for
 * route params, so a junk URL is a 404 rather than a database round trip.
 * It says nothing about whether the id exists.
 */
export function isAppId(value: string, length: number): boolean {
  if (value.length !== length) return false;
  for (const char of value) {
    if (!ID_ALPHABET.includes(char)) return false;
  }
  return true;
}
