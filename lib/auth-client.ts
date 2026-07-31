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

/**
 * Hand the browser to Google, and ask to be given back at `/app`.
 *
 * There is no `googleClient()` plugin to add — social sign-in is part of
 * better-auth's core client, so the plugin list above stays as it was.
 *
 * This does not resolve the way the magic-link call does. On success the
 * response carries `{ redirect: true, url }` and better-auth's own fetch plugin
 * sets `window.location.href` from it, so the page is already leaving by the
 * time anyone could read the result. Callers get a rejected promise or an
 * `error` only when the round trip never started — offline, or a server with no
 * Google provider registered. Whatever state a caller sets before this should
 * stay set; there is no "back to idle" on the happy path.
 *
 * `errorCallbackURL` is the one that matters for a person. Without it, a
 * cancelled consent screen or a mismatched account lands on better-auth's bare
 * `/api/auth/error` page — a dead end with no way back to the house. With it,
 * they come back to `/sign-in?error=…`, which the form reads and answers in
 * words, with the email link still on offer underneath.
 */
export function signInWithGoogle() {
  return signIn.social({
    provider: "google",
    callbackURL: "/app",
    errorCallbackURL: "/sign-in",
  });
}
