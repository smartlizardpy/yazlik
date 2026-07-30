// Yazlık domain schema — the single source of truth for drizzle-kit.
//
// better-auth's own tables (user, session, account, verification) live in
// ./auth-schema.ts, regenerated with `pnpm auth:generate`. Do not hand-edit
// that file; houses.ownerId is the only thing here that reaches into it.
//
// Dates that describe a stay (startDate, endDate, bookableFrom, bookableTo) are
// plain `date` columns handled as 'YYYY-MM-DD' strings. Check-in day and
// check-out day — no timestamps, no timezone maths.

import { relations } from "drizzle-orm";
import { user } from "./auth-schema";
import {
  boolean,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/* ============================================================
   ENUMS
   ============================================================ */

/** Language the guest-facing pages and emails render in, per house. */
export const houseLanguage = pgEnum("house_language", ["en", "tr"]);

/** A 'block' is the owner reserving dates for themselves — same table, same overlap rule. */
export const bookingKind = pgEnum("booking_kind", ["guest", "block"]);

export const bookingStatus = pgEnum("booking_status", [
  "pending",
  "confirmed",
  "declined",
  "cancelled",
]);

/** One-way app → Google Calendar sync state. Never allowed to block an approval. */
export const googleSyncStatus = pgEnum("google_sync_status", [
  "none",
  "synced",
  "failed",
]);

/** 'guests' sections (and their photos) are never served on the public house page. */
export const guideVisibility = pgEnum("guide_visibility", ["public", "guests"]);

export const placeCategory = pgEnum("place_category", [
  "eat",
  "drink",
  "beach",
  "walk",
  "shop",
  "kids",
]);

/* ============================================================
   HOUSES
   ============================================================ */

export const houses = pgTable(
  "houses",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    /** 12-char nanoid — the unguessable public URL at /h/[slug]. */
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    town: text("town").notNull(),
    country: text("country").notNull(),
    language: houseLanguage("language").notNull().default("en"),
    blurb: text("blurb"),

    // Soft booking rules — enforced in lib/availability.ts, not by the database.
    minNights: integer("min_nights").notNull().default(2),
    maxNights: integer("max_nights").notNull().default(21),
    gapDays: integer("gap_days").notNull().default(0),
    maxGuests: integer("max_guests").notNull().default(8),

    /** Season window. NULL on either side means unbounded in that direction. */
    bookableFrom: date("bookable_from", { mode: "string" }),
    bookableTo: date("bookable_to", { mode: "string" }),

    showGuestNames: boolean("show_guest_names").notNull().default(true),

    /** nanoid behind the private subscribe URL /api/feed/[feedToken].ics */
    feedToken: text("feed_token").notNull().unique(),

    /** id of the secondary Google calendar this app created. NULL = not connected. */
    googleCalendarId: text("google_calendar_id"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("houses_owner_idx").on(t.ownerId)],
);

/* ============================================================
   BOOKINGS
   ============================================================ */

export const bookings = pgTable(
  "bookings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),

    kind: bookingKind("kind").notNull().default("guest"),

    // NULL for kind = 'block' — an owner blocking dates has no guest.
    guestName: text("guest_name"),
    guestEmail: text("guest_email"),
    guests: integer("guests").notNull().default(1),
    note: text("note"),

    /** Check-in day, inclusive. */
    startDate: date("start_date", { mode: "string" }).notNull(),
    /** Check-out day, exclusive — the daterange is '[)'. */
    endDate: date("end_date", { mode: "string" }).notNull(),

    status: bookingStatus("status").notNull().default("pending"),
    declineReason: text("decline_reason"),

    /** nanoid — the guest's private link at /b/[token]. */
    token: text("token").notNull().unique(),

    googleEventId: text("google_event_id"),
    googleSync: googleSyncStatus("google_sync").notNull().default("none"),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    decidedAt: timestamp("decided_at"),
  },
  (t) => [
    index("bookings_house_status_idx").on(t.houseId, t.status),
    index("bookings_house_dates_idx").on(t.houseId, t.startDate, t.endDate),
  ],
);

// NOTE: double-booking is prevented by a hand-written migration, not by Drizzle:
//   CREATE EXTENSION IF NOT EXISTS btree_gist;
//   ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
//     EXCLUDE USING gist (
//       house_id WITH =,
//       daterange(start_date, end_date, '[)') WITH &&
//     ) WHERE (status = 'confirmed');

/* ============================================================
   GUIDE SECTIONS
   ============================================================ */

export const guideSections = pgTable(
  "guide_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    visibility: guideVisibility("visibility").notNull().default("public"),
  },
  (t) => [index("guide_sections_house_idx").on(t.houseId, t.position)],
);

/* ============================================================
   PLACES
   ============================================================ */

export const places = pgTable(
  "places",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
    name: text("name").notNull(),
    category: placeCategory("category").notNull(),
    note: text("note"),
    /** A plain link the owner pastes, e.g. https://maps.google.com/?q=… No Maps API. */
    mapUrl: text("map_url"),
  },
  (t) => [index("places_house_idx").on(t.houseId, t.position)],
);

/* ============================================================
   IMAGES
   ============================================================ */

export const images = pgTable(
  "images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    houseId: uuid("house_id")
      .notNull()
      .references(() => houses.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    /** Blob pathname — kept so deleting the row can delete the blob too. */
    pathname: text("pathname").notNull(),
    alt: text("alt"),
    position: integer("position").notNull().default(0),

    // Both NULL means this is a house gallery photo. At most one is set.
    placeId: uuid("place_id").references(() => places.id, {
      onDelete: "cascade",
    }),
    sectionId: uuid("section_id").references(() => guideSections.id, {
      onDelete: "cascade",
    }),

    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("images_house_idx").on(t.houseId, t.position),
    index("images_place_idx").on(t.placeId),
    index("images_section_idx").on(t.sectionId),
  ],
);

/* ============================================================
   RELATIONS
   ============================================================ */

export const housesRelations = relations(houses, ({ many }) => ({
  bookings: many(bookings),
  guideSections: many(guideSections),
  places: many(places),
  images: many(images),
}));

export const bookingsRelations = relations(bookings, ({ one }) => ({
  house: one(houses, {
    fields: [bookings.houseId],
    references: [houses.id],
  }),
}));

export const guideSectionsRelations = relations(
  guideSections,
  ({ one, many }) => ({
    house: one(houses, {
      fields: [guideSections.houseId],
      references: [houses.id],
    }),
    images: many(images),
  }),
);

export const placesRelations = relations(places, ({ one, many }) => ({
  house: one(houses, {
    fields: [places.houseId],
    references: [houses.id],
  }),
  images: many(images),
}));

export const imagesRelations = relations(images, ({ one }) => ({
  house: one(houses, {
    fields: [images.houseId],
    references: [houses.id],
  }),
  place: one(places, {
    fields: [images.placeId],
    references: [places.id],
  }),
  section: one(guideSections, {
    fields: [images.sectionId],
    references: [guideSections.id],
  }),
}));

/* ============================================================
   TYPES
   ============================================================ */

export type House = typeof houses.$inferSelect;
export type NewHouse = typeof houses.$inferInsert;

export type Booking = typeof bookings.$inferSelect;
export type NewBooking = typeof bookings.$inferInsert;

export type GuideSection = typeof guideSections.$inferSelect;
export type NewGuideSection = typeof guideSections.$inferInsert;

export type Place = typeof places.$inferSelect;
export type NewPlace = typeof places.$inferInsert;

export type ImageRow = typeof images.$inferSelect;
export type NewImageRow = typeof images.$inferInsert;

export type HouseLanguage = (typeof houseLanguage.enumValues)[number];
export type BookingKind = (typeof bookingKind.enumValues)[number];
export type BookingStatus = (typeof bookingStatus.enumValues)[number];
export type GoogleSyncStatus = (typeof googleSyncStatus.enumValues)[number];
export type GuideVisibility = (typeof guideVisibility.enumValues)[number];
export type PlaceCategory = (typeof placeCategory.enumValues)[number];
