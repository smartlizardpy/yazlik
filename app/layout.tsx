import type { Metadata, Viewport } from "next";
import { Fraunces, Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

/**
 * Two faces, and the second one is the whole personality.
 *
 * Inter keeps every label, field, button and number — it is invisible, which
 * is its job. Fraunces is the voice: it carries the house's name, the month on
 * the calendar, and the sentence that tells a cousin the week is theirs. This
 * product has no accent hue by design and often has no photographs yet, so
 * type is the only instrument left; one face playing one note is why the whole
 * thing read as an admin panel in a warm palette.
 *
 * `latin-ext` is not optional. Çeşme, Ağustos, Yazlık — the ş, ğ and İ live in
 * that subset, and without it the most Turkish words on the page fall back to
 * whatever serif the phone happens to have.
 */
const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

/**
 * Variable across the full 100–900 range, so a heading asking for `font-medium`
 * gets a real 500 rather than a synthesised smear — which is the trap with the
 * single-weight display serifs.
 *
 * The axes are requested here so `globals.css` can tune them: `WONK` swaps in
 * the alternate /g and /y, `SOFT` rounds the terminals, and `opsz` is left to
 * `font-optical-sizing: auto` so the same family is sturdy at 17px and
 * high-contrast at 48px without a second import.
 */
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin", "latin-ext"],
  display: "swap",
  axes: ["SOFT", "WONK", "opsz"],
});

export const metadata: Metadata = {
  title: "Yazlık",
  description: "One link for the summer house. Guests ask, the owner decides.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${fraunces.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex min-h-full flex-col">
        <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col px-4">
          {children}
        </main>
        <Toaster position="top-center" />
      </body>
    </html>
  );
}
