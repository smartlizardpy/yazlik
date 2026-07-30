import Link from "next/link";

export default function Home() {
  return (
    <section className="flex flex-1 flex-col justify-center gap-6 py-16">
      <h1 className="text-lg font-semibold tracking-tight">Yazlık</h1>
      <p className="text-base text-muted-foreground">
        One link for your summer house: family and friends request the dates
        they want, and you approve or decline in a tap.
      </p>
      <Link
        href="/sign-in"
        className="inline-flex h-11 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Sign in
      </Link>
    </section>
  );
}
