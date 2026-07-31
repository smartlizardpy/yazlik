/**
 * The guide's writes, with no database, no session and no blob store.
 *
 * `@/db` throws at import without a `DATABASE_URL`, so it is replaced by the
 * same fake query builder `decision.test.ts` uses: every Drizzle chain method
 * returns the chain, the chain is a thenable, and each verb takes its answer
 * from a scripted queue.
 *
 * ### What actually matters here
 *
 * **Ownership.** A section id and a place id are bare UUIDs sitting in a client
 * component's props. Nothing stops a person editing one before it is sent, so
 * the only thing standing between them and another family's guide is that every
 * statement in `guide.ts` is scoped by the signed-in owner's `houseId` as well
 * as by the row id. These tests assert the row never comes back and the write
 * never lands — and that the refusal says the same thing for a stranger's id as
 * for one that never existed, so the action cannot be used to find out which
 * ids are real.
 *
 * After that: that a draft is **appended** rather than swapped in, and that
 * `/b/[token]` is revalidated, because the guests-only half of the guide is
 * rendered there and nowhere else.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/* ============================================================
   THE FAKE DATABASE
   ============================================================ */

const fake = vi.hoisted(() => {
  type Verb = "select" | "update" | "insert" | "delete" | "execute";
  type Outcome = { rows?: unknown[]; error?: unknown };

  const VERBS: Verb[] = ["select", "update", "insert", "delete", "execute"];

  const queues: Record<Verb, Outcome[]> = {
    select: [],
    update: [],
    insert: [],
    delete: [],
    execute: [],
  };
  const calls: Record<Verb, number> = {
    select: 0,
    update: 0,
    insert: 0,
    delete: 0,
    execute: 0,
  };

  /** What the action asked to write, in call order. */
  const written: { set: unknown[]; values: unknown[] } = { set: [], values: [] };

  const METHODS = [
    "from",
    "innerJoin",
    "where",
    "limit",
    "orderBy",
    "set",
    "values",
    "returning",
  ] as const;

  function builder(verb: Verb) {
    calls[verb] += 1;
    const outcome = queues[verb].shift() ?? { rows: [] };

    const chain: Record<string, unknown> = {};
    for (const method of METHODS) {
      chain[method] = (arg: unknown) => {
        if (method === "set") written.set.push(arg);
        if (method === "values") written.values.push(arg);
        return chain;
      };
    }

    chain.then = (onOk: unknown, onErr: unknown) =>
      Promise.resolve()
        .then(() => {
          if (outcome.error) throw outcome.error;
          return outcome.rows ?? [];
        })
        .then(onOk as never, onErr as never);

    return chain;
  }

  const db = {
    select: () => builder("select"),
    update: () => builder("update"),
    insert: () => builder("insert"),
    delete: () => builder("delete"),
    execute: () => builder("execute"),
  };

  function reset() {
    for (const verb of VERBS) {
      queues[verb].length = 0;
      calls[verb] = 0;
    }
    written.set.length = 0;
    written.values.length = 0;
  }

  function queue(verb: Verb, outcome: Outcome) {
    queues[verb].push(outcome);
  }

  return { db, calls, written, reset, queue };
});

vi.mock("@/db", () => ({ db: fake.db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireHouse: vi.fn() }));
vi.mock("@/lib/storage", () => ({ remove: vi.fn() }));

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/app/_actions/house";
import type { House } from "@/db/schema";
import { requireHouse } from "@/lib/session";
import { remove } from "@/lib/storage";

import {
  createPlace,
  createSection,
  deletePlace,
  deleteSection,
  reorderPlaces,
  reorderSections,
  saveGuideDraft,
  setSectionVisibility,
  toggleSectionVisibility,
  updatePlace,
  updateSection,
} from "@/app/_actions/guide";

/* ============================================================
   FIXTURES
   ============================================================ */

const HOUSE_ID = "22222222-2222-4222-8222-222222222222";
const SECTION_ID = "33333333-3333-4333-8333-333333333333";
const PLACE_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";

const HOUSE: House = {
  id: HOUSE_ID,
  ownerId: "11111111-1111-4111-8111-111111111111",
  slug: "summerhouse01",
  name: "Çeşme evi",
  town: "Çeşme",
  country: "Türkiye",
  language: "tr",
  blurb: null,
  minNights: 2,
  maxNights: 14,
  gapDays: 1,
  maxGuests: 6,
  bookableFrom: "2026-06-01",
  bookableTo: "2026-09-30",
  showGuestNames: true,
  feedToken: "feedtoken1234567",
  googleCalendarId: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

/** `count(*)`, then `max(position) + 1`. The two reads before a create. */
function room(count = 0, next = 0) {
  fake.queue("select", { rows: [{ count }] });
  fake.queue("select", { rows: [{ next }] });
}

/** A write that touched a row. */
function touched(verb: "update" | "delete", id = SECTION_ID) {
  fake.queue(verb, { rows: [{ id }] });
}

/** A write that touched nothing — the row is not on this house. */
function missed(verb: "update" | "delete") {
  fake.queue(verb, { rows: [] });
}

const errors = vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  fake.reset();
  vi.resetAllMocks();
  errors.mockImplementation(() => {});
  vi.mocked(requireHouse).mockResolvedValue(HOUSE);
  vi.mocked(remove).mockResolvedValue(undefined as never);
});

/* ============================================================
   OWNERSHIP
   ============================================================ */

describe("a row that is not on the owner's house", () => {
  it("cannot be changed", async () => {
    missed("update");

    const result = await updateSection(OTHER_ID, { title: "Mine now" });

    expect(result.ok).toBe(false);
    expect(fake.calls.update).toBe(1);
  });

  it("cannot be deleted", async () => {
    fake.queue("select", { rows: [] });
    missed("delete");

    const result = await deleteSection(OTHER_ID);

    expect(result.ok).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it("cannot have its visibility flipped", async () => {
    // The row is looked up with `houseId` in the WHERE, so a stranger's section
    // simply does not come back and nothing is written.
    fake.queue("select", { rows: [] });

    const result = await setSectionVisibility(OTHER_ID, "public");

    expect(result.ok).toBe(false);
    expect(fake.calls.update).toBe(0);
  });

  it("cannot be reached through the place actions either", async () => {
    missed("update");
    expect((await updatePlace(OTHER_ID, { name: "Mine" })).ok).toBe(false);

    fake.queue("select", { rows: [] });
    missed("delete");
    expect((await deletePlace(OTHER_ID)).ok).toBe(false);
  });

  it("says the same thing as an id that never existed", async () => {
    // Otherwise the refusal is an oracle: a different message for a real id
    // tells a stranger which ids are real.
    missed("update");
    const stranger = await updateSection(OTHER_ID, { title: "x" });
    const nonsense = await updateSection("not-a-uuid", { title: "x" });

    expect(message(stranger)).toBe(message(nonsense));
  });

  it("does not ask the database about an id that is not a uuid", async () => {
    await updateSection("../../etc/passwd", { title: "x" });
    await deleteSection("1 OR 1=1");
    await setSectionVisibility("nope", "public");
    await updatePlace("nope", { name: "x" });
    await deletePlace("nope");

    expect(fake.calls.select).toBe(0);
    expect(fake.calls.update).toBe(0);
    expect(fake.calls.delete).toBe(0);
  });
});

/* ============================================================
   SECTIONS
   ============================================================ */

describe("createSection", () => {
  it("writes it against the owner's own house, at the end of its half", async () => {
    room(3, 4);
    fake.queue("insert", { rows: [] });

    const result = await createSection({
      title: "The walk to the beach",
      body: "Five minutes.",
      visibility: "public",
    });

    expect(result).toEqual({ ok: true });

    const values = fake.written.values[0] as Record<string, unknown>;
    expect(values.houseId).toBe(HOUSE_ID);
    expect(values.title).toBe("The walk to the beach");
    expect(values.body).toBe("Five minutes.");
    expect(values.visibility).toBe("public");
    expect(values.position).toBe(4);
  });

  it("keeps a new section private unless it is told otherwise", async () => {
    // A section meant to be public but never flipped is a missing paragraph.
    // A section meant to be private but never flipped is the door code, in a
    // group chat. Only one of those is recoverable.
    room();
    fake.queue("insert", { rows: [] });

    await createSection({ title: "The lockbox" });

    expect((fake.written.values[0] as Record<string, unknown>).visibility).toBe(
      "guests",
    );
  });

  it("takes a title with no body — that is what the prompt asks for", async () => {
    room();
    fake.queue("insert", { rows: [] });

    const result = await createSection({ title: "The wifi" });

    expect(result).toEqual({ ok: true });
    expect((fake.written.values[0] as Record<string, unknown>).body).toBe("");
  });

  it("refuses a blank title before it writes anything", async () => {
    const result = await createSection({ title: "   " });

    expect(result.ok).toBe(false);
    expect(fake.calls.insert).toBe(0);
  });

  it("refuses once the guide is full", async () => {
    fake.queue("select", { rows: [{ count: 40 }] });

    const result = await createSection({ title: "One more" });

    expect(result.ok).toBe(false);
    expect(fake.calls.insert).toBe(0);
  });
});

describe("updateSection", () => {
  it("writes only what the patch mentions", async () => {
    touched("update");

    await updateSection(SECTION_ID, { body: "Rewritten." });

    expect(fake.written.set[0]).toEqual({ body: "Rewritten." });
  });

  it("will not move a section across the split", async () => {
    // setSectionVisibility owns that, because crossing also has to renumber.
    touched("update");

    await updateSection(SECTION_ID, {
      title: "Still here",
      visibility: "public",
    });

    expect(fake.written.set[0]).toEqual({ title: "Still here" });
  });

  it("does nothing at all for an empty patch", async () => {
    expect(await updateSection(SECTION_ID, {})).toEqual({ ok: true });
    expect(fake.calls.update).toBe(0);
  });

  it("refuses a body longer than the column should hold", async () => {
    const result = await updateSection(SECTION_ID, { body: "x".repeat(5001) });

    expect(result.ok).toBe(false);
    expect(fake.calls.update).toBe(0);
  });
});

describe("setSectionVisibility", () => {
  it("moves the section to the end of the half it lands in", async () => {
    fake.queue("select", { rows: [{ visibility: "guests" }] });
    fake.queue("select", { rows: [{ next: 6 }] });
    fake.queue("update", { rows: [] });

    const result = await setSectionVisibility(SECTION_ID, "public");

    expect(result).toEqual({ ok: true });
    expect(fake.written.set[0]).toEqual({ visibility: "public", position: 6 });
  });

  it("does not write when it is already on that side", async () => {
    fake.queue("select", { rows: [{ visibility: "public" }] });

    expect(await setSectionVisibility(SECTION_ID, "public")).toEqual({ ok: true });
    expect(fake.calls.update).toBe(0);
  });

  it("refuses a visibility the schema does not have", async () => {
    const result = await setSectionVisibility(
      SECTION_ID,
      "everyone" as unknown as "public",
    );

    expect(result.ok).toBe(false);
    expect(fake.calls.select).toBe(0);
  });
});

describe("toggleSectionVisibility", () => {
  it("turns a public section private", async () => {
    fake.queue("select", { rows: [{ visibility: "public" }] });
    fake.queue("select", { rows: [{ visibility: "public" }] });
    fake.queue("select", { rows: [{ next: 2 }] });
    fake.queue("update", { rows: [] });

    const result = await toggleSectionVisibility(SECTION_ID);

    expect(result).toEqual({ ok: true });
    expect(fake.written.set[0]).toEqual({ visibility: "guests", position: 2 });
  });

  it("refuses a section that is not on the owner's house", async () => {
    fake.queue("select", { rows: [] });

    expect((await toggleSectionVisibility(OTHER_ID)).ok).toBe(false);
    expect(fake.calls.update).toBe(0);
  });
});

describe("deleteSection", () => {
  it("deletes the row, then the files behind its photos", async () => {
    fake.queue("select", { rows: [{ pathname: "houses/x/a.jpg" }] });
    touched("delete");

    const result = await deleteSection(SECTION_ID);

    expect(result).toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith("houses/x/a.jpg");
  });

  it("leaves the files alone when the row was not the owner's", async () => {
    fake.queue("select", { rows: [{ pathname: "houses/x/a.jpg" }] });
    missed("delete");

    expect((await deleteSection(OTHER_ID)).ok).toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe("reorderSections", () => {
  it("writes the new order in one statement", async () => {
    fake.queue("select", { rows: [{ id: SECTION_ID }, { id: PLACE_ID }] });
    fake.queue("execute", { rows: [] });

    const result = await reorderSections("public", [PLACE_ID, SECTION_ID]);

    expect(result).toEqual({ ok: true });
    expect(fake.calls.execute).toBe(1);
  });

  it("refuses a list that is no longer the list", async () => {
    // Something was added or deleted in another tab. Writing half an order is
    // worse than saying so.
    fake.queue("select", { rows: [{ id: SECTION_ID }, { id: PLACE_ID }] });

    const result = await reorderSections("public", [SECTION_ID]);

    expect(result.ok).toBe(false);
    expect(fake.calls.execute).toBe(0);
  });

  it("refuses a list with the same id twice", async () => {
    fake.queue("select", { rows: [{ id: SECTION_ID }, { id: PLACE_ID }] });

    const result = await reorderSections("public", [SECTION_ID, SECTION_ID]);

    expect(result.ok).toBe(false);
    expect(fake.calls.execute).toBe(0);
  });

  it("only ever reorders one half — the other keeps its own numbers", async () => {
    fake.queue("select", { rows: [{ id: SECTION_ID }] });
    fake.queue("execute", { rows: [] });

    await reorderSections("guests", [SECTION_ID]);

    expect(fake.calls.execute).toBe(1);
  });
});

/* ============================================================
   PLACES
   ============================================================ */

describe("createPlace", () => {
  it("writes a place with the owner's house on it", async () => {
    room(2, 3);
    fake.queue("insert", { rows: [] });

    const result = await createPlace({
      name: "Ali'nin Yeri",
      category: "eat",
      note: "Grilled fish.",
      mapUrl: "https://maps.google.com/?q=ali",
    });

    expect(result).toEqual({ ok: true });

    const values = fake.written.values[0] as Record<string, unknown>;
    expect(values.houseId).toBe(HOUSE_ID);
    expect(values.category).toBe("eat");
    expect(values.position).toBe(3);
    expect(values.mapUrl).toBe("https://maps.google.com/?q=ali");
  });

  it("stores an empty note and an empty link as nothing", async () => {
    room();
    fake.queue("insert", { rows: [] });

    await createPlace({ name: "The cove", category: "beach", note: "", mapUrl: "" });

    const values = fake.written.values[0] as Record<string, unknown>;
    expect(values.note).toBeNull();
    expect(values.mapUrl).toBeNull();
  });

  it("refuses a category the schema does not have", async () => {
    const result = await createPlace({
      name: "Somewhere",
      category: "nightlife" as unknown as "eat",
    });

    expect(result.ok).toBe(false);
    expect(fake.calls.insert).toBe(0);
  });

  it("refuses a map link that is not a link", async () => {
    const result = await createPlace({
      name: "Somewhere",
      category: "eat",
      mapUrl: "ask me and I will show you",
    });

    expect(result.ok).toBe(false);
    expect(fake.calls.insert).toBe(0);
  });
});

describe("reorderPlaces", () => {
  it("takes an empty list without writing anything", async () => {
    fake.queue("select", { rows: [] });

    expect(await reorderPlaces([])).toEqual({ ok: true });
    expect(fake.calls.execute).toBe(0);
  });
});

/* ============================================================
   THE PASTED DRAFT
   ============================================================ */

describe("saveGuideDraft", () => {
  /** The five reads a save makes before it writes: two counts, three maxes. */
  function counts(sections = 0, spots = 0, publicNext = 0, guestsNext = 0, placeNext = 0) {
    fake.queue("select", { rows: [{ count: sections }] });
    fake.queue("select", { rows: [{ count: spots }] });
    fake.queue("select", { rows: [{ next: publicNext }] });
    fake.queue("select", { rows: [{ next: guestsNext }] });
    fake.queue("select", { rows: [{ next: placeNext }] });
  }

  const DRAFT = {
    sections: [
      { title: "The town", body: "Small and white.", visibility: "public" as const },
      { title: "The wifi", body: "", visibility: "guests" as const },
      { title: "The beach", body: "Five minutes.", visibility: "public" as const },
    ],
    places: [
      {
        name: "Ali'nin Yeri",
        category: "eat" as const,
        note: "Fish.",
        mapUrl: null,
      },
    ],
  };

  it("adds the draft to what is already there, never in place of it", async () => {
    // Nothing is deleted. A second run of the prompt leaves the owner with two
    // of everything — one delete each — rather than with a model's second
    // opinion where their own first one used to be.
    counts(2, 1, 2, 1, 1);
    fake.queue("insert", { rows: [] });
    fake.queue("insert", { rows: [] });

    const result = await saveGuideDraft(DRAFT);

    expect(result).toEqual({ ok: true });
    expect(fake.calls.delete).toBe(0);
  });

  it("numbers each half from where that half already ended", async () => {
    counts(2, 1, 2, 1, 1);
    fake.queue("insert", { rows: [] });
    fake.queue("insert", { rows: [] });

    await saveGuideDraft(DRAFT);

    const sections = fake.written.values[0] as Record<string, unknown>[];
    expect(sections.map((row) => [row.visibility, row.position])).toEqual([
      ["public", 2],
      ["guests", 1],
      ["public", 3],
    ]);

    const places = fake.written.values[1] as Record<string, unknown>[];
    expect(places[0].position).toBe(1);
    expect(places[0].houseId).toBe(HOUSE_ID);
  });

  it("keeps the order the owner reviewed them in", async () => {
    counts();
    fake.queue("insert", { rows: [] });
    fake.queue("insert", { rows: [] });

    await saveGuideDraft(DRAFT);

    const sections = fake.written.values[0] as Record<string, unknown>[];
    expect(sections.map((row) => row.title)).toEqual([
      "The town",
      "The wifi",
      "The beach",
    ]);
  });

  it("does nothing, and says nothing, for an empty draft", async () => {
    const result = await saveGuideDraft({ sections: [], places: [] });

    expect(result).toEqual({ ok: true });
    expect(fake.calls.select).toBe(0);
    expect(fake.calls.insert).toBe(0);
  });

  it("refuses a draft that would take the guide past its limit", async () => {
    fake.queue("select", { rows: [{ count: 39 }] });
    fake.queue("select", { rows: [{ count: 0 }] });

    const result = await saveGuideDraft(DRAFT);

    expect(result.ok).toBe(false);
    expect(fake.calls.insert).toBe(0);
  });

  it("refuses the whole draft rather than half of it", async () => {
    // One bad section is a thing the owner fixes on screen. Saving the good
    // ones and quietly discarding the rest is not.
    const result = await saveGuideDraft({
      sections: [
        { title: "Fine", body: "Fine.", visibility: "public" },
        { title: "", body: "Has no title.", visibility: "public" },
      ],
      places: [],
    });

    expect(result.ok).toBe(false);
    expect(fake.calls.insert).toBe(0);
  });
});

/* ============================================================
   EVERY ACTION
   ============================================================ */

describe("every action", () => {
  it("goes through requireHouse before it does anything else", async () => {
    const runs: [string, () => Promise<ActionResult>][] = [
      ["createSection", () => createSection({ title: "x" })],
      ["updateSection", () => updateSection(SECTION_ID, { title: "x" })],
      ["setSectionVisibility", () => setSectionVisibility(SECTION_ID, "public")],
      ["toggleSectionVisibility", () => toggleSectionVisibility(SECTION_ID)],
      ["deleteSection", () => deleteSection(SECTION_ID)],
      ["reorderSections", () => reorderSections("public", [])],
      ["createPlace", () => createPlace({ name: "x", category: "eat" })],
      ["updatePlace", () => updatePlace(PLACE_ID, { name: "x" })],
      ["deletePlace", () => deletePlace(PLACE_ID)],
      ["reorderPlaces", () => reorderPlaces([])],
      ["saveGuideDraft", () => saveGuideDraft({ sections: [], places: [] })],
    ];

    for (const [name, run] of runs) {
      fake.reset();
      vi.mocked(requireHouse).mockClear();
      await run();
      expect(vi.mocked(requireHouse), name).toHaveBeenCalledTimes(1);
    }
  });

  it("refreshes the owner's screens, the house page, and every guest's page", async () => {
    // The guests-only half is rendered on /b/[token] and nowhere else, and it
    // is the same sections for every confirmed guest — so the route goes, not
    // one booking.
    room();
    fake.queue("insert", { rows: [] });

    await createSection({ title: "The wifi" });

    expect(revalidatePath).toHaveBeenCalledWith("/app", "layout");
    expect(revalidatePath).toHaveBeenCalledWith(`/h/${HOUSE.slug}`);
    expect(revalidatePath).toHaveBeenCalledWith("/b/[token]", "page");
  });

  it("writes copy that does not apologise", async () => {
    const refusals: string[] = [];

    refusals.push(message(await createSection({ title: "" })));
    refusals.push(message(await updateSection("nope", { title: "x" })));
    refusals.push(
      message(await createPlace({ name: "x", category: "nope" as unknown as "eat" })),
    );
    refusals.push(message(await deletePlace("nope")));

    fake.queue("select", { rows: [{ id: SECTION_ID }] });
    refusals.push(message(await reorderSections("public", [PLACE_ID])));

    for (const refusal of refusals) {
      expect(refusal, "apologises").not.toMatch(/sorry|unfortunately|oops|error/i);
      expect(refusal, "uses a word this product does not").not.toMatch(
        /reservation|property|availability|listing|occupancy|check-in/i,
      );
      expect(refusal.length, "too short to be a sentence").toBeGreaterThan(10);
      expect(refusal.trim().endsWith("."), `${refusal} is not a sentence`).toBe(true);
    }
  });
});

function message(result: ActionResult): string {
  if (result.ok) throw new Error("expected a refusal");
  return result.error;
}
