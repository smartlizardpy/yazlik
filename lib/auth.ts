import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db";
import { sendMagicLinkEmail } from "./email";

/**
 * Owners only. Guests never authenticate — a booking token in a URL is their
 * identity, which is the whole point of a link you can forward to family.
 *
 * Magic link only: nobody wants to type a password on a phone, and there is no
 * password to leak.
 */
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
  plugins: [
    magicLink({
      sendMagicLink: async ({ email, url }) => sendMagicLinkEmail(email, url),
    }),
    nextCookies(),
  ],
});
