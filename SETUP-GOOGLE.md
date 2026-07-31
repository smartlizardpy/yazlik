# Connecting the house to Google Calendar

You only do this once. Set aside twenty minutes on a morning when nobody needs
anything from you, because two of the steps involve waiting for Google and one of
them involves reading a warning screen carefully rather than clicking past it.

At the end of it, two lines will exist in `.env.local`:

```
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
```

and the app will offer a **Continue with Google** button on the sign-in screen and
a **Connect** button in Settings. Until those two lines exist, the app runs exactly
as it does now — no button, no error, nothing broken. Nothing here is urgent.

Read [The seven-day thing](#the-seven-day-thing) before you start. It is the one
step people skip and then spend a week confused by.

---

## Before you start

You need:

- A Google account. The one whose calendar you want the house to appear in. If
  the house is a family thing and the calendar should be shared, use the account
  that will still exist in five years, not a work account you might lose.
- The app running locally, or a URL where it is deployed.
- Ten minutes of patience with a console that changes its own layout roughly once
  a year. The screenshots in your head from last time are probably wrong; the
  names of the things are what matter, and those are stable.

---

## 1. Make a project

1. Go to <https://console.cloud.google.com>.
2. Sign in with the account from above.
3. At the top of the page there is a project picker — it either says **Select a
   project** or the name of a project you made once and forgot. Click it, then
   **New project**.
4. **Project name**: type `yazlik`. Nobody but you will ever see this.
5. Leave **Location** / **Organization** on whatever it offers. For a personal
   account this says *No organization* and that is correct.
6. Click **Create**, and wait. It takes about thirty seconds and a notification
   appears when it is done.
7. Make sure the project picker at the top now says **yazlik**. If it still shows
   the old project, click it and choose `yazlik`. Everything below applies to
   whichever project is selected up there, and doing step 3 in the wrong project
   is the most common way this goes quietly wrong.

---

## 2. Turn on the Calendar API

The project can talk to nothing until you say which API it may use.

1. In the search bar at the top, type `Google Calendar API` and pick it out of
   the results. (The long way round: hamburger menu → **APIs & Services** →
   **Library** → search.)
2. Click **Enable**.
3. Wait for the page to turn into the API's dashboard.

Skipping this step does not fail at sign-in. It fails much later, the first time
the app asks Google for your list of calendars, with an error that says the
Calendar API *"has not been used in project 123456789 before or it is disabled"*.
Do it now.

---

## 3. Set up the consent screen

This is the screen Google shows *you* when the app asks for access. In the current
console it lives under **Google Auth Platform** in the left menu. (If you land on
an older page called **OAuth consent screen**, it is the same thing and it will
redirect you.)

Direct link: <https://console.cloud.google.com/auth/overview>

If this is a brand-new project it will offer to walk you through it. Take the
walkthrough. The answers:

| Field | What to type |
|---|---|
| **App name** | `Yazlık` — this is the name you will read on the consent screen, so make it the one you will recognise |
| **User support email** | your own address, from the dropdown |
| **Audience** / **User type** | **External** |
| **Contact information** | your own address again |

**External** sounds wrong for a private family house and it is the right answer.
*Internal* is only available if you have a Google Workspace organisation, and it
would mean "anyone in my company". External plus a test-user list of exactly one
person is how a personal project is done.

Agree to the user data policy and finish. You should end up on a page with a left
menu containing **Overview**, **Branding**, **Audience**, **Clients**, **Data
Access**.

---

## 4. Add yourself as a test user

Left menu → **Audience**.

Near the bottom there is a **Test users** section. Click **Add users**, type the
Google address you will actually sign in with, press Enter, then **Save**.

Add every address that will ever sign in as an owner. Up to 100 are allowed, and
an address that is not on this list is refused at the consent screen with
`Error 403: access_denied` — which reads like the app rejected them, and is
actually this list.

### About the "Google hasn't verified this app" warning

Your publishing status is **Testing**, which means Google has not reviewed the
app — because you have not asked it to, because it is a private thing for one
family and there is nothing to review.

So the first time you sign in you may see a full-page warning: **Google hasn't
verified this app**. There is a small **Advanced** link at the bottom left. Click
it, then click **Go to Yazlık (unsafe)**.

This is the normal answer for a personal project, and the wording is aimed at
someone who arrived at an unfamiliar app from a link in an email — not at the
person who created the OAuth client eleven minutes ago. You are the developer and
the user and the reviewer. Click through it.

You will see it again each time you grant a new permission. That is expected.

---

## 5. Declare the scopes

Left menu → **Data Access** → **Add or remove scopes**.

A scope is one sentence of permission. The dialog offers a filtered list and a
box at the bottom labelled **Manually add scopes** — the box is easier. Paste
these **six**, one per line, then **Add to table** and **Update**, then **Save**:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/calendar.calendarlist.readonly
https://www.googleapis.com/auth/calendar.events.owned
https://www.googleapis.com/auth/calendar.app.created
```

**Every one of these must be in the table.** A scope the app asks for and this
screen does not declare is not refused — it is dropped, silently. The consent
screen appears, you press Allow, the callback succeeds, and the grant simply
lacks it. Nothing anywhere says why. If you skip one of the calendar three, that
is exactly the failure you get, and the app's own diagnosis of it is in the
server log — see [When it goes wrong](#when-it-goes-wrong), which prints the
missing scope strings verbatim.

The first three are how the app learns your name and email address at sign-in.
They are non-sensitive, and they are all the sign-in button ever asks for. Google
does not show a warning screen for those.

The last three are the calendar. They are asked for **separately**, later, from
Settings, by someone who has already decided they want it — so an owner who never
connects a calendar is never asked about one. In Google's own words:

| Scope | What Google says on the consent screen | Why the app needs it |
|---|---|---|
| `calendar.calendarlist.readonly` | *"See the list of Google calendars you're subscribed to"* | To offer you a list to choose from. The names and ids only — it reads nothing inside any calendar. |
| `calendar.events.owned` | *"See, create, change, and delete events on Google calendars you own"* | The actual work. Reads the weeks already promised out of the calendar you pick, and writes confirmed stays back into it. |
| `calendar.app.created` | *"Make secondary Google calendars, and see, create, change, and delete events on them"* | Only for **Make a calendar called …** — the option for an owner who does not want the summer mixed into the calendar they live by. |

Each is the narrowest scope Google publishes for the call that needs it. They
were checked per operation against the live Calendar v3 discovery document, not
from memory. The constants live in `lib/google/types.ts` as
`GOOGLE_CALENDAR_SCOPES`, and **that file is the authority if this document and
the code ever disagree.**

### Why not the one narrow scope this used to ask for

An earlier version of this app asked only for `calendar.app.created`, on the
argument that it reaches **only calendars the app itself created** and therefore
cannot see your personal calendar at all. That argument was true. The scope was
still wrong, and the reason is the whole point of the feature:

> *"Anything that may be in the calendar needs to be blocked… yk if they added
> like other people before yk doing it."*

The weeks that matter were promised to people **before this app existed**, and
they live in a calendar you already keep — one this app did not create and, under
that scope, could never see. It was also a dead end on screen: on a fresh
connect there are no app-created calendars, so the picker was empty, no calendar
was ever stored, and Settings reported *not connected* for ever with no way
forward.

`calendar.events.owned` is what fixes that, and it is meaningfully narrower than
the obvious alternatives:

- `https://www.googleapis.com/auth/calendar` — read, write, **share and delete**
  every calendar the account can reach. Not asked for.
- `https://www.googleapis.com/auth/calendar.events` — events on *all* your
  calendars, including ones merely **shared** with you: a partner's, a work one
  somebody added you to. Not asked for.
- `.../calendar.events.owned` — events on calendars **you own**, and nothing
  else. This one.

So: the app can see the *names* of your calendars, and read and write events on
the ones you own. It only ever touches the single calendar you pick. It cannot
reach a calendar somebody shared with you, cannot change any calendar's sharing
or settings, and cannot delete a calendar.

Google classifies `calendar.events.owned` as **sensitive**. In testing mode that
costs you nothing beyond the unverified-app warning you already clicked through
in step 4. Publishing to production one day would require verification — see
[The seven-day thing](#the-seven-day-thing).

### If you are upgrading an app that was already connected

**A widened scope is never granted retroactively.** If anyone has already
connected their calendar under the old single-scope build, Google will go on
handing back that same old grant for ever — the account stays linked, the tokens
keep refreshing, and the calendar silently cannot be read. Adding the scopes here
is necessary and is **not sufficient**.

Each owner has to consent again. The app detects this by itself: it compares the
scopes stored on the `account` row against what it now needs, and Settings shows
*"This needs more of your calendar than you gave it last time"* with an **Ask
Google again** button. One press, one consent screen, and it is done — nothing
they set up is lost and no database row has to be edited by hand.

There is nothing for you to do here beyond adding the three strings above and
telling them to open Settings.

---

## 6. Create the OAuth client

Left menu → **Clients** → **Create client**.
Direct link: <https://console.cloud.google.com/auth/clients>

| Field | What to type |
|---|---|
| **Application type** | **Web application** |
| **Name** | `yazlik local` — internal only, you will never see it again |
| **Authorized JavaScript origins** | leave empty |
| **Authorized redirect URIs** | see below |

JavaScript origins can stay empty because the app never talks to Google from the
browser. The browser is sent to Google, Google sends it back to the app, and the
app then talks to Google from the server. Adding an origin here is harmless and
does nothing.

### The redirect URI

Click **Add URI** under **Authorized redirect URIs** and paste this exactly:

```
http://localhost:3100/api/auth/callback/google
```

The rule, so you can work out any other one yourself:

> the value of `BETTER_AUTH_URL`, then `/api/auth/callback/google`

No trailing slash. It is matched character for character, including the port and
the scheme. `http` and `https` are different URIs; `localhost` and `127.0.0.1`
are different URIs; port `3000` and port `3100` are different URIs. This app runs
on **3100** (`pnpm dev` → `next dev --port 3100`).

When you deploy, come back here and add the deployed one alongside it:

```
https://yourhouse.example/api/auth/callback/google
```

One client can hold several redirect URIs. You do not need a second client for
production, and having both listed means local development keeps working after
you deploy.

### The LAN address, and why Google will not take it

The obvious next thing to add is the address you use to open the app on your
phone while the laptop runs it:

```
http://192.168.1.7:3100/api/auth/callback/google
```

**Google will refuse to save this.** Its published validation rules are that a
redirect URI must use `https`, and that the host cannot be a raw IP address —
with localhost, and only localhost, exempted from both. A private LAN address is
neither `https` nor localhost, so the console rejects it when you press Save,
complaining that it needs a public top-level domain.

There is no trick for this. Three honest options, in the order most people should
consider them:

1. **Sign in on the laptop, at `http://localhost:3100`.** Google works there. This
   is what you want ninety per cent of the time.
2. **On the phone, use the email link instead.** The sign-in screen keeps *Email
   me a link instead* underneath the Google button, and the magic link has no
   redirect-URI rule to satisfy — it works from any address the phone can reach,
   including the LAN one. This is exactly why that door is still there.
3. **Put an https address in front of it.** If you genuinely need the Google
   button on a phone before you deploy, run a tunnel (`cloudflared tunnel`,
   `ngrok http 3100`, whatever you already have), add the tunnel's https callback
   URL as a second redirect URI here, and set `BETTER_AUTH_URL` to the tunnel's
   origin. Remember to set it back afterwards.

### Take the two values

Press **Create**. A panel appears with **Client ID** and **Client secret**. Copy
both now — the secret can be retrieved later from the client's own page, but it
is easier to take it while it is on screen.

The client ID looks like `1234567890-abcdefghijk.apps.googleusercontent.com`.
The secret looks like `GOCSPX-…` and is about 35 characters.

---

## 7. Put them in `.env.local`

Open `.env.local` in the project root. The two keys are already there, empty,
under a comment about this document. Fill them in:

```
GOOGLE_CLIENT_ID=1234567890-abcdefghijk.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-secret-here
```

No quotes. No spaces around the `=`. Watch for a trailing space at the end of a
pasted line — the app treats blank and whitespace-only as *absent*, on purpose,
because a half-pasted secret is a likelier accident than a missing key, and a
Google button that leads nowhere is worse than no button at all.

While you are in there, check that `BETTER_AUTH_URL` matches the redirect URI you
registered:

```
BETTER_AUTH_URL=http://localhost:3100
```

Then **stop the dev server and start it again**. This is not optional and it is
not superstition: the auth config reads the credentials once when the module
loads, and the sign-in page is prerendered when Google is absent. A running server
will not notice the file changing. On a deployed app, the equivalent is a
redeploy, not just a change to the environment variables.

---

## 8. Check it worked

Five checks, in order. Each one tells you something different, so do them in
order and stop at the first that fails.

1. **The button exists.** Open <http://localhost:3100/sign-in>. There is now a
   black **Continue with Google** button, with *Email me a link instead*
   underneath it. If the screen still shows only the email field, the app cannot
   see your credentials: check for a trailing space, check you saved the file,
   check you actually restarted the server.

2. **Sign-in works.** Press it. You go to Google, choose your account, click
   through the unverified-app warning, and land back on `/app`. Google asks only
   for your name and email address at this point — if it asks about calendars
   here, something is asking for the wrong scope and you should stop and say so.

3. **Settings knows.** Open **Settings**. The Google section no longer says
   calendar sync is not set up on this install; it offers a **Connect** button
   and explains what it will touch. Nothing has been connected yet.

4. **The connect works.** Press **Connect Google Calendar**. This is the real
   test — see below. You go to Google, read three calendar permissions, allow
   them, and land back on Settings. It should now be asking **which** calendar
   the house lives in, with your own calendars in a picker and **Make a calendar
   called …** underneath.

   If it instead still offers **Connect**, or says it needs more of your calendar
   than you gave it, the grant came back short — go back to step 5 and check all
   six scope strings are in the table.

5. **A calendar is chosen.** Pick one, or make a new one. Either way Settings
   should then read *"Stays are going to …"*. **This is the state that means it
   worked.** Until a calendar is chosen nothing syncs, and until this line appears
   the house is not connected in any sense that matters.

If you get sent back to `/sign-in` with a sentence about Google not finishing,
that is the app catching a failed round trip and telling you in words. The
[troubleshooting table](#when-it-goes-wrong) has the specific causes.

---

## The seven-day thing

Read this even if everything is working. **Especially** if everything is working.

Google's rule, in its own words:

> A Google Cloud Platform project with an OAuth consent screen configured for an
> external user type and a publishing status of "Testing" is issued a refresh
> token expiring in 7 days, unless the only OAuth scopes requested are a subset of
> name, email address, and user profile.

Read that twice. Signing in is fine forever — name, email and profile are exactly
the exempted set. But the moment you connect a **calendar**, the app is asking for
more than that, and the token that keeps the connection alive without you present
starts expiring after seven days.

What that looks like in practice: you connect the calendar, stays appear on it
perfectly, you tell everyone it works, and then about a week later stays stop
appearing and Settings starts reporting failures. Nothing changed. Nothing broke.
The token expired on schedule.

**The fix**, and it takes one click: **Google Auth Platform** → **Audience** →
**Publish app**.

Publishing an app that requests a **sensitive** scope — and
`calendar.events.owned` is one — puts you in front of Google's verification
review: a demo video, a privacy policy on a domain you control, and a wait
measured in weeks. That is a real cost for one family's summer house, and it is
worth knowing about **before** you rely on this rather than a week after.

The three ways out, in the order most people should consider them:

1. **Keep the app in Testing and reconnect every seven days.** One press of
   **Ask Google again** in Settings. Ugly, free, and completely reliable if
   somebody remembers.
2. **Use an Internal app instead**, if the Google account is on a Workspace
   domain you control. Audience → **Internal** exempts you from verification
   entirely. It is not available on a personal `@gmail.com` account.
3. **Go through verification.** The right answer if this is going to run for
   years, and the wrong one to start with.

Note that dropping back to `calendar.app.created` alone is *not* on that list any
more. It was the old advice and it does not survive the requirement: a calendar
the app did not create cannot be read on that scope, and reading the weeks
already promised in a calendar you already keep is the entire point. See
[Why not the one narrow scope this used to ask for](#why-not-the-one-narrow-scope-this-used-to-ask-for).

Do this before you rely on it, not after somebody's August disappears from the
calendar.

---

## None of this has ever run against real Google

Worth saying plainly, because it changes what you should be watching for.

Everything under `lib/google/` — the client, the error mapping, the scopes, the
event bodies — was written and unit-tested against a fake (`lib/google/fake.ts`)
while there were no credentials on this machine to run it with. Every failure
path was exercised with hand-written fixtures shaped like Google's. But no line
of it has ever made a real request. The tests pass and prove only that the code
does what its author believed Google does.

Two things *were* checked against Google rather than against belief, because
getting them wrong is only discovered while an owner is standing in front of the
consent screen: the six scope strings, and which of them each API call accepts.
Both came from the **live** Calendar v3 discovery document
(<https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest>) and Google's
published auth guide. `calendarList.list` accepts
`calendar.calendarlist.readonly`; `events.list`, `events.insert`, `events.patch`
and `events.delete` all accept `calendar.events.owned`; `calendars.insert`
accepts `calendar.app.created`. Nothing the app calls needs a scope it does not
ask for, and nothing it asks for goes unused.

So the first live connect is the test. Here is what to watch, in the order you
will meet it.

### 1. The consent screen itself

Read what it actually says before you click Allow. It should list **three**
calendar permissions, worded close to:

- *See the list of Google calendars you're subscribed to*
- *See, create, change, and delete events on Google calendars you own*
- *Make secondary Google calendars, and see, create, change, and delete events on
  them*

Two things to check, and they fail in opposite directions:

- **Fewer than three.** A scope you did not declare in step 5 is dropped
  silently. Google will not mention it. Go back and add the missing string, then
  connect again — Settings will tell you it needs more than you gave it.
- **Something about seeing and editing *all* your calendars**, or sharing or
  deleting them. That is `.../auth/calendar`, which this app does not ask for.
  Stop, and check step 5 — something is requesting a wider scope than intended.

Note that Google collapses these into friendlier groupings on some screens, so
the wording may not match line for line. What must be true is that it mentions
your calendar **list** and events on calendars **you own**, and does not claim
access to every calendar you can reach.

### 2. Whether a refresh token arrived

This is the one that fails silently, and it fails an hour later rather than
immediately.

The app is configured with `accessType: "offline"` and `prompt: "consent"`, which
together are what make Google send a refresh token. That combination is correct
as written and has never been observed working. After connecting, look at the
`account` row for your user in the database: `refresh_token` must not be null.

If it is null, sync will appear to work for about an hour and then stop forever,
with nothing in the logs to explain it. Disconnect and connect again; if it is
still null, that is the bug and it is worth reporting properly.

(Tokens are stored in better-auth's own `account` table in plain text —
`encryptOAuthTokens` is off. Worth knowing before you point a database viewer at
it on a shared screen.)

### 3. Whether the Calendar API is actually on

The very first thing a connect does is ask Google for the list of your calendars.
If step 2 was skipped, Google answers 403 with `accessNotConfigured`, and — this
is the trap — the app classifies 403 as an authentication failure and will tell
you to reconnect. Reconnecting cannot fix it. If a fresh connect fails
immediately and the server log mentions `accessNotConfigured` or
`SERVICE_DISABLED`, go and enable the Calendar API.

You will see this as a **Google is busy / did not answer properly** line beside
the picker rather than as a broken screen: the app deliberately keeps **Make a
calendar called …** on offer even when the list fails, because that offer can
still work. It will not work in this particular case, since the same disabled API
blocks it — but the failure is named in the server log either way.

### 4. The dates, on the very first stay

This is the classic way an all-day calendar integration goes wrong, and the code
takes a deliberate position on it: a stay's end date is exclusive in this app and
`end.date` is exclusive in Google, so the two are sent to Google unchanged with no
±1 adjustment anywhere.

Approve one stay and then look at it in Google Calendar. A stay of **1 August to
8 August** is seven nights. In Google it must appear as **1–7 August inclusive**,
with the 8th free for the next arrival. If it runs to the 8th, or starts on the
31st of July, there is an off-by-one and it will be in the conversion, not in
your data.

### 5. That the event does not black out your week

Events are written as *transparent* — showing as **Free**, not **Busy**. That is
on purpose: a week at the house should not black out a week of somebody's working
calendar. If you expected it to block, that is a setting, not a fault.

### 6. The server log, on the first failure of any kind

The error mapper is the least-tested part of the whole thing, because every fault
it has ever seen was one somebody typed. The specific thing to look at: a dead or
revoked token arrives from Google's *token* endpoint as **HTTP 400** with
`{"error": "invalid_grant"}` — not as a 401. The mapper reads the reason before
the status precisely to catch that.

If you ever see a logged `GoogleCalendarError` with `kind: "other"` that is really
an expired grant, that is the failure worth reporting: it means the app will
retry a dead token on every pass forever and never tell you to reconnect.

---

## When it goes wrong

| What you see | What it is | What to do |
|---|---|---|
| `Error 400: redirect_uri_mismatch` | The URI in the console is not exactly the one the app sent | Compare character by character with `BETTER_AUTH_URL` + `/api/auth/callback/google`. Usually a port, a trailing slash, or `http` vs `https` |
| `Access blocked: This app's request is invalid` | Almost always the same thing — click **Error details** to confirm | As above |
| `Error 403: access_denied`, or "not completed the verification process" | Your address is not on the test-user list | Step 4 |
| Back on `/sign-in`, "Nothing was shared, so nothing happened" | You pressed Cancel on the consent screen | Nothing is wrong. Press it again |
| Back on `/sign-in`, "that Google account uses a different email" | You signed in with a Google account whose address is not the one this house already knows | Use the other account, or sign in by email link and connect Google from there |
| `invalid_client` | Wrong client secret, or whitespace around it | Re-copy from the console. Restart the server |
| `invalid_grant`, and it used to work | The refresh token died — usually [the seven-day thing](#the-seven-day-thing), sometimes a revoked grant | Publish the app. Then disconnect and connect again |
| "Google Calendar API has not been used in project … before or it is disabled" | Step 2 | Enable the Calendar API. It can take a couple of minutes to take effect |
| `Request had insufficient authentication scopes` | The calendar permission was not actually granted, or was granted before you added the scope | Open Settings and press **Ask Google again**. Read the consent screen this time |
| Settings says *"This needs more of your calendar than you gave it last time"* | Working as designed. The stored grant predates the scopes the app now asks for | Press **Ask Google again**. Nothing is lost and no database row needs editing |
| That message again, immediately after consenting | The scope is missing from **Data Access** in the console, so Google dropped it silently | The server log prints `[google] the stored grant is missing scopes:` followed by the exact strings. Paste them into step 5 |
| Settings sits on *"Pick the calendar the house should live on"* with an empty list | Google answered and you own no calendar it can use — rare, but not an error | Press **Make a calendar called …**. That path needs no list |
| No Google button at all on `/sign-in` | The app cannot see the credentials | Trailing whitespace, unsaved file, or a server that was not restarted |

### Starting over

You can revoke everything from your own account at
<https://myaccount.google.com/permissions> — find the app, remove access. The next
connect starts from a clean consent. This is also the honest way to check what you
actually granted, as opposed to what you think you granted.

Deleting the OAuth client in the console invalidates the credentials immediately;
make a new one and repeat step 7.

---

## What this never does

Worth having written down somewhere, for the next time somebody asks.

- It never reads a calendar other than the one you picked. The grant it holds
  could read any calendar you own — that is the honest version, and it is the
  price of reading the weeks you promised people before this app existed — but
  the code only ever names one calendar id, the one on your house.
- It never touches a calendar somebody **shared** with you. It cannot: the scope
  is `calendar.events.owned`, and the picker asks Google for calendars you own.
- It never renames, re-shares or deletes a calendar. No scope it holds allows it.
- It never deletes anything from Google when you press **Disconnect**. The events
  describe real weeks; the app forgets the calendar and leaves it exactly as it
  is.
- It never emails your guests from Google. Every calendar write is made with
  notifications switched off, on purpose — the guest's invitation is the `.ics`
  file on their confirmation email, and that stays the only one.
- It never puts a guest's email address on a Google event as an attendee.
- It never blocks your working day: events are written as Free.
- No Maps, no Places, no geocoding, no billing. The only Google API this project
  will ever ask for is the Calendar one you enabled in step 2, and that API has a
  free quota far larger than a house with one summer in it will ever use.
