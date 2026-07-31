/**
 * Reading back what a model wrote.
 *
 * This is the file that matters most in the guide. Everything else in the
 * feature can be retried; a paragraph that fell out of a parse is gone, and the
 * owner has no way of knowing it was ever there. So the shape of these tests is
 * deliberate: a handful check that a well-behaved reply comes out clean, and
 * the rest are all the ways a real paste is *not* well-behaved — a code fence,
 * a preamble, a sign-off, bold markers, smart quotes, Turkish field names, a
 * block that is missing the one field it needed.
 *
 * The last group is the promise: **nothing is silently dropped**. Every one of
 * those tests looks for the exact junk text somewhere the owner will see it.
 */

import { describe, expect, it } from "vitest";

import { parseGuideReply, type GuideDraft } from "@/lib/guide-parse";
import { t } from "@/lib/i18n";

/** Every word the owner would be shown, titles included. */
function shown(draft: GuideDraft): string {
  return draft.sections
    .map((section) => `${section.title}\n${section.body}`)
    .join("\n\n");
}

/* ============================================================
   THE REPLY AS ASKED FOR
   ============================================================ */

const CLEAN = `[SECTION]
TITLE: The walk to the beach
VISIBILITY: public
BODY:
Down the lane, past the fig tree, then left at the water tank. Five minutes.

Quiet before ten, busy after.

[SECTION]
TITLE: Getting in
VISIBILITY: guests
BODY:
The key is in the box on the wall by the blue gate.

[PLACE]
NAME: Ali'nin Yeri
CATEGORY: eat
NOTE: Grilled fish, two streets back from the front.
MAP:

[END]`;

describe("a reply in the shape the prompt asked for", () => {
  const draft = parseGuideReply(CLEAN);

  it("reads both sections, in the order they were written", () => {
    expect(draft.sections.map((section) => section.title)).toEqual([
      "The walk to the beach",
      "Getting in",
    ]);
  });

  it("keeps each half on the side of the split it was written for", () => {
    expect(draft.sections[0].visibility).toBe("public");
    expect(draft.sections[1].visibility).toBe("guests");
  });

  it("keeps the blank line inside a body", () => {
    expect(draft.sections[0].body).toBe(
      "Down the lane, past the fig tree, then left at the water tank. Five minutes.\n\nQuiet before ten, busy after.",
    );
  });

  it("reads the place, with an empty MAP as no link", () => {
    expect(draft.places).toEqual([
      {
        name: "Ali'nin Yeri",
        category: "eat",
        note: "Grilled fish, two streets back from the front.",
        mapUrl: null,
      },
    ]);
  });

  it("has nothing left over, so no free-text section appears", () => {
    expect(draft.leftover).toBeNull();
    expect(draft.sections).toHaveLength(2);
  });
});

/* ============================================================
   THE WAYS A REAL PASTE ARRIVES
   ============================================================ */

describe("a reply wrapped in a code fence", () => {
  it("reads exactly as it would without one", () => {
    const fenced = "```markdown\n" + CLEAN + "\n```";
    expect(parseGuideReply(fenced)).toEqual(parseGuideReply(CLEAN));
  });

  it("takes a bare fence and a tilde fence too", () => {
    expect(parseGuideReply("```\n" + CLEAN + "\n```")).toEqual(
      parseGuideReply(CLEAN),
    );
    expect(parseGuideReply("~~~\n" + CLEAN + "\n~~~")).toEqual(
      parseGuideReply(CLEAN),
    );
  });
});

describe("a reply with a chatty preamble and a sign-off", () => {
  const chatty = `Sure — here is a guide for your house. I have kept it short.

${CLEAN}

Let me know if you would like a different tone, or more places.`;

  const draft = parseGuideReply(chatty);

  it("still reads every section and place", () => {
    expect(draft.sections.slice(0, 2).map((section) => section.title)).toEqual([
      "The walk to the beach",
      "Getting in",
    ]);
    expect(draft.places).toHaveLength(1);
  });

  it("keeps the chatter rather than guessing it was noise", () => {
    expect(draft.leftover).toContain("Sure — here is a guide for your house.");
    expect(draft.leftover).toContain("Let me know if you would like");
  });

  it("does not leave the sign-off glued to the last section", () => {
    // [END] is what makes this possible: without it the closing line would be
    // read as another paragraph of "Getting in".
    expect(draft.sections[1].body).toBe(
      "The key is in the box on the wall by the blue gate.",
    );
  });

  it("puts the chatter in a section of its own, at the end", () => {
    const last = draft.sections.at(-1);
    expect(last?.title).toBe(t("guide.leftover.title", "en"));
    expect(draft.sections).toHaveLength(3);
  });
});

describe("markers a model has dressed up", () => {
  it("reads them bold, as headings, or with a colon after", () => {
    const dressed = `## [SECTION]
**TITLE:** Market day
VISIBILITY: public
BODY:
Tuesdays, along the harbour road.

**[PLACE]**
NAME: The Tuesday market
CATEGORY: shop
NOTE: Take a bag.

[END]:`;

    const draft = parseGuideReply(dressed);

    expect(draft.sections).toHaveLength(1);
    expect(draft.sections[0].title).toBe("Market day");
    expect(draft.places[0].name).toBe("The Tuesday market");
    expect(draft.leftover).toBeNull();
  });

  it("survives Windows line endings and a leading byte-order mark", () => {
    const windows = "﻿" + CLEAN.replace(/\n/g, "\r\n");
    expect(parseGuideReply(windows)).toEqual(parseGuideReply(CLEAN));
  });
});

describe("smart quotes and en-dashes", () => {
  const typographic = `[SECTION]
TITLE: “Market day”
VISIBILITY: public
BODY:
The market runs Tuesday – Thursday. Everyone says it’s the best one on the coast.

[PLACE]
NAME: ‘Deniz Kahve’
CATEGORY: drink
NOTE: —
MAP: –

[END]`;

  const draft = parseGuideReply(typographic);

  it("takes the quotation marks off a title", () => {
    expect(draft.sections[0].title).toBe("Market day");
  });

  it("takes them off a name without touching the apostrophe in one", () => {
    expect(draft.places[0].name).toBe("Deniz Kahve");
    expect(parseGuideReply(CLEAN).places[0].name).toBe("Ali'nin Yeri");
  });

  it("leaves the prose exactly as it was written", () => {
    // The body is the owner's text now. Straightening their quotes for them is
    // not this file's business.
    expect(draft.sections[0].body).toBe(
      "The market runs Tuesday – Thursday. Everyone says it’s the best one on the coast.",
    );
  });

  it("reads a lone dash in a field as an empty field", () => {
    expect(draft.places[0].note).toBeNull();
    expect(draft.places[0].mapUrl).toBeNull();
  });
});

/* ============================================================
   THE HALF-WRITTEN AND THE MALFORMED
   ============================================================ */

describe("a section with no body", () => {
  // Not a failure. The prompt asks for the guests-only half exactly this way,
  // because the wifi and the boiler are things only the owner knows.
  const titles = `[SECTION]
TITLE: The wifi
VISIBILITY: guests
BODY:

[SECTION]
TITLE: The bins
VISIBILITY: guests
BODY:
[END]`;

  const draft = parseGuideReply(titles);

  it("keeps the section, with an empty body", () => {
    expect(draft.sections).toEqual([
      { title: "The wifi", body: "", visibility: "guests" },
      { title: "The bins", body: "", visibility: "guests" },
    ]);
  });

  it("does not treat an empty body as something to salvage", () => {
    expect(draft.leftover).toBeNull();
  });
});

describe("a place that did not come out as fields", () => {
  const loose = `[SECTION]
TITLE: Where to eat
VISIBILITY: public
BODY:
There are four or five places on the front.

[PLACE]
- Ali'nin Yeri (fish, on the front, cash only)

[END]`;

  const draft = parseGuideReply(loose);

  it("does not invent a place out of it", () => {
    expect(draft.places).toEqual([]);
  });

  it("keeps every word of it where the owner will see it", () => {
    expect(shown(draft)).toContain("Ali'nin Yeri (fish, on the front, cash only)");
  });

  it("keeps the section that did parse", () => {
    expect(draft.sections[0].title).toBe("Where to eat");
  });
});

describe("a place whose category is not one of the six", () => {
  const draft = parseGuideReply(`[PLACE]
NAME: The blue door
CATEGORY: nightlife
NOTE: Open late, music until two.

[END]`);

  it("refuses to guess which of the six it meant", () => {
    expect(draft.places).toEqual([]);
  });

  it("keeps the name and the note, both", () => {
    const text = shown(draft);
    expect(text).toContain("The blue door");
    expect(text).toContain("Open late, music until two.");
  });
});

describe("a section with no title", () => {
  const draft = parseGuideReply(`[SECTION]
VISIBILITY: public
BODY:
Six paragraphs of perfectly good writing about the town.

[END]`);

  it("keeps the writing rather than the shape", () => {
    expect(draft.sections).toHaveLength(1);
    expect(draft.sections[0].body).toContain(
      "Six paragraphs of perfectly good writing about the town.",
    );
  });
});

/* ============================================================
   THE ONES THAT ARE NOT A REPLY AT ALL
   ============================================================ */

describe("a blob with no format in it anywhere", () => {
  const blob = `Your summer house sounds lovely. Here are some thoughts.

The town is best in early June, before the crowds. Walk down to the water in the
morning and have breakfast by the harbour.`;

  const draft = parseGuideReply(blob);

  it("hands back one section holding all of it", () => {
    expect(draft.sections).toHaveLength(1);
    expect(draft.sections[0].body).toBe(blob.trim());
  });

  it("names it so the owner knows what they are looking at", () => {
    expect(draft.sections[0].title).toBe(t("guide.leftover.title", "en"));
  });

  it("keeps it private until the owner has read it", () => {
    // An unparsed blob can just as easily be the door code as the harbour.
    expect(draft.sections[0].visibility).toBe("guests");
  });

  it("finds no places in it", () => {
    expect(draft.places).toEqual([]);
  });
});

describe("an empty paste", () => {
  it.each(["", "   ", "\n\n  \n"])(
    "is an empty draft, not an error and not a leftover",
    (empty) => {
      expect(parseGuideReply(empty)).toEqual({
        sections: [],
        places: [],
        leftover: null,
      });
    },
  );

  it("does not fall over on something that is not a string", () => {
    expect(parseGuideReply(undefined as unknown as string)).toEqual({
      sections: [],
      places: [],
      leftover: null,
    });
  });
});

/* ============================================================
   TURKISH
   ============================================================ */

describe("a reply in Turkish", () => {
  const turkish = `[SECTION]
TITLE: Sabah pazarı
VISIBILITY: public
BODY:
Pazar salı günleri kuruluyor. Erken gidin, on birden sonra kalabalık oluyor.

[PLACE]
NAME: Deniz Lokantası
CATEGORY: eat
NOTE: Balık iyi, masa ayırtmaya gerek yok.
MAP:

[END]`;

  it("reads it exactly as it reads an English one", () => {
    const draft = parseGuideReply(turkish, { lang: "tr" });

    expect(draft.sections).toEqual([
      {
        title: "Sabah pazarı",
        body: "Pazar salı günleri kuruluyor. Erken gidin, on birden sonra kalabalık oluyor.",
        visibility: "public",
      },
    ]);
    expect(draft.places[0].name).toBe("Deniz Lokantası");
    expect(draft.leftover).toBeNull();
  });

  it("takes the markers and the fields in Turkish when a model translates them", () => {
    // The prompt says to leave them in English. Models mostly do. The ones that
    // do not are not a reason to lose somebody's guide.
    const translated = `[BÖLÜM]
BAŞLIK: Sabah pazarı
GÖRÜNÜRLÜK: herkes
METİN:
Pazar salı günleri kuruluyor.

[YER]
İSİM: Deniz Lokantası
KATEGORİ: yemek
NOT: Balık iyi.
HARİTA:

[SON]`;

    const draft = parseGuideReply(translated, { lang: "tr" });

    expect(draft.sections).toEqual([
      {
        title: "Sabah pazarı",
        body: "Pazar salı günleri kuruluyor.",
        visibility: "public",
      },
    ]);
    expect(draft.places).toEqual([
      {
        name: "Deniz Lokantası",
        category: "eat",
        note: "Balık iyi.",
        mapUrl: null,
      },
    ]);
  });

  it("titles the leftover section in the house's language", () => {
    const draft = parseGuideReply("Buyurun, evinizin rehberi.", { lang: "tr" });

    expect(draft.sections[0].title).toBe(t("guide.leftover.title", "tr"));
    expect(draft.sections[0].title).not.toBe(t("guide.leftover.title", "en"));
  });
});

/* ============================================================
   VISIBILITY
   ============================================================ */

describe("who reads a section", () => {
  function visibilityOf(line: string) {
    return parseGuideReply(`[SECTION]
TITLE: A section
${line}
BODY:
Something.`).sections[0].visibility;
  }

  it.each([
    ["VISIBILITY: public", "public"],
    ["VISIBILITY: Public", "public"],
    ["VISIBILITY: everyone", "public"],
    ["VISIBILITY: herkes", "public"],
    ["VISIBILITY: public — anyone with the link", "public"],
    ["VISIBILITY: guests", "guests"],
    ["VISIBILITY: guests only", "guests"],
    ["VISIBILITY: private", "guests"],
    ["VISIBILITY: misafirler", "guests"],
  ] as const)("reads %s as %s", (line, expected) => {
    expect(visibilityOf(line)).toBe(expected);
  });

  it("leans private when the value is not one it knows", () => {
    expect(visibilityOf("VISIBILITY: maybe")).toBe("guests");
  });

  it("leans private when there is no visibility at all", () => {
    // A section wrongly kept private is a tap to fix. A section wrongly made
    // public is the promise this product cannot break.
    const draft = parseGuideReply(`[SECTION]
TITLE: The lockbox
BODY:
The code is 4471.`);

    expect(draft.sections[0].visibility).toBe("guests");
  });
});

/* ============================================================
   CATEGORIES AND LINKS
   ============================================================ */

describe("what kind of place it is", () => {
  function categoryOf(value: string) {
    return parseGuideReply(`[PLACE]
NAME: Somewhere
CATEGORY: ${value}`).places[0]?.category;
  }

  it.each([
    ["eat", "eat"],
    ["Restaurant", "eat"],
    ["yemek", "eat"],
    ["cafe", "drink"],
    ["içecek", "drink"],
    ["beach", "beach"],
    ["plaj", "beach"],
    ["walk", "walk"],
    ["yürüyüş", "walk"],
    ["market", "shop"],
    ["alışveriş", "shop"],
    ["children", "kids"],
    ["çocuk", "kids"],
    ["eat (food)", "eat"],
  ] as const)("reads %s as %s", (value, expected) => {
    expect(categoryOf(value)).toBe(expected);
  });
});

describe("the map link", () => {
  function mapOf(value: string) {
    return parseGuideReply(`[PLACE]
NAME: Somewhere
CATEGORY: eat
MAP: ${value}`).places[0].mapUrl;
  }

  it("keeps a link a model wrote anyway", () => {
    expect(mapOf("https://maps.google.com/?q=cesme")).toBe(
      "https://maps.google.com/?q=cesme",
    );
  });

  it("unwraps a markdown link and an angled one", () => {
    expect(mapOf("[Ali'nin Yeri](https://maps.google.com/?q=ali)")).toBe(
      "https://maps.google.com/?q=ali",
    );
    expect(mapOf("<https://maps.google.com/?q=ali>")).toBe(
      "https://maps.google.com/?q=ali",
    );
  });

  it.each(["", "-", "n/a", "yok", "search for it on Google Maps"])(
    "reads %s as no link, because the field is a URL and not prose",
    (value) => {
      expect(mapOf(value)).toBeNull();
    },
  );
});

/* ============================================================
   THE BODY IS PROSE, NOT MORE FIELDS
   ============================================================ */

describe("everything after BODY: is the body", () => {
  it("does not mistake a line in the body for a field", () => {
    // This is the arrival packet's whole vocabulary: "Wifi: something",
    // "Bins: Tuesday". A parser that kept reading fields would eat all of it.
    const draft = parseGuideReply(`[SECTION]
TITLE: Getting in
VISIBILITY: guests
BODY:
Wifi: yazlik2026
Bins: Tuesday morning, the green one.
The key is under the pot by the door.`);

    expect(draft.sections[0].body).toBe(
      "Wifi: yazlik2026\nBins: Tuesday morning, the green one.\nThe key is under the pot by the door.",
    );
    expect(draft.leftover).toBeNull();
  });

  it("keeps a stray line that arrived before the body", () => {
    const draft = parseGuideReply(`[SECTION]
TITLE: The lane
This line was never asked for.
VISIBILITY: public
BODY:
The lane runs down to the water.`);

    expect(draft.sections[0].body).toBe(
      "This line was never asked for.\nThe lane runs down to the water.",
    );
  });
});

/* ============================================================
   THE PROMISE
   ============================================================ */

describe("nothing is silently dropped", () => {
  it("keeps the junk out of a reply that is half good and half not", () => {
    const messy = `Here you go!

[SECTION]
TITLE: The town
VISIBILITY: public
BODY:
Small, white, and on a hill above the water.

[PLACE]
CATEGORY: eat
NOTE: The one with the blue chairs, but I forget what it is called.

[SECTION]
BODY:
This paragraph never got a title and would be easy to lose.

[END]

Hope that helps — happy to write more.`;

    const draft = parseGuideReply(messy);
    const text = shown(draft);

    for (const survivor of [
      "Here you go!",
      "The one with the blue chairs, but I forget what it is called.",
      "This paragraph never got a title and would be easy to lose.",
      "Hope that helps",
    ]) {
      expect(text, `"${survivor}" was dropped`).toContain(survivor);
    }

    // And the half that was well-formed is still a section of its own.
    expect(draft.sections[0]).toEqual({
      title: "The town",
      body: "Small, white, and on a hill above the water.",
      visibility: "public",
    });
  });

  it("puts everything it could not place in one section, last", () => {
    const draft = parseGuideReply(`Preamble.

[SECTION]
TITLE: Kept
VISIBILITY: public
BODY:
Kept.

[PLACE]
NOTE: dropped nowhere

[END]

Sign-off.`);

    expect(draft.sections).toHaveLength(2);
    expect(draft.sections.at(-1)?.body).toContain("Preamble.");
    expect(draft.sections.at(-1)?.body).toContain("dropped nowhere");
    expect(draft.sections.at(-1)?.body).toContain("Sign-off.");
    expect(draft.leftover).toBe(draft.sections.at(-1)?.body);
  });

  it("keeps blocks the model closed with [END] every time", () => {
    // Some models put [END] after each block. Read as "stop here" that would
    // lose everything past the first one.
    const draft = parseGuideReply(`[SECTION]
TITLE: One
VISIBILITY: public
BODY:
First.
[END]

[SECTION]
TITLE: Two
VISIBILITY: public
BODY:
Second.
[END]`);

    expect(draft.sections.map((section) => section.title)).toEqual(["One", "Two"]);
    expect(draft.leftover).toBeNull();
  });
});
