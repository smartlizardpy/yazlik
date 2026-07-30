import type { Metadata } from "next";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in — Yazlık",
  description: "Sign in to Yazlık with a link sent to your email.",
};

export default function SignInPage() {
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm font-medium tracking-tight text-muted-foreground">
        Yazlık
      </p>
      {/*
        The heading lives inside the client component: once the link is sent the
        whole panel changes, heading included, rather than leaving "Sign in"
        sitting above a confirmation.

        NODE_ENV is read here, on the server, and passed down — the page is the
        right place to know which environment it is running in.
      */}
      <SignInForm showDevNote={process.env.NODE_ENV !== "production"} />
    </div>
  );
}
