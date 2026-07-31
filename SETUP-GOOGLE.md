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
the app tries to make a calendar, with an error that says the Calendar API *"has
not been used in project 123456789 before or it is disabled"*. Do it now.

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
these, one per line, then **Add to table** and **Update**, then **Save**:

```
openid
https://www.googleapis.com/auth/userinfo.email
https://www.googleapis.com/auth/userinfo.profile
https://www.googleapis.com/auth/calendar.app.created
```

The first three are how the app learns your name and email address at sign-in.
They are non-sensitive, and they are all the sign-in button ever asks for. Google
does not show a scary screen for those.

The fourth is the calendar one, and it is deliberately the narrowest scope Google
publishes for this job. In Google's own words it lets an app *"make secondary
Google calendars, and see, create, change, and delete events on them."* The
important half is what it leaves out: it grants access **only to calendars this
app itself created**. It cannot read your personal calendar, your work calendar,
or anything you subscribe to. It is a room, not a key to the building. The
constant lives at `CALENDAR_APP_CREATED_SCOPE` in `lib/google/types.ts`, and that
file is the authority if this document and the code ever disagree.

The calendar scope is **not** requested at sign-in. It is asked for separately,
later, from Settings, by someone who has already decided they want it — so an
owner who never connects a calendar is never asked about one.

### If you want to use a calendar you already keep

`calendar.app.created` cannot see calendars it did not create. If Settings offers
you the choice of pointing the house at a calendar that already exists — the
family one, the one already shared with your cousins — that choice needs a wider
scope than the one above:

```
https://www.googleapis.com/auth/calendar
```

That one is read and write on **every** calendar the account can reach, which is a
genuinely bigger thing to hand over, and Google classifies it as sensitive: you
will see the unverified-app warning for it, and publishing the app to production
one day would require verification.

If you are happy to let the app make its own calendar — which you can then share
with anyone, from Google's own interface — leave it out and take the narrow scope.
That is the recommended path and it is the one the code was written for.

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

Four checks, in order. Each one tells you something different, so do them in
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

4. **The connect works.** Press **Connect**. This is the real test — see below.

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

- If the app only uses the narrow `calendar.app.created` scope, this should go
  through immediately.
- If you added the wide `.../auth/calendar` scope, the console will tell you
  verification is required. For a private family house that is a real cost, and it
  is the strongest argument for staying on the narrow scope and letting the app
  make its own calendar.

Do this before you rely on it, not after somebody's August disappears from the
calendar.

---

## None of this has ever run against real Google

Worth saying plainly, because it changes what you should be watching for.

Everything under `lib/google/` — the client, the error mapping, the scope
constant, the event bodies — was written and unit-tested against a fake
(`lib/google/fake.ts`) while there were no credentials on this machine to run it
with. Every call signature was checked against the discovery document vendored in
`googleapis`, and every failure path was exercised with hand-written fixtures
shaped like Google's. But no line of it has ever made a real request. The tests
pass and prove only that the code does what its author believed Google does.

So the first live connect is the test. Here is what to watch, in the order you
will meet it.

### 1. The consent screen itself

Read what it actually says before you click Allow. It should name one calendar
permission and describe it as making and managing calendars the app creates. If
it says something about seeing and editing **all** your calendars, the app asked
for a wider scope than intended — stop, and check step 5.

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

The very first thing a connect does is ask Google to make a calendar. If step 2
was skipped, Google answers 403 with `accessNotConfigured`, and — this is the
trap — the app classifies 403 as an authentication failure and will tell you to
reconnect. Reconnecting cannot fix it. If a fresh connect fails immediately and
the server log mentions `accessNotConfigured` or `SERVICE_DISABLED`, go and
enable the Calendar API.

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
| `Request had insufficient authentication scopes` | The calendar permission was not actually granted, or was granted before you added the scope | Disconnect in Settings, then connect again and read the consent screen |
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

- It never reads your personal calendar, on the narrow scope. It cannot.
- It never emails your guests from Google. Every calendar write is made with
  notifications switched off, on purpose — the guest's invitation is the `.ics`
  file on their confirmation email, and that stays the only one.
- It never puts a guest's email address on a Google event as an attendee.
- It never blocks your working day: events are written as Free.
- No Maps, no Places, no geocoding, no billing. The only Google API this project
  will ever ask for is the Calendar one you enabled in step 2, and that API has a
  free quota far larger than a house with one summer in it will ever use.
