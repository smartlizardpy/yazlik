# Yazlık

Booking links for a private summer house. The owner sets the rules once and shares one link; guests request date ranges from their phone and the owner approves or declines in a tap. No money changes hands — this is for family and friends, not renters.

Working title. See `DECISIONS.md` if you want to rename it.

## Stack

- Next.js 16 (App Router, Server Components, Server Actions) + TypeScript strict
- Tailwind CSS v4 (CSS-first config in `app/globals.css`, no `tailwind.config.ts`) + shadcn/ui
- Neon Postgres + Drizzle ORM + postgres.js
- better-auth, magic link only, owners only — guests never sign in
- Resend for email (console fallback in dev); images on Vercel Blob or local disk
- Google Calendar one-way sync via `googleapis` — phase 6, needs your credentials
- zod v4, date-fns, Vitest, Playwright
- No AI API, no Google Places/Maps/geocoding, no payments

## Run it locally

```bash
pnpm install
pnpm dev     # http://localhost:3000
pnpm test    # Vitest
```

### Environment

`.env.local` already exists with working values for local development. `.env.example` lists
every key with a comment.

| Key | Status |
| --- | --- |
| `DATABASE_URL` | Provisioned. Points at a Neon project called **yazlik**. Nothing to do. |
| `BETTER_AUTH_SECRET` | Generated locally. Fine as is. |
| `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL` | `http://localhost:3000`. |
| `CRON_SECRET` | Generated locally. Guards `/api/cron/reminders`. |
| `STORAGE_DRIVER` | `local` — images write to disk. Set to `blob` plus `BLOB_READ_WRITE_TOKEN` for Vercel Blob. |
| `RESEND_API_KEY` | Intentionally empty. Emails print to the terminal instead of sending. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Empty. Phase 6 only — see `SETUP-GOOGLE.md` when it lands. |

### Database

```bash
pnpm db:push      # apply schema to Neon
pnpm db:seed      # one owner, one house, three bookings in a known August
pnpm db:studio    # browse the data
```

Double-booking is prevented by a Postgres exclusion constraint on `bookings`, not by
application code. It lives in a hand-written migration alongside the generated ones, because
Drizzle won't produce it.

### Other commands

```bash
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint
pnpm build        # production build
```

## Where to look next

- `HANDOFF.md` — current status, what's blocked on you, what to run to check the work.
- `DECISIONS.md` — calls made without you, and how to reverse each one.

## Legal pages

`/legal/privacy`, `/legal/terms` and `/legal/contact`. They are short on
purpose, and the privacy page is written from what the code actually does
rather than from a template — every claim in it is checkable against a file.

`app/legal/legal.test.ts` asserts the claims still hold. The page says there is
no analytics and no tracking, which is true only while no package does it, so
the test runs against the dependency list: adding `@vercel/analytics`, PostHog
or Stripe fails the suite. That is the moment to change the page, rather than
six months later.

They are the only guest-facing routes that are **indexable**. A house link is
noindex because it is private; these exist to be found and name nobody.
