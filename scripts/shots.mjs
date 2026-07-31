/**
 * Captures every screen at a real phone viewport, signed in where needed.
 *
 * Run against a dev server on 3100.
 *
 *   node --env-file=.env.local scripts/shots.mjs <out-dir> [dev-log-path]
 *
 * Signing in: with no RESEND_API_KEY the magic link is *printed* to the dev
 * server's stdout, so if you can read that log we grep it. A dev server started
 * in someone's terminal has no log file, so the fallback is the database —
 * better-auth writes the magic-link token to `verification.identifier` and the
 * verify URL is built from it. Same result, no log required.
 */
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";
import postgres from "postgres";

const BASE = process.env.SHOTS_BASE ?? "http://localhost:3100";
const OUT = process.argv[2];
const LOG = process.argv[3];
const CHROME = "/usr/bin/google-chrome-stable";

if (!OUT) {
  console.error("usage: node --env-file=.env.local scripts/shots.mjs <out-dir> [dev-log-path]");
  process.exit(1);
}

// iPhone 14-ish. The whole product is designed at this width.
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function requestMagicLink() {
  const res = await fetch(`${BASE}/api/auth/sign-in/magic-link`, {
    method: "POST",
    // better-auth checks Origin against its trusted origins, and node's fetch
    // sends one that does not match BETTER_AUTH_URL. Say it explicitly.
    headers: { "Content-Type": "application/json", Origin: BASE },
    body: JSON.stringify({ email: "owner@example.com", callbackURL: "/app" }),
  });
  if (!res.ok) throw new Error(`sign-in POST failed: ${res.status} ${await res.text()}`);
}

/** The link as printed to the dev log, when there is a dev log to read. */
function linkFromLog() {
  if (!LOG) return null;
  let log;
  try {
    log = readFileSync(LOG, "utf8");
  } catch {
    return null;
  }
  const escaped = BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const links = log.match(new RegExp(`${escaped}/api/auth/magic-link/verify\\?token=[^\\s"<]+`, "g"));
  return links?.length ? links[links.length - 1].replace(/&amp;/g, "&") : null;
}

/** The token straight out of better-auth's own table. */
async function linkFromDb(since) {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  const sql = postgres(url, { ssl: "require" });
  try {
    for (let attempt = 0; attempt < 15; attempt++) {
      const rows = await sql`
        select identifier, created_at from verification
        where value like '%owner@example.com%'
        order by created_at desc limit 1`;
      const row = rows[0];
      if (row && new Date(row.created_at) > since) {
        return `${BASE}/api/auth/magic-link/verify?token=${row.identifier}&callbackURL=/app`;
      }
      await sleep(1000);
    }
  } finally {
    await sql.end();
  }
  return null;
}

async function magicLink() {
  // The DB clock and this machine's clock disagree by up to an hour on Neon, so
  // the "newer than" mark is taken from the DB itself, not from Date.now().
  let since = new Date(0);
  const url = process.env.DATABASE_URL;
  if (url) {
    const sql = postgres(url, { ssl: "require" });
    const rows = await sql`select max(created_at) as at from verification`;
    if (rows[0]?.at) since = new Date(rows[0].at);
    await sql.end();
  }

  await requestMagicLink();

  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(1000);
    const fromLog = linkFromLog();
    if (fromLog) return fromLog;
    const fromDb = await linkFromDb(since);
    if (fromDb) return fromDb;
  }
  throw new Error("no magic link found in the dev log or the database");
}

const shots = [
  { name: "01-landing", url: "/" },
  { name: "02-sign-in", url: "/sign-in" },
  { name: "03-house-public", url: "/h/demo-house" },
  { name: "04-house-scrolled", url: "/h/demo-house", scroll: 700 },
  { name: "05-booking-guest", url: "/b/demo-booking-selin" },
  { name: "06-booking-pending", url: "/b/demo-booking-mehmet" },
  { name: "07-dashboard", url: "/app", auth: true },
  { name: "08-settings", url: "/app/settings", auth: true },
  { name: "09-settings-scrolled", url: "/app/settings", auth: true, scroll: 900 },
  { name: "10-share", url: "/app/share", auth: true },
  { name: "12-onboarding", url: "/app/onboarding", auth: true },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  const link = await magicLink();
  await page.goto(link, { waitUntil: "networkidle2" });
  console.log("signed in:", page.url());

  for (const shot of shots) {
    await page.goto(BASE + shot.url, { waitUntil: "networkidle2" });
    if (shot.scroll) {
      await page.evaluate((y) => window.scrollTo(0, y), shot.scroll);
      await sleep(400);
    }
    await sleep(700);
    await page.screenshot({ path: `${OUT}/${shot.name}.png`, fullPage: false });
    console.log("captured", shot.name, "->", page.url());
  }

  // The request sheet, which is the whole point of the guest side and is
  // invisible in a plain page screenshot.
  await page.goto(`${BASE}/h/demo-house`, { waitUntil: "networkidle2" });
  await sleep(600);
  const opened = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const cta = buttons.find((b) => /ask to stay|request|iste|sor/i.test(b.textContent ?? ""));
    if (!cta) return null;
    cta.click();
    return cta.textContent;
  });
  if (opened) {
    await sleep(1400);
    await page.screenshot({ path: `${OUT}/11-request-sheet.png` });
    console.log("captured 11-request-sheet (cta:", JSON.stringify(opened), ")");
  } else {
    console.log(
      "could not find the request CTA; buttons were:",
      await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => b.textContent)),
    );
  }
} finally {
  await browser.close();
}
