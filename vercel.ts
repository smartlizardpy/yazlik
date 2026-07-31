import type { VercelConfig } from "@vercel/config/v1/types";

/**
 * Deployment configuration.
 *
 * `vercel.ts` rather than `vercel.json` because this file has a reason to
 * explain itself, and JSON cannot hold a comment. Everything Next.js can infer
 * — the framework, the build command, the output directory — is left inferred;
 * naming it here only creates a second place to be wrong.
 */
export const config: VercelConfig = {
  /**
   * One job, once a day, doing three things: arrival reminders, a retry of any
   * stay that never reached Google, and a pull of all-day events out of each
   * connected calendar. `lib/cron.ts` explains why they share a pass.
   *
   * **Once a day is not a preference, it is the Hobby plan's limit** — and it
   * happens to be right anyway. The reminder query matches stays starting on
   * exactly one day, so running twice would mail the same guest twice; the
   * comment on `sendReminders` says what to add before that ever changes.
   *
   * 07:00 UTC is 10:00 in Turkey, which is where the houses are. A reminder
   * about a holiday should arrive over breakfast, not at three in the morning,
   * and Vercel's schedules are always UTC — so this is the conversion, written
   * down, rather than a number someone has to work out again later.
   *
   * The endpoint refuses anything without `CRON_SECRET`. Vercel sends it as a
   * bearer token on its own invocations; a deployment that forgets to set it
   * gets a 503 and no scheduled work, which is the correct failure for a URL
   * that would otherwise email guests to whoever found it.
   */
  crons: [{ path: "/api/cron", schedule: "0 7 * * *" }],
};

export default config;
