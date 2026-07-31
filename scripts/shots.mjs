/**
 * Captures every screen at a real phone viewport, signed in where needed.
 *
 * Run against a dev server on 3100. Signs in by pulling the magic link out of
 * the dev server log, because with no RESEND_API_KEY the link is printed there
 * rather than emailed.
 *
 *   node scripts/shots.mjs <dev-log-path> <out-dir>
 */
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const BASE = "http://localhost:3100";
const LOG = process.argv[2];
const OUT = process.argv[3];
const CHROME = "/usr/bin/google-chrome-stable";

// iPhone 14-ish. The whole product is designed at this width.
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function magicLink(page) {
  await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle2" });
  await page.type('input[type="email"]', "owner@example.com");
  await page.click('button[type="submit"]');
  // The sign-in POST itself takes a couple of seconds against Neon, and the
  // email is printed only after it resolves — so poll rather than guess.
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(1000);
    const log = readFileSync(LOG, "utf8");
    const links = log.match(
      /http:\/\/localhost:3100\/api\/auth\/magic-link\/verify\?token=[^\s"<]+/g,
    );
    if (links?.length) return links[links.length - 1].replace(/&amp;/g, "&");
  }
  throw new Error("no magic link found in the dev log after 20s");
}

const shots = [
  { name: "01-landing", url: "/", auth: false },
  { name: "02-sign-in", url: "/sign-in", auth: false },
  { name: "03-house-public", url: "/h/demo-house", auth: false },
  { name: "04-house-scrolled", url: "/h/demo-house", auth: false, scroll: 700 },
  { name: "05-booking-guest", url: "/b/demo-booking-selin", auth: false },
  { name: "06-booking-pending", url: "/b/demo-booking-mehmet", auth: false },
  { name: "07-dashboard", url: "/app", auth: true },
  { name: "08-settings", url: "/app/settings", auth: true },
  { name: "09-settings-scrolled", url: "/app/settings", auth: true, scroll: 900 },
  { name: "10-share", url: "/app/share", auth: true },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);

  const link = await magicLink(page);
  await page.goto(link, { waitUntil: "networkidle2" });
  console.log("signed in:", page.url());

  for (const shot of shots) {
    await page.goto(BASE + shot.url, { waitUntil: "networkidle2" });
    if (shot.scroll) {
      await page.evaluate((y) => window.scrollTo(0, y), shot.scroll);
      await sleep(400);
    }
    await sleep(600);
    const path = `${OUT}/${shot.name}.png`;
    await page.screenshot({ path, fullPage: false });
    console.log("captured", shot.name, "->", page.url());
  }

  // The request sheet, which is the whole point of the guest side and is
  // invisible in a plain page screenshot.
  await page.goto(`${BASE}/h/demo-house`, { waitUntil: "networkidle2" });
  await sleep(500);
  const opened = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const cta = buttons.find((b) => /request/i.test(b.textContent ?? ""));
    if (!cta) return false;
    cta.click();
    return true;
  });
  if (opened) {
    await sleep(1200);
    await page.screenshot({ path: `${OUT}/11-request-sheet.png` });
    console.log("captured 11-request-sheet");
  } else {
    console.log("could not find the request CTA");
  }
} finally {
  await browser.close();
}
