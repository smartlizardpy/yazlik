import type { ReactNode } from "react";

/**
 * One narrow column, held at the top of the screen.
 *
 * It used to be vertically centred, which on a 390x844 phone put the email
 * field 53% of the way down the glass — and then the keyboard opened, the
 * viewport halved, and the whole panel jumped upward while somebody was
 * reaching for it. A sign-in screen has one field and one button; there is
 * nothing to centre and everything to keep still.
 *
 * The border is deliberately absent on a phone — a boxed card inside a 390px
 * viewport is just a second frame around the frame — and appears from `sm` up,
 * where the card has room to read as an object on the page.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col pt-8 pb-10 sm:pt-16">
      <div className="mx-auto w-full max-w-sm sm:rounded-lg sm:border sm:border-border sm:p-6">
        {children}
      </div>
    </div>
  );
}
