# Handoff

_Last updated: 2026-07-30, end of phase 3._

## Where things stand

Three of eight phases are committed, each one verified against the running app rather than just
the compiler. An owner can sign in with a magic link, create a house, set its booking rules, and
upload photos. **The guest side does not exist yet** — phase 4 is building `/h/[slug]` now, so
there is nothing to share with anyone until it lands.

Nothing is blocked. The two items that need you (Google credentials, one live model round-trip
of the guide prompt) belong to phases 6 and 7 and were always going to wait for morning.

## Done

**Phase 1 — Scaffold.** Next.js 16 + Tailwind v4 + shadcn/ui, neutral design tokens, Neon
project `yazlik`, the five-table Drizzle schema, and `lib/availability.ts` with 54 tests.
The double-booking exclusion constraint is live and was verified against the real database:
overlapping confirmed bookings are rejected, a same-day changeover is allowed, and two
overlapping *pending* requests both insert so you can choose between them.

**Phase 2 — Auth + house.** better-auth magic link (no passwords anywhere), `lib/session.ts` as
the only route into auth, onboarding, and the settings screen. Verified end to end: request
link → verify → session → dashboard rendering seeded data, plus signed-out redirects.

**Phase 3 — Images.** One storage interface with `local` and `blob` drivers, an upload endpoint
that authorises before it writes, a path-traversal guard that is unit tested, and the photo
strip. Verified with a real PNG: identical bytes on disk, `next/image` optimises the local file
to webp, delete removes both row and file.

## In progress

**Phase 4 — Guest page.** `/h/[slug]`, the stay calendar, the request sheet, and `/b/[token]`.

## Not started

- **Phase 5 — Approve/decline.** Owner dashboard actions, the overlap error path, the five
  emails, per-booking ICS.
- **Phase 6 — Google Calendar.** `.ics` subscribe feed for real; OAuth and event sync written
  and unit-tested against a mock, never run against live Google. Ends with `SETUP-GOOGLE.md`.
- **Phase 7 — Guide.** Section editor, places, visibility toggles, prompt builder, paste-back parser.
- **Phase 8 — Polish.** Reminders cron, empty states, final pass. No deploy.

## Needs you

1. **Google OAuth client id and secret.** The consent screen isn't reliably scriptable, so the
   integration ships as code plus a `SETUP-GOOGLE.md` with the exact console steps. Until then
   phase 6 is code-complete but never once run against real Google.
2. **One live round-trip of the guide prompt.** Copy the generated prompt into ChatGPT or
   Claude, paste the answer back, confirm the parser handles it — including a deliberately
   malformed line. Overnight this is verified against a hand-written fixture only.
3. **Decide whether to keep the working name "Yazlık".** Easy to change now, annoying after deploy.
4. **Vercel Blob is not provisioned.** Provisioning creates billable resources in your account,
   which isn't a call to make while you're asleep. Images write to `.uploads/` on local disk
   instead. To switch: create the store, then set `STORAGE_DRIVER=blob` and
   `BLOB_READ_WRITE_TOKEN` in `.env.local`. Existing local photos won't migrate themselves.
5. **Port 3000 is held on this machine** by `mcp-excalidraw-local`, so the dev server is pinned
   to **3100** and `BETTER_AUTH_URL` matches it. Next's silent fallback to 3001 was breaking
   sign-out. If you free 3000, change both together or not at all.

## Commands

```bash
cd /home/ozi/Projects/yazlik
pnpm install
pnpm test         # Vitest — 85 tests: availability rules, storage, traversal guard
pnpm typecheck
pnpm lint
pnpm db:push      # schema to Neon, then the exclusion constraint
pnpm db:seed      # one owner, one house, three bookings across August 2026
pnpm dev          # http://localhost:3100  (NOT 3000)
git log --oneline # one commit per phase, no remote
```

Sign in as `owner@example.com`. With no `RESEND_API_KEY` the magic link is **printed to the
`pnpm dev` terminal** instead of emailed — that is intended, not broken.

Nothing has been deployed or pushed anywhere.
