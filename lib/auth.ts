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
   * Identity only. **No calendar scope here, on purpose.**
   *
   * better-auth's Google defaults are `openid`, `email`, `profile` and nothing
   * is added to them, so the first screen a new owner ever sees says "Yazlık
   * wants your name and email address" and stops. Calendar access is a separate
   * consent, asked later from Settings by someone who has already decided they
   * want it — and never asked at all of an owner who doesn't.
   *
   * `accessType: "offline"` and `prompt: "consent"` are what make a **refresh
   * token** arrive, and both are load-bearing for the calendar work that comes
   * after this. Google returns a refresh token only when the request is offline
   * *and* the grant is new — a returning user who has already consented gets an
   * access token and silence. `prompt: "consent"` is what forces the second ask
   * when the calendar scopes are added to an account that already granted
   * identity; without it that upgrade succeeds, stores no refresh token, and
   * sync dies at the first hour boundary with nothing in the logs to explain it.
   *
   * The cost is that Google shows its consent screen on every sign-in rather
   * than remembering. For two lines it is the right trade.
   *
   * ### `prompt: "consent"` is also the only way to *widen* a grant
   *
   * A scope is never granted retroactively. When this app started needing three
   * calendar scopes instead of one, every owner who had already consented kept
   * handing back the old, short grant — nothing looked broken, the tokens
   * refreshed fine, and the calendar simply could not be read. The fix is to send
   * them through consent again, which `prompt: "consent"` is what makes possible:
   * without it Google recognises the returning user, re-issues what it already
   * holds, and the second ask is a silent no-op.
   *
   * better-auth's Google provider sends `include_granted_scopes: "true"` of its
   * own accord, so the re-consent is additive — the widened grant carries the
   * identity scopes forward rather than replacing them — and its OAuth callback
   * writes the new `scope` back onto the existing `account` row instead of
   * refusing an already-linked provider. Both were read out of
   * `@better-auth/core@1.6.25` (`social-providers/google.ts`) and
   * `better-auth@1.6.25` (`api/routes/callback.mjs`), because "it re-links
   * cleanly" is the kind of assumption that is only wrong in production.
   *
   * `app/_actions/google.ts` decides *when* to ask, by comparing the stored
   * `account.scope` against `GOOGLE_CALENDAR_SCOPES`; the button lives in
   * `app/app/settings/google-section.tsx`.
   *
   * Option names checked against `@better-auth/core@1.6.25`'s `GoogleOptions`
   * (`social-providers/google.ts`), which passes `options.accessType` and
   * `options.prompt` straight into the authorization URL. Getting either name
   * wrong is silent — the URL simply lacks the parameter.
   *
   * Tokens land in better-auth's own `account` table (`accessToken`,
   * `refreshToken`, `accessTokenExpiresAt`, `scope`), which is where the
   * calendar client reads them from. Nothing bespoke stores them.
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
