"use client";

import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Magic link sign-in. There is no password anywhere in this product, so this is
 * one field and one button.
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

export function SignInForm({ showDevNote }: { showDevNote: boolean }) {
  const emailId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const sentHeadingRef = useRef<HTMLHeadingElement>(null);

  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState("");

  // The panel swaps under the reader, so move focus with it. Coming back to fix
  // a typo lands in the field with the address still there, ready to edit.
  useEffect(() => {
    if (status === "sent") sentHeadingRef.current?.focus();
  }, [status]);

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
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <h1
            ref={sentHeadingRef}
            tabIndex={-1}
            className="text-lg font-semibold tracking-tight outline-none"
          >
            Check your email
          </h1>
          <p className="text-sm text-muted-foreground">
            The sign-in link is on its way to{" "}
            <span className="font-medium text-foreground break-all">
              {sentTo}
            </span>
            . Open it on this phone and you&rsquo;re in. It works once and
            expires in an hour.
          </p>
        </div>

        <Button
          type="button"
          variant="outline"
          className="h-11 w-full"
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
    );
  }

  const sending = status === "sending";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Give us your email and we&rsquo;ll send a link that signs you in.
          There&rsquo;s no password to remember.
        </p>
      </div>

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

        <Button type="submit" disabled={sending} className="h-11 w-full">
          {sending ? "Sending the link…" : "Email me a link"}
        </Button>
      </form>

      {devNote}
    </div>
  );
}
