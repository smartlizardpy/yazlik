import { runScheduledWork } from "@/lib/cron";

/**
 * The one scheduled endpoint. Called by the cron declared in `vercel.ts`.
 *
 * Guarded by `CRON_SECRET`, which Vercel sends as `Authorization: Bearer …` on
 * its own schedule invocations. Without the guard this is a public URL that
 * emails your guests, so an absent secret refuses rather than waves everyone
 * through — the failure mode of a missing variable should be "nothing runs",
 * not "anyone can run it".
 *
 * `runScheduledWork` never throws, so the response is always the report. A 200
 * here means the pass finished, not that everything in it succeeded; read
 * `errors` for that.
 */
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json(
      { error: "CRON_SECRET is not set, so scheduled work is disabled." },
      { status: 503 },
    );
  }

  const offered = request.headers.get("authorization")?.replace("Bearer ", "");
  if (offered !== expected) {
    return new Response("unauthorized", { status: 401 });
  }

  const result = await runScheduledWork();
  return Response.json(result);
}
