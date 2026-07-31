import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db";
import { googleCredentials } from "@/lib/google/config";
import { sendMagicLinkEmail } from "./email";

/**
 * Owners only. Guests never authenticate — a booking token in a URL is their
 * identity, which is the whole point of a link you can forward to family.
 *
 * No password behind either door: nobody wants to type one on a phone, and
 * there is nothing to leak. Google is the wide door once it exists; the magic
 * link is the one that has always been there and stays until Google has been
 * proven on a real deployment, because taking it away first would lock an owner
 * out of their own house with no second key.
 */

/**
 * Google is registered only when this deployment actually has an OAuth client.
 *
 * With the variables absent this is `null`, `socialProviders` is `{}`, and
 * better-auth's `Object.entries(options.socialProviders || {})` finds nothing —
 * the same auth instance the app has been running all along, no provider, no
 * warning, no throw. That is not a nicety: the credentials do not exist yet, and
 * everything here has to keep booting until they do.
 *
 * Read once, at module load, because that is when the config object is built.
 * A dev server restart is what picks up a freshly pasted `.env.local`, which is
 * the same restart the rest of the config already needs.
 */
const google = googleCredentials();

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  session: {
    // 30 days — an owner checks their calendar a few times a summer, and being
    // logged out between requests would be its own small betrayal.
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  emailAndPassword: { enabled: false },
  /**
   * Identity only, and now that is all there is.
   *
   * better-auth's Google defaults are `openid`, `email`, `profile` and nothing
   * is added to them, so the only screen a new owner ever sees says "Yazlık
   * wants your name and email address" and stops. There is no second, larger
   * consent behind it any more: the calendar integration that needed one is
   * gone, replaced by a subscribe feed that asks Google for nothing.
   *
   * `accessType: "offline"` asks for a refresh token. Nothing needs one today —
   * the Google Calendar sync that did has been removed in favour of the
   * `.ics` subscribe feed, which needs no account at all. It stays because a
   * grant that never asked for offline access cannot be upgraded later without
   * sending every owner back through consent, and that is a worse day than one
   * unused token.
   *
   * Option names checked against `@better-auth/core@1.6.25`'s `GoogleOptions`
   * (`social-providers/google.ts`), which passes `options.accessType` and
   * `options.prompt` straight into the authorization URL. Getting either name
   * wrong is silent — the URL simply lacks the parameter.
   *
   * Tokens land in better-auth's own `account` table (`accessToken`,
   * `refreshToken`, `accessTokenExpiresAt`, `scope`), which is where the
   * `account` table. Nothing bespoke stores them.
   *
   * An owner who already signed in by magic link keeps the same user row: their
   * email is verified (the magic link is what verified it) and Google's
   * `email_verified` is true, which is exactly the pair better-auth's implicit
   * account linking requires. Same person, same house, second door.
   */
  socialProviders: google
    ? {
        google: {
          clientId: google.clientId,
          clientSecret: google.clientSecret,
          accessType: "offline",
          prompt: "consent",
        },
      }
    : {},
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => sendMagicLinkEmail(email, url),
    }),
    nextCookies(),
  ],
});
