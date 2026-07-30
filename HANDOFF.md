# Handoff

_Last updated: 2026-07-30, end of phase 1._

## Where things stand

Phase 1 (scaffold) is underway and is the only phase that has been touched. Next.js 16 with
Tailwind v4 and shadcn/ui is up, the Neon project **yazlik** is provisioned and `DATABASE_URL`
is in `.env.local`, and the Drizzle schema for the five tables is written. Nothing is
user-facing yet — there is no sign-in, no house, no guest page. Phases 2–8 have not started.
Nothing is blocked; the two things that need you (Google credentials, one live model
round-trip of the guide prompt) belong to phases 6 and 7 and were always going to wait for
morning.

## Done

Nothing shipped end-to-end yet.

## In progress

**Phase 1 — Scaffold.** Next.js 16 + Tailwind v4 + shadcn/ui, design tokens in
`app/globals.css`, Neon database provisioned, `db/index.ts` and `drizzle.config.ts` in place,
schema and migrations including the exclusion constraint.

## Not started

- **Phase 2 — Auth + house.** better-auth magic link, sign-up, create house, settings form.
- **Phase 3 — Images.** Upload route, upload component, gallery strip, `next/image` config.
- **Phase 4 — Guest page.** Availability calculation, calendar, request sheet, pending state.
- **Phase 5 — Approve/decline.** Owner dashboard, overlap error path, emails, per-booking ICS.
- **Phase 6 — Google Calendar.** `.ics` subscribe feed for real; OAuth and event sync written
  and unit-tested against a mock, never run against live Google. Ends with `SETUP-GOOGLE.md`.
- **Phase 7 — Guide.** Section editor, places, visibility toggles, prompt builder, paste-back parser.
- **Phase 8 — Polish.** Reminders cron, i18n dictionaries, empty states, deploy.

## Needs you

1. **Google OAuth client id and secret.** The consent screen isn't reliably scriptable, so the
   integration ships as code plus a `SETUP-GOOGLE.md` with the exact console steps. Follow it
   when phase 6 lands, then put the values in `.env.local`. Until then phase 6 is code-complete
   but never once run against real Google.
2. **One live round-trip of the guide prompt.** Copy the generated prompt into ChatGPT or
   Claude, paste the answer back, and confirm the parser handles it — including a deliberately
   malformed line. Overnight this is verified against a hand-written fixture only.
3. **Decide whether to keep the working name "Yazlık".** The slug is easy to change now and
   annoying to change after deploy. See `DECISIONS.md`.

## Commands

```bash
cd /home/ozi/Projects/yazlik
pnpm install
pnpm test         # Vitest — availability, guide parser, ICS builder
pnpm typecheck    # tsc --noEmit
pnpm lint
pnpm db:push      # apply schema to Neon
pnpm db:seed      # one owner, one house, three bookings in a known August
pnpm dev          # http://localhost:3000
git log --oneline # one commit per phase, no remote
```

Nothing has been deployed or pushed. `RESEND_API_KEY` is empty on purpose — emails print to
the `pnpm dev` terminal rather than sending.
