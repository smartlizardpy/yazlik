import type { Metadata } from "next";
import { isGoogleConfigured } from "@/lib/google/config";
import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in — Yazlık",
  description: "Sign in to Yazlık with a link sent to your email.",
};

export default async function SignInPage(props: PageProps<"/sign-in">) {
  const googleEnabled = isGoogleConfigured();

  /**
   * A Google sign-in that fails comes back here as `?error=…`, because
   * `signInWithGoogle` asks for that rather than better-auth's own error page.
   * The query is read on the server so the very first render already carries
   * the answer — the alternative is a client component discovering it after
   * hydration and either flashing the wrong screen or arguing with the HTML.
   *
   * Read **only** when there is a Google button that could have failed. Touching
   * `searchParams` is what opts a page into dynamic rendering, and a deployment
   * with no Google credentials should stay exactly the statically rendered page
   * it is today.
   */
  const { error } = googleEnabled
    ? await props.searchParams
    : { error: undefined };

  return (
    <div className="flex flex-1 flex-col">
      {/*
        The product's own name, on the one page that carries it — set exactly as
        it is on `/`, because a person taps through from there and the mark
        should not change size on the way. It was `text-xl` here, which made the
        masthead louder than the page's own heading: the shop sign shouting over
        the thing written on the door.
      */}
      <p className="font-heading text-lg">Yazlık</p>

      {/*
        The heading lives inside the client component: once the link is sent the
        whole panel changes, heading included, rather than leaving a stale one
        sitting above a confirmation. It also owns the `flex-1` that lets the
        form fall to the bottom of the layout's column.

        NODE_ENV is read here, on the server, and passed down — the page is the
        right place to know which environment it is running in. Whether Google
        is configured is the same kind of fact and travels the same way: a
        client component asking `process.env` would be asking the browser, and
        a Google button that leads nowhere is worse than no button at all.
      */}
      <SignInForm
        showDevNote={process.env.NODE_ENV !== "production"}
        googleEnabled={googleEnabled}
        googleErrorCode={typeof error === "string" ? error : null}
      />
    </div>
  );
}
