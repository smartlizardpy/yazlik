import type { ReactNode } from "react";

/**
 * One card, centred, on a phone-sized screen.
 *
 * The root layout already caps the page at 560px and pads it; this segment only
 * has to hold a single narrow column and keep it vertically comfortable at
 * 390x844. The border is deliberately absent on a phone — a boxed card inside a
 * 390px viewport is just a second frame around the frame — and appears from
 * `sm` up, where the card has room to read as an object on the page.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col justify-center py-10 sm:py-16">
      <div className="mx-auto w-full max-w-sm sm:rounded-lg sm:border sm:border-border sm:p-6">
        {children}
      </div>
    </div>
  );
}
