"use client";

import { createAuthClient } from "better-auth/react";
import { magicLinkClient } from "better-auth/client/plugins";

/**
 * No `baseURL` on purpose: the client posts to whatever origin served the page.
 *
 * Pinning it to an absolute address breaks the moment you browse from anywhere
 * else. Setting it to the LAN address so a phone could sign in made every
 * request from `localhost` cross-origin, and the browser refused the preflight;
 * pinning it back to `localhost` breaks the phone instead. Same-origin is the
 * only value that is correct from both, and in production there is only one
 * origin anyway.
 *
 * The server still needs an absolute `BETTER_AUTH_URL`, because a magic link in
 * an email has to say where to come back to.
 */
export const authClient = createAuthClient({
  plugins: [magicLinkClient()],
});

export const { signIn, signOut, useSession } = authClient;
