/**
 * One question, one answer: **is Google configured on this deployment?**
 *
 * Two things depend on it and they are in different worlds — `lib/auth.ts`
 * decides whether to register the social provider at all, and the sign-in page
 * decides whether to render a Google button. Neither should be reading
 * `process.env` and inventing its own idea of "configured", because the moment
 * those two ideas disagree you get the worst possible screen: a Google button
 * that leads nowhere.
 *
 * So this module is deliberately tiny and depends on nothing. It imports no
 * `googleapis`, no better-auth, no database. A client component's server-side
 * render can reach it, a route can reach it, and it costs an object literal.
 *
 * ### It cannot throw
 *
 * There are no credentials on this machine today. `.env.local` has no
 * `GOOGLE_CLIENT_ID` and no `GOOGLE_CLIENT_SECRET`, the dev server boots, the
 * build succeeds, and the tests pass — and all of that has to stay true while
 * the owner is off in the Google console creating an OAuth client. Missing
 * credentials are a state this app is designed to sit in indefinitely, not an
 * error, so nothing here validates, warns, or throws. It answers `null` and the
 * caller decides what to do about it.
 *
 * ### Read per call, never at module load
 *
 * `process.env` is read inside the function. Module scope would freeze the
 * answer at import time, which is wrong in exactly the situation that is about
 * to happen: the owner pastes two lines into `.env.local`, the dev server
 * restarts the module graph, and the answer has to change. It also keeps the
 * functions testable without module resets.
 *
 * @see lib/google/client.ts — carries an older copy of this logic, written when
 * it was the only Google file in the tree. The two agree exactly, and
 * `config.test.ts` asserts that they still do; when `client.ts` is next opened,
 * it should import from here and the copy should go.
 */

/** The OAuth client this deployment is registered as. Both halves or neither. */
export type GoogleCredentials = {
  clientId: string;
  clientSecret: string;
};

/**
 * The credentials, or `null` if this deployment has none.
 *
 * Blank counts as absent, and whitespace counts as blank. `.env.local` files
 * grow `GOOGLE_CLIENT_ID=` placeholders long before they grow values, and a
 * half-pasted secret with a trailing newline is a likelier failure than a
 * missing key. Treating `""` as configured would hand better-auth a provider
 * that fails at Google's door instead of never being offered.
 */
export function googleCredentials(): GoogleCredentials | null {
  const clientId = (process.env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * The boolean the UI asks for.
 *
 * The honest question before drawing a **Continue with Google** button: if this
 * is `false`, the provider is not registered on the server either, and the
 * button would round-trip to a 400. A missing button is a screen that still
 * works; a dead button is a door that lies.
 */
export function isGoogleConfigured(): boolean {
  return googleCredentials() !== null;
}
