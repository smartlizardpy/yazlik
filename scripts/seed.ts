/**
 * Seeds one house, three bookings and three photographs across a known August.
 *
 * Idempotent: keyed on the house slug, so re-running replaces the demo data
 * rather than piling up — including the files on disk, which the cascade on
 * `images` would otherwise orphan in `.uploads/`.
 *
 * ### Why this script draws pictures
 *
 * The design system says photographs are the only colour on screen. A seed with
 * no photographs therefore seeds a product that cannot be looked at: the hero
 * falls to its no-photo variant, the strip renders its empty state, the Open
 * Graph card comes out as paper, and every screenshot anyone takes is grey,
 * white and black. Those three code paths had never been seen running.
 *
 * So the demo photographs are generated here, from value noise, and written
 * through `lib/storage` like any upload. No binaries in the repository, no
 * network call, no stock-photo licence, and `.uploads/` stays gitignored — a
 * fresh clone runs `pnpm db:seed` and has a house with pictures in it.
 *
 * They are not photographs of a real house and are not pretending to be. They
 * are the sea, a bay and a hillside at the size and colour a real one would be,
 * which is all the hero, the strip and the OG card need in order to be judged.
 */
import { deflateSync } from "node:zlib";

import { eq } from "drizzle-orm";
import { db } from "../db";
import { user } from "../db/auth-schema";
import { bookings, houses, images } from "../db/schema";
import { remove, save } from "../lib/storage";

const SEED_SLUG = "demo-house";
const SEED_OWNER = "seed-owner";
const SEED_EMAIL = "owner@example.com";

/* ============================================================
   PNG
   ============================================================ */

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(bytes: Buffer): number {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * 8-bit RGB, no palette, no interlace — the smallest PNG that says what it has
 * to. Every scanline uses filter 2 (Up), which is worth having: these images are
 * mostly vertical gradients, so each row is nearly its predecessor and deflate
 * gets a megabyte of near-zeros instead of a megabyte of colour.
 */
function encodePng(width: number, height: number, rgb: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour

  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 2;
    for (let x = 0; x < stride; x++) {
      const above = y === 0 ? 0 : rgb[(y - 1) * stride + x];
      raw[row + 1 + x] = (rgb[y * stride + x] - above) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ============================================================
   FIELDS
   ============================================================ */

type Colour = [number, number, number];

const clamp = (n: number) => (n < 0 ? 0 : n > 255 ? 255 : n | 0);

/** Hermite ease. Every soft edge in this file is one of these. */
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

const mix = (a: Colour, b: Colour, t: number): Colour => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Integer hash. `Math.imul` because the products overflow a double. */
function hash2(i: number, j: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise, bilinear on a smoothed lattice. */
function noise2(x: number, y: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = smooth(x - i);
  const fy = smooth(y - j);
  const a = hash2(i, j);
  const b = hash2(i + 1, j);
  const c = hash2(i, j + 1);
  const d = hash2(i + 1, j + 1);
  const top = a + (b - a) * fx;
  return top + (c + (d - c) * fx - top) * fy;
}

/**
 * Octaves of `noise2`, roughly 0–1.
 *
 * This is the whole difference between a picture and a diagram. A first attempt
 * drew objects — a shutter, a bougainvillea, olive trees — out of hard edges and
 * `sin(u) * sin(v)` texture, and every one of them came out as flat vector art
 * with a checkerboard on it. Noise-driven fields and soft edges read as
 * atmosphere, and atmosphere is what a photograph mostly is.
 */
function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amplitude = 0.5;
  let frequency = 1;
  for (let o = 0; o < octaves; o++) {
    sum += noise2(x * frequency, y * frequency) * amplitude;
    frequency *= 2;
    amplitude *= 0.5;
  }
  return sum * 1.06;
}

const WIDTH = 1280;
const HEIGHT = 960;

/** `(u, v)` in 0–1, top-left origin, to a colour. */
type Paint = (u: number, v: number) => Colour;

/**
 * Runs a scene, then does the two things every camera does: film grain, so the
 * gradients do not band on an OLED phone, and a vignette, so the frame has a
 * centre. The grain generator is a plain LCG rather than `Math.random` so the
 * same seed run twice writes the same bytes.
 */
function renderScene(paint: Paint): Buffer {
  let noise = 20260801;
  const grain = () => {
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    return noise / 4294967296 - 0.5;
  };

  const buffer = Buffer.alloc(WIDTH * HEIGHT * 3);
  for (let y = 0; y < HEIGHT; y++) {
    const v = y / HEIGHT;
    for (let x = 0; x < WIDTH; x++) {
      const u = x / WIDTH;
      const colour = paint(u, v);
      const g = grain() * 7;
      const dx = u - 0.5;
      const dy = v - 0.52;
      const vignette = 1 - 0.34 * (dx * dx * 1.1 + dy * dy) * 2.2;
      const i = (y * WIDTH + x) * 3;
      buffer[i] = clamp((colour[0] + g) * vignette);
      buffer[i + 1] = clamp((colour[1] + g) * vignette);
      buffer[i + 2] = clamp((colour[2] + g) * vignette);
    }
  }
  return buffer;
}

/* ============================================================
   THREE SCENES
   ============================================================ */

/** The sun going down over the water. This one is the cover and the OG card. */
const sunset: Paint = (u, v) => {
  const horizon = 0.515;
  const sunX = 0.655;
  const sunY = 0.4;
  let c: Colour;

  if (v < horizon) {
    const t = v / horizon;
    c = mix([116, 146, 174], [246, 206, 148], Math.pow(1 - t, 1.7));
    // High cloud is wide and thin, so the noise is sampled wide and thin.
    const wisp = fbm(u * 3.4, v * 11 + fbm(u * 2, v * 3, 2) * 1.6, 5);
    c = mix(c, [255, 232, 206], Math.max(0, wisp - 0.42) * 1.5 * (0.35 + t * 0.55));
    c = mix(c, [150, 132, 128], Math.max(0, wisp - 0.6) * 0.75 * (1 - t) * 0.9);
    const d = Math.hypot(u - sunX, (v - sunY) * 1.35);
    c = mix(c, [255, 240, 206], Math.pow(Math.max(0, 1 - d / 0.46), 2.4) * 0.92);
    if (d < 0.05) c = mix(c, [255, 252, 238], smooth((0.05 - d) / 0.028));
  } else {
    const t = smooth((v - horizon) / (1 - horizon));
    c = mix([116, 148, 158], [36, 58, 70], Math.pow(t, 0.75));
    // A sine whose phase is pushed around by noise: the bands break up instead
    // of marching in step, which is the difference between water and corduroy.
    const phase = v * 150 + fbm(u * 5, v * 22, 4) * 9;
    const ripple = Math.max(0, Math.sin(phase));
    c = mix(c, [196, 212, 208], ripple * 0.16 * (1 - t * 0.65));
    const path = Math.max(0, 1 - Math.abs(u - sunX) / (0.045 + t * 0.3));
    c = mix(
      c,
      [252, 228, 178],
      path * path * 0.62 * (1 - t * 0.5) * (ripple * 0.65 + 0.35),
    );
  }

  // The terrace planting, thrown out of focus in the near foreground. It is
  // also what gives the hero's scrim something dark to sit the name on.
  const edge = 0.855 + (fbm(u * 4.5 + 9, 3.3, 4) - 0.5) * 0.13;
  return mix(c, [34, 40, 30], smooth((v - edge) / 0.07) * 0.94);
};

/** The bay in the middle of the day. The one that is properly a colour. */
const bay: Paint = (u, v) => {
  const horizon = 0.27;
  const skyAtHorizon: Colour = [222, 230, 228];
  let c: Colour;

  if (v < horizon) {
    c = mix([104, 152, 188], skyAtHorizon, Math.pow(v / horizon, 0.85));
    const haze = fbm(u * 2.4, v * 8, 4);
    c = mix(c, [248, 246, 238], Math.max(0, haze - 0.46) * 1.1 * (v / horizon));
    // A headland most of the way to invisible. It is four kilometres off in
    // August heat, so it loses contrast on the way down to the water rather
    // than sitting on it as a block, which is what the first attempt did.
    const ridge = horizon - 0.085 - fbm(u * 2.3 + 4, 1.7, 4) * 0.055;
    if (v > ridge) {
      const depth = smooth((v - ridge) / (horizon - ridge));
      const tone = mix([132, 144, 144], [196, 206, 204], Math.pow(depth, 0.7));
      c = mix(c, tone, smooth((v - ridge) / 0.02) * 0.66);
    }
    return c;
  }

  const shore = 0.8 + (fbm(u * 3.1 + 21, 5.5, 4) - 0.5) * 0.07;
  if (v < shore) {
    const t = (v - horizon) / (shore - horizon);
    // The seabed coming up is what makes Aegean water turn that colour.
    const bed = t + (fbm(u * 4, v * 6, 4) - 0.5) * 0.2;
    c = mix([24, 92, 122], [126, 208, 202], Math.pow(smooth(bed), 0.85));
    c = mix(c, [190, 228, 216], Math.pow(smooth(bed), 3.2) * 0.55);
    const phase = v * 88 + fbm(u * 4.5, v * 14, 3) * 7;
    c = mix(c, [234, 245, 240], Math.max(0, Math.sin(phase)) * 0.1 * smooth(bed));
    c = mix(c, skyAtHorizon, Math.max(0, 1 - (v - horizon) / 0.035) * 0.3);
    return mix(c, [250, 251, 247], smooth((v - (shore - 0.032)) / 0.028) * 0.88);
  }

  const t = smooth((v - shore) / (1 - shore));
  c = mix([216, 200, 174], [184, 163, 134], t);
  c = mix(c, [240, 230, 210], (fbm(u * 8, v * 8, 5) - 0.42) * 1.0);
  c = mix(c, [166, 150, 128], Math.max(0, fbm(u * 3 + 60, v * 3, 3) - 0.55) * 1.1);
  // Wet sand, still dark from the last wave.
  return mix(c, [170, 154, 132], Math.max(0, 1 - t / 0.26) * 0.55);
};

/** The hills behind the house, going blue. */
const hills: Paint = (u, v) => {
  const skyline = 0.46;
  let c: Colour =
    v < skyline
      ? mix([150, 170, 190], [244, 222, 196], Math.pow(v / skyline, 1.5))
      : mix([244, 222, 196], [212, 188, 156], smooth((v - skyline) / 0.5));

  const wisp = fbm(u * 3, v * 10 + 3, 4);
  c = mix(
    c,
    [255, 236, 214],
    Math.max(0, wisp - 0.5) * 1.2 * Math.max(0, 1 - v / skyline) * 0.9,
  );

  // Four ridges, each nearer one darker and greener. Aerial perspective is what
  // makes a hillside read as distance rather than as stripes.
  const ridges: [number, number, number, number, Colour, number][] = [
    [skyline - 0.045, 2.0, 7, 0.045, [178, 180, 182], 0.7],
    [skyline + 0.025, 2.7, 13, 0.055, [152, 154, 140], 0.8],
    [skyline + 0.115, 1.7, 31, 0.07, [116, 120, 94], 0.88],
    [skyline + 0.255, 1.25, 53, 0.1, [74, 78, 54], 0.96],
  ];
  for (const [base, frequency, seed, amplitude, tone, cover] of ridges) {
    const line = base - (fbm(u * frequency + seed, seed * 0.7, 5) - 0.45) * amplitude * 2;
    if (v <= line) continue;
    const shade = fbm(u * 7 + seed, v * 7, 4) - 0.5;
    c = mix(
      c,
      [tone[0] + shade * 46, tone[1] + shade * 44, tone[2] + shade * 36],
      smooth((v - line) / 0.01) * cover,
    );
  }
  return c;
};

/**
 * In the order the page uses them: the first is the hero and the Open Graph
 * card, the rest are the strip. The alt text is what the owner would have
 * typed — a sentence about the picture, never the word "image".
 */
const SCENES: { alt: string; paint: Paint }[] = [
  { alt: "The sun going down over the water, from the terrace.", paint: sunset },
  { alt: "Ilıca bay in the middle of the day.", paint: bay },
  { alt: "The hills behind the house, going blue in the evening.", paint: hills },
];

/* ============================================================
   SEED
   ============================================================ */

/** Draws the demo photographs, stores them, and returns the rows to insert. */
async function seedPhotos(houseId: string) {
  const rows: (typeof images.$inferInsert)[] = [];

  for (const [position, scene] of SCENES.entries()) {
    const bytes = encodePng(WIDTH, HEIGHT, renderScene(scene.paint));
    // Through `save()`, not straight to disk: the seed then exercises the same
    // validation, key generation and driver selection as a real upload, and
    // works unchanged if STORAGE_DRIVER is set to blob.
    const stored = await save(
      // Copied into a plain Uint8Array: node's Buffer is typed over
      // ArrayBufferLike, which BlobPart will not accept.
      new File([new Uint8Array(bytes)], `demo-${position + 1}.png`, {
        type: "image/png",
      }),
      `houses/${houseId}`,
    );
    rows.push({ houseId, position, alt: scene.alt, ...stored });
  }

  return rows;
}

async function main() {
  // A real user row — houses.ownerId is a foreign key into better-auth's table.
  // Sign in as this address in dev: the magic link prints to the console.
  await db
    .insert(user)
    .values({
      id: SEED_OWNER,
      name: "Demo owner",
      email: SEED_EMAIL,
      emailVerified: true,
    })
    .onConflictDoNothing();

  const [existing] = await db
    .select({ id: houses.id })
    .from(houses)
    .where(eq(houses.slug, SEED_SLUG));

  if (existing) {
    // Deleting the house cascades the image rows, which would leave their files
    // behind in .uploads/ with nothing pointing at them. Take the files first.
    const stale = await db
      .select({ pathname: images.pathname })
      .from(images)
      .where(eq(images.houseId, existing.id));
    await Promise.all(stale.map((image) => remove(image.pathname)));

    await db.delete(houses).where(eq(houses.id, existing.id));
    console.log(`removed previous seed house and ${stale.length} photos`);
  }

  const [house] = await db
    .insert(houses)
    .values({
      ownerId: SEED_OWNER,
      slug: SEED_SLUG,
      feedToken: "demo-feed-token",
      name: "The Çeşme house",
      town: "Çeşme",
      country: "Turkey",
      language: "en",
      blurb:
        "Five minutes from Ilıca beach, up the hill behind the bakery. Sleeps six, badly insulated, excellent in August.",
      minNights: 2,
      maxNights: 21,
      gapDays: 0,
      maxGuests: 6,
      bookableFrom: "2026-05-01",
      bookableTo: "2026-10-15",
      showGuestNames: true,
    })
    .returning();

  await db.insert(bookings).values([
    {
      houseId: house.id,
      kind: "guest",
      guestName: "Selin",
      guestEmail: "selin@example.com",
      guests: 4,
      note: "Bringing the dog, hope that's fine.",
      startDate: "2026-08-04",
      endDate: "2026-08-10",
      status: "confirmed",
      token: "demo-booking-selin",
    },
    {
      houseId: house.id,
      kind: "guest",
      guestName: "Mehmet",
      guestEmail: "mehmet@example.com",
      guests: 2,
      startDate: "2026-08-18",
      endDate: "2026-08-23",
      status: "pending",
      token: "demo-booking-mehmet",
    },
    {
      houseId: house.id,
      kind: "block",
      guests: 1,
      note: "Roof repair",
      startDate: "2026-09-01",
      endDate: "2026-09-05",
      status: "confirmed",
      token: "demo-block-roof",
    },
  ]);

  await db.insert(images).values(await seedPhotos(house.id));

  console.log(
    `seeded house ${house.slug} (${house.id}) with 3 bookings and ${SCENES.length} photos`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
