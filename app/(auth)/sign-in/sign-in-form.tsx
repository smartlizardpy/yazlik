"use client";

import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { signIn, signInWithGoogle } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Two doors, and one of them is much wider than the other.
 *
 * Google is the whole screen's answer when it is configured: one tap, no
 * typing, no waiting for an email on a phone that may not have the account set
 * up. The magic link stays underneath as a quiet second door — it is the only
 * way in that cannot be taken away by a Google outage, a wrong account, or a
 * consent screen somebody cancelled, and until Google is proven on this
 * deployment it is also the door the owner already has a key to.
 *
 * When Google is **not** configured — which is every deployment until the OAuth
 * client exists — none of it renders and this is the same one-field screen it
 * has always been. `googleEnabled` is decided on the server and passed in;
 * asking `process.env` from a client component would answer for the browser,
 * not the deployment.
 *
 * Three states — idle, sending, sent — and the sent state replaces the form
 * entirely. A toast would slide away while the person is still looking for the
 * answer to "did that work, and where did it go?".
 */
type Status = "idle" | "sending" | "sent";

const emailSchema = z.email();

/** better-auth returns better-fetch's error object, not a thrown exception. */
type SignInError = { status?: number; message?: string };

function messageFor(error: SignInError): string {
  if (error.status === 429) {
    return "That's a lot of links in a short time. Wait a minute, then ask for another.";
  }
  if (error.status === 403) {
    return "That address can't sign in. Check it, or use the one you signed up with.";
  }
  if (error.message) return error.message;
  return "The link didn't send. Try again in a moment.";
}

/**
 * What to say about a Google round trip that came back without a session.
 *
 * These arrive as `?error=…` on the URL, because the failure happens on a
 * server-to-server hop this page never sees — see `signInWithGoogle`, which
 * sends the person back here rather than to better-auth's own error page. The
 * codes are better-auth's, verbatim.
 *
 * Only two are worth their own sentence. `access_denied` is somebody tapping
 * "Cancel" on the consent screen, which is not an error and should not be
 * scolded. `account_not_linked` is the one that would otherwise be baffling: a
 * Google account whose address is not the address this house already knows —
 * usually a personal account when the house was set up with a work one. The
 * rest share a line, because the difference between `invalid_code` and
 * `no_code` is nothing a person can act on.
 */
function googleMessageFor(code: string): string {
  if (code === "access_denied") {
    return "Nothing was shared, so nothing happened. You can try Google again, or ask for a link.";
  }
  if (code === "account_not_linked") {
    return "That Google account uses a different email from the one this house knows. Try the other account, or ask for a link.";
  }
  return "Google didn't finish signing you in. Try again, or ask for a link.";
}

/**
 * Google's mark, drawn inline rather than fetched or installed.
 *
 * The four colours are the point: this is somebody else's logo, and it is the
 * one thing on any screen in this product allowed to carry a hue that isn't a
 * photograph. Recolouring it to ink would look tidier here and would be a
 * misuse of the mark.
 *
 * `size-5` is not decoration — `Button` forces any unclassed `svg` to 16px, and
 * at 16 the "G" reads as a smudge next to 16px text.
 */
function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false" className="size-5">
      <path
        fill="#4285F4"
        d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.54-1.8368.859-3.0477.859-2.344 0-4.3282-1.5831-5.036-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71c-.18-.54-.2822-1.1168-.2822-1.71s.1023-1.17.2823-1.71V4.9582H.9573A8.9965 8.9965 0 0 0 0 9c0 1.4523.3477 2.8268.9573 4.0418L3.964 10.71z"
      />
      <path
        fill="#EA4335"
        d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.426 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.964 7.29C4.6718 5.1627 6.656 3.5795 9 3.5795z"
      />
    </svg>
  );
}

export function SignInForm({
  showDevNote,
  googleEnabled,
  googleErrorCode,
}: {
  showDevNote: boolean;
  googleEnabled: boolean;
  /**
   * better-auth's `?error=…` from a Google round trip that came back without a
   * session, read on the server by the page. It has to arrive as a prop: the
   * failure happens on a server-to-server hop, so the first render on this
   * machine is the one that has to know about it, and a client component that
   * discovered it afterwards would either hydrate against different HTML or
   * flash the wrong screen first.
   */
  googleErrorCode: string | null;
}) {
  const emailId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const sentHeadingRef = useRef<HTMLHeadingElement>(null);

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");

  // With no Google button there is nothing to reveal: the form is the screen.
  // And somebody who has just been turned away by Google needs the other door
  // already open, not one more thing to tap.
  const [showEmail, setShowEmail] = useState(!googleEnabled || googleErrorCode !== null);
  const [leaving, setLeaving] = useState(false);
  const [googleError, setGoogleError] = useState<string | null>(
    googleErrorCode === null ? null : googleMessageFor(googleErrorCode),
  );

  // The panel swaps under the reader, so move focus with it. Coming back to fix
  // a typo lands in the field with the address still there, ready to edit.
  useEffect(() => {
    if (status === "sent") sentHeadingRef.current?.focus();
  }, [status]);

  // The failure has been read and said out loud, so take it off the address
  // bar. A reload that repeated the accusation would be the app blaming
  // somebody twice for one cancelled consent screen, and `?error=access_denied`
  // is not something anyone should be able to bookmark or forward.
  //
  // Only the URL is touched here — no state, so no cascading render. The
  // message on screen came from the render above and stays put.
  useEffect(() => {
    if (googleErrorCode === null) return;
    const params = new URLSearchParams(window.location.search);
    params.delete("error");
    params.delete("error_description");
    const rest = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}`,
    );
  }, [googleErrorCode]);

  async function handleGoogle() {
    if (leaving) return;
    setGoogleError(null);
    setLeaving(true);

    try {
      const { error: socialError } = await signInWithGoogle();
      if (socialError) {
        setLeaving(false);
        setGoogleError("Google couldn't be reached. Try again, or ask for a link.");
        return;
      }
      // No `setLeaving(false)` on success: the browser is already on its way to
      // Google, and putting the button back would only invite a second tap at
      // the exact moment the page is being torn down.
    } catch {
      setLeaving(false);
      setGoogleError("We couldn't reach the server. Check your connection and try again.");
    }
  }

  function revealEmail() {
    setShowEmail(true);
    // Defer to after the field exists. They asked for it; land in it.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (status === "sending") return;

    const address = email.trim();
    // `noValidate` on the form: the browser's own bubble says the wrong thing in
    // the wrong voice and vanishes on the next click.
    if (address.length === 0) {
      setError("Enter the email you want the link sent to.");
      inputRef.current?.focus();
      return;
    }
    if (!emailSchema.safeParse(address).success) {
      setError("That doesn't look like an email address. Check it and try again.");
      inputRef.current?.focus();
      return;
    }

    setError(null);
    setStatus("sending");

    try {
      const { error: sendError } = await signIn.magicLink({
        email: address,
        callbackURL: "/app",
      });
      if (sendError) {
        setStatus("idle");
        setError(messageFor(sendError));
        return;
      }
      setSentTo(address);
      setStatus("sent");
    } catch {
      setStatus("idle");
      setError("We couldn't reach the server. Check your connection and try again.");
    }
  }

  const devNote = showDevNote ? (
    <p className="text-xs text-muted-foreground">
      Development: the link is printed in the terminal running the app instead of
      being emailed.
    </p>
  ) : null;

  if (status === "sent") {
    return (
      <div className="flex flex-1 flex-col">
        <h1
          ref={sentHeadingRef}
          tabIndex={-1}
          className="pt-14 text-2xl text-balance outline-none"
        >
          Check your email.
        </h1>
        <p className="pt-6 text-base text-pretty text-muted-foreground">
          The sign-in link is on its way to{" "}
          <span className="font-medium text-foreground break-all">{sentTo}</span>
          . Open it on this phone and you&rsquo;re in. It works once and expires
          in an hour.
        </p>

        {/* Bottom-anchored like the form it replaced, so the panel can swap
            under the reader without the shape of the page changing. The way
            out of here is opening the email, not this button — it is the
            fallback for a typo, so it stays an outline and the eye is not
            asked to treat it as the next step. */}
        <div className="mt-auto flex flex-col gap-4 pt-12">
          <Button
            type="button"
            variant="outline"
            className="h-12 w-full text-base"
            onClick={() => {
              setStatus("idle");
              setError(null);
              // Defer to after the form is back on screen.
              requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            Use a different email
          </Button>

          {devNote}
        </div>
      </div>
    );
  }

  const sending = status === "sending";

  return (
    <div className="flex flex-1 flex-col">
      {/* "Sign in" was a label sitting where every other screen in this product
          opens with something a person would actually say — and at
          `text-lg font-semibold` it was a weight Fraunces is never asked for
          anywhere else. */}
      <h1 className="pt-14 text-2xl text-balance">Come in.</h1>
      <p className="pt-6 text-base text-pretty text-muted-foreground">
        {googleEnabled ? (
          <>
            Google tells us your name and your email address, and nothing else.
            There&rsquo;s no password to remember.
          </>
        ) : (
          <>
            Tell us where to send the link, and it will sign you in.
            There&rsquo;s no password to remember.
          </>
        )}
      </p>

      {/* The one thing to do on this screen, held at the bottom of the glass:
          the button lands under the same thumb that just pressed "Sign in" on
          `/`, at the same distance from the same edge. */}
      <div className="mt-auto flex flex-col gap-4 pt-12">
        {googleEnabled ? (
          <div className="flex flex-col gap-3">
            <Button
              type="button"
              onClick={handleGoogle}
              disabled={leaving}
              className="h-12 w-full gap-3 text-base"
            >
              <GoogleMark />
              {leaving ? "Taking you to Google…" : "Continue with Google"}
            </Button>

            {googleError ? (
              <p role="alert" className="text-sm text-pretty text-destructive">
                {googleError}
              </p>
            ) : null}

            {/* Quiet on purpose, and quiet in the way the rest of the product is
                quiet — the same grey underlined ghost the guest page uses to
                offer cancelling. It is a second door, not a second choice. */}
            {showEmail ? null : (
              <Button
                type="button"
                variant="ghost"
                onClick={revealEmail}
                className="h-11 w-full text-sm font-normal text-muted-foreground underline underline-offset-4 hover:bg-transparent hover:text-foreground"
              >
                Email me a link instead
              </Button>
            )}
          </div>
        ) : null}

        {showEmail ? (
          <>
            <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor={emailId}>Email</Label>
                <Input
                  id={emailId}
                  ref={inputRef}
                  type="email"
                  name="email"
                  value={email}
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (error) setError(null);
                  }}
                  placeholder="you@example.com"
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={sending}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? errorId : undefined}
                  className="h-11 text-base"
                />
                {error ? (
                  <p id={errorId} role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>

              {/* Ink when it is the only way in. Outline when Google is above
                  it, because two solid buttons stacked is two primary actions
                  and the eye has to pick one. */}
              <Button
                type="submit"
                variant={googleEnabled ? "outline" : "default"}
                disabled={sending}
                className="h-12 w-full text-base"
              >
                {sending ? "Sending the link…" : "Email me a link"}
              </Button>
            </form>

            {/* The `/` side of this pair carries a quiet grey line under its
                button too. Here it answers the question that arrives a second
                after the link does. */}
            <p className="text-sm text-pretty text-muted-foreground">
              The link works once, and only for an hour.
            </p>
          </>
        ) : null}

        {devNote}
      </div>
    </div>
  );
}
