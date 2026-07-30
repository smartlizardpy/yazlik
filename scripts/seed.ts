/**
 * Seeds one house and three bookings across a known August.
 *
 * Idempotent: keyed on the house slug, so re-running replaces the demo data
 * rather than piling up. Phase 2 will attach a real better-auth user; until
 * then the owner is a placeholder id.
 */
import { eq } from "drizzle-orm";
import { db } from "../db";
import { user } from "../db/auth-schema";
import { bookings, houses } from "../db/schema";

const SEED_SLUG = "demo-house";
const SEED_OWNER = "seed-owner";
const SEED_EMAIL = "owner@example.com";

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
    await db.delete(houses).where(eq(houses.id, existing.id));
    console.log("removed previous seed house");
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

  console.log(`seeded house ${house.slug} (${house.id}) with 3 bookings`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
