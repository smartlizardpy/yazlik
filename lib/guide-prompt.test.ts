/**
 * The prompt the owner copies.
 *
 * Two things are worth testing here and the rest is prose.
 *
 * 1. **It is about this house.** The whole reason to build a prompt rather than
 *    print one is that the town's name is in it. A prompt that came back
 *    identical for two different houses would be a paragraph of static text
 *    with extra steps.
 * 2. **The format it demands is the format the parser reads.** The two files
 *    are one contract, and the cheapest way to keep them honest is to feed the
 *    prompt's own worked example straight into `parseGuideReply` and check it
 *    comes out as the section and the place it describes. If someone edits the
 *    example without editing the parser, this fails.
 */

import { describe, expect, it } from "vitest";

import { buildGuidePrompt, type GuidePromptHouse } from "@/lib/guide-prompt";
import { parseGuideReply } from "@/lib/guide-parse";

const HOUSE: GuidePromptHouse = {
  name: "Çeşme evi",
  town: "Çeşme",
  country: "Türkiye",
  language: "tr",
  blurb: "İncir ağacı var, denize beş dakika.",
  maxGuests: 6,
  bookableFrom: "2026-06-01",
  bookableTo: "2026-09-30",
};

const house = (patch: Partial<GuidePromptHouse> = {}): GuidePromptHouse => ({
  ...HOUSE,
  ...patch,
});

/* ============================================================
   THE HOUSE IS IN IT
   ============================================================ */

describe("buildGuidePrompt: this house, not a house", () => {
  it("names the house, the town and the country", () => {
    const prompt = buildGuidePrompt(HOUSE);

    expect(prompt).toContain("Çeşme evi");
    expect(prompt).toContain("Çeşme");
    expect(prompt).toContain("Türkiye");
  });

  it("says the town again where it matters — in the instructions", () => {
    // The town appearing once, in a facts block at the top, is what produces a
    // travel post with a place name pasted in. It has to be the subject of the
    // instruction as well.
    const prompt = buildGuidePrompt(HOUSE);
    const mentions = prompt.split("Çeşme").length - 1;
    expect(mentions).toBeGreaterThan(3);
  });

  it("carries the owner's own words when there are any", () => {
    expect(buildGuidePrompt(HOUSE)).toContain("İncir ağacı var, denize beş dakika.");
  });

  it("leaves the line out entirely when the blurb is empty", () => {
    for (const blurb of [null, "", "   "]) {
      const prompt = buildGuidePrompt(house({ blurb }));
      expect(prompt).not.toContain("How the owner describes it");
    }
  });

  it("says how many the house sleeps", () => {
    expect(buildGuidePrompt(house({ maxGuests: 11 }))).toContain("Sleeps: 11");
  });

  it("writes the same prompt twice for the same house", () => {
    // Nothing here reads a clock or draws a number. A prompt in a screenshot
    // has to be the prompt the next person gets.
    expect(buildGuidePrompt(HOUSE)).toBe(buildGuidePrompt(HOUSE));
  });
});

/* ============================================================
   THE SEASON
   ============================================================ */

describe("buildGuidePrompt: the season, in months", () => {
  it("says both ends", () => {
    expect(buildGuidePrompt(HOUSE)).toContain("Open: June to September");
  });

  it("says one month when the season opens and closes in it", () => {
    expect(
      buildGuidePrompt(house({ bookableFrom: "2026-08-01", bookableTo: "2026-08-31" })),
    ).toContain("Open: August");
  });

  it("says an open-ended season from one side", () => {
    expect(buildGuidePrompt(house({ bookableTo: null }))).toContain(
      "Open: June onwards",
    );
    expect(buildGuidePrompt(house({ bookableFrom: null }))).toContain(
      "Open: up to the end of September",
    );
  });

  it("says all year when there is no season at all", () => {
    expect(
      buildGuidePrompt(house({ bookableFrom: null, bookableTo: null })),
    ).toContain("Open: all year");
  });

  it("does not choke on a bound that is not a date", () => {
    expect(
      buildGuidePrompt(house({ bookableFrom: "soon", bookableTo: null })),
    ).toContain("Open: all year");
  });
});

/* ============================================================
   THE LANGUAGE
   ============================================================ */

describe("buildGuidePrompt: the guide's language", () => {
  it("asks for a Turkish guide for a Turkish house", () => {
    expect(buildGuidePrompt(HOUSE)).toContain("Write the guide in Turkish");
  });

  it("asks for an English one for an English house", () => {
    expect(buildGuidePrompt(house({ language: "en" }))).toContain(
      "Write the guide in English",
    );
  });

  it("keeps the markers out of the translation, whatever the language", () => {
    // The parser reads English markers. A model that helpfully translates
    // TITLE: costs the owner their draft, so the prompt says so explicitly.
    const prompt = buildGuidePrompt(HOUSE);
    expect(prompt).toContain("English, capitals, on their own lines");
  });
});

/* ============================================================
   WHAT IT FORBIDS
   ============================================================ */

describe("buildGuidePrompt: what it refuses to ask for", () => {
  it("names the marketing words it does not want", () => {
    const prompt = buildGuidePrompt(HOUSE);
    for (const word of ["nestled", "hidden gem", "stunning", "unwind"]) {
      expect(prompt, `${word} is not ruled out`).toContain(word);
    }
    expect(prompt).toContain("No exclamation marks");
  });

  it("tells the model it has never seen the house", () => {
    const prompt = buildGuidePrompt(HOUSE);
    expect(prompt).toContain("Do not invent anything about the house");
    expect(prompt).toContain("wifi");
    expect(prompt).toContain("boiler");
  });

  it("asks for the guests-only half as titles with nothing under them", () => {
    // The address, the key and the boiler are exactly what a model cannot know.
    // Asking for the headings gives the owner a checklist; asking for the
    // paragraphs gives them six confident lies to delete.
    expect(buildGuidePrompt(HOUSE)).toContain(
      "write the TITLE and leave the BODY empty",
    );
  });

  it("does not invent a link for a product with no maps API", () => {
    expect(buildGuidePrompt(HOUSE)).toContain("Leave MAP empty");
  });
});

/* ============================================================
   THE PROMPT IS COPY TOO
   ============================================================ */

describe("buildGuidePrompt: it reads like the rest of the product", () => {
  it("uses none of the words this product does not use", () => {
    const prompt = buildGuidePrompt(HOUSE).toLowerCase();
    for (const word of [
      "reservation",
      "property",
      "availability",
      "listing",
      "occupancy",
      "check-in",
      "submit",
    ]) {
      expect(prompt, `the prompt says "${word}"`).not.toContain(word);
    }
  });

  it("does not shout", () => {
    expect(buildGuidePrompt(HOUSE)).not.toContain("!");
  });
});

/* ============================================================
   THE CONTRACT WITH THE PARSER
   ============================================================ */

describe("the format the prompt asks for", () => {
  it("names every marker and field the parser reads", () => {
    const prompt = buildGuidePrompt(HOUSE);
    for (const token of [
      "[SECTION]",
      "[PLACE]",
      "[END]",
      "TITLE:",
      "VISIBILITY:",
      "BODY:",
      "NAME:",
      "CATEGORY:",
      "NOTE:",
      "MAP:",
    ]) {
      expect(prompt, `${token} is not in the format`).toContain(token);
    }
  });

  it("lists exactly the categories the schema allows", () => {
    expect(buildGuidePrompt(HOUSE)).toContain(
      "one of eat, drink, beach, walk, shop, kids",
    );
  });

  it("lists exactly the two visibilities", () => {
    expect(buildGuidePrompt(HOUSE)).toContain("VISIBILITY is public or guests");
  });

  it("hands the parser a section and a place out of its own example", () => {
    // The example in the prompt, parsed. If this fails the two files have
    // drifted apart and every owner's first paste is the thing that finds out.
    const draft = parseGuideReply(buildGuidePrompt(HOUSE));

    expect(draft.sections[0]).toEqual({
      title: "a few words",
      body: "The text of the section. Plain paragraphs.\nA blank line inside the body is fine.",
      visibility: "public",
    });

    expect(draft.places).toEqual([
      {
        name: "what it is called",
        category: "eat",
        note: "one sentence, or nothing",
        mapUrl: null,
      },
    ]);
  });

  it("keeps the prose around the example out of the blocks", () => {
    // Everything that is not the worked example is instructions, and lands in
    // the leftover rather than halfway into somebody's guide.
    const draft = parseGuideReply(buildGuidePrompt(HOUSE));

    expect(draft.leftover).toContain("WHO READS IT");
    expect(draft.leftover).toContain("RULES FOR THE FORMAT");
    expect(draft.sections[0].body).not.toContain("RULES FOR THE FORMAT");
  });
});
