import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import en from "@/lib/i18n/en.json";
import tr from "@/lib/i18n/tr.json";

/**
 * These pages are static text, so there is not much to unit test — but there
 * are two ways they rot silently, and both are worth catching.
 *
 * The first is a claim going stale. The privacy page says there is no analytics
 * and no tracking, and that is true only for as long as nobody adds a package
 * that does it. A dependency is the thing that would make the page a lie, so
 * the dependency list is what this asserts against.
 *
 * The second is a dead link, which for a legal page is worse than an ugly one.
 */

const root = join(process.cwd(), "app", "legal");

function pageFor(slug: string): string {
  return readFileSync(join(root, slug, "page.tsx"), "utf8");
}

describe("the legal pages exist", () => {
  const expected = ["privacy", "terms", "contact"];

  it.each(expected)("/legal/%s has a page", (slug) => {
    expect(() => pageFor(slug)).not.toThrow();
  });

  it("has no route without a page", () => {
    const dirs = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(dirs.sort()).toEqual([...expected].sort());
  });

  it("every page carries a title", () => {
    for (const slug of expected) {
      expect(pageFor(slug)).toMatch(/export const metadata/);
    }
  });
});

describe("the privacy page's claims still hold", () => {
  const pkg = JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const deps = Object.keys(pkg.dependencies ?? {});

  // Not a blocklist of everything that could ever track someone — a list of
  // what would most plausibly get added to THIS app and quietly make the page
  // untrue. If one of these ever belongs here, the page has to change first.
  const trackers = [
    "@vercel/analytics",
    "posthog-js",
    "@sentry/nextjs",
    "mixpanel-browser",
    "plausible-tracker",
    "react-ga4",
  ];

  it.each(trackers)("does not depend on %s", (name) => {
    expect(deps).not.toContain(name);
  });

  it("still says there is no analytics", () => {
    expect(pageFor("privacy")).toMatch(/no analytics/i);
  });

  it("still says no money changes hands", () => {
    const privacy = pageFor("privacy");
    expect(privacy).toMatch(/no payment processor/i);
    expect(deps).not.toContain("stripe");
    expect(deps).not.toContain("@stripe/stripe-js");
  });
});

describe("the footer's labels are translated", () => {
  it.each(["legal.privacy", "legal.terms", "legal.contact"])(
    "%s exists in both dictionaries",
    (key) => {
      expect(en).toHaveProperty(key);
      expect(tr).toHaveProperty(key);
      // A Turkish string identical to the English one is an untranslated key,
      // which is the failure mode this product has already had twice.
      expect((tr as Record<string, string>)[key]).not.toBe(
        (en as Record<string, string>)[key],
      );
    },
  );
});
