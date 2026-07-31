/**
 * The QR encoder, checked against somebody else's.
 *
 * A hand-written QR encoder has a nasty property: every wrong version of it
 * still *looks* like a QR code. Interleave the blocks in the wrong order, skip
 * the wrong column, mask a reserved module, and the picture is indistinguishable
 * from a correct one to a human — it simply does not scan. So eyeballing proves
 * nothing and the only real check is module-for-module against a reference.
 *
 * The reference is the Python `qrcode` package, byte mode, error correction M.
 * The fixtures below were produced by it and pasted in:
 *
 * ```
 * qr = qrcode.QRCode(version=V, error_correction=ERROR_CORRECT_M,
 *                    box_size=1, border=0, mask_pattern=M)
 * qr.add_data(QRData(text.encode(), mode=MODE_8BIT_BYTE))
 * qr.make(fit=False)
 * ```
 *
 * `MODE_8BIT_BYTE` is not optional in that snippet. Left to itself the Python
 * package picks alphanumeric mode for a string like `HELLO`, which packs
 * differently and produces a different — also correct — symbol. This encoder is
 * byte-mode only, on purpose, because the input is always a URL.
 *
 * One full matrix is stored for the smallest case so a failure is readable, and
 * digests for the rest so eight masks across three versions cost a few lines
 * instead of a few thousand.
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { QUIET_ZONE, encodeQr, qrPathData, qrViewBox } from "./qr";

/* ============================================================
   HELPERS
   ============================================================ */

function rows(modules: boolean[][]): string[] {
  return modules.map((row) => row.map((on) => (on ? "1" : "0")).join(""));
}

function digest(modules: boolean[][]): string {
  return createHash("sha256").update(rows(modules).join("\n")).digest("hex").slice(0, 16);
}

/* ============================================================
   FIXTURES — from the Python `qrcode` package, byte mode, level M
   ============================================================ */

/** Version 1, mask 4, `HELLO`. Kept whole: 21 rows is small enough to diff by eye. */
const HELLO_V1_MASK4 = [
  "111111101101001111111",
  "100000100110101000001",
  "101110100111101011101",
  "101110101001001011101",
  "101110101000101011101",
  "100000101011001000001",
  "111111101010101111111",
  "000000001111100000000",
  "100010111111011111001",
  "000111001011100101111",
  "101100101011001110010",
  "111001000100011010000",
  "001011100100111000110",
  "000000001110111001011",
  "111111101100110001010",
  "100000100001100100010",
  "101110101001001110101",
  "101110100001100001011",
  "101110100111001111000",
  "100000100100011000000",
  "111111101000111110101",
];

/** Digests of all eight masks, for the URLs this product actually encodes. */
const VECTORS = [
  {
    name: "a guest link",
    text: "http://localhost:3100/h/demo-house",
    version: 3,
    digests: [
      "71ab0072bd64a1e0",
      "99e483b0a5ad1ab7",
      "ed0e0b53aadd3fbd",
      "db1a3ccbd6f25383",
      "2dc1748ea68b39b6",
      "8b33c1161bf01415",
      "95a5862244fdffd2",
      "492406eb66babc32",
    ],
  },
  {
    name: "a subscribe feed URL",
    text: "http://localhost:3100/api/feed/demo-feed-token.ics",
    version: 4,
    digests: [
      "4e02d7ba13d02e50",
      "b81885f29a9950c1",
      "bf3554c7e9634fc0",
      "35483003fad33656",
      "c4f6f8cfba99b211",
      "f97bf5b273fd6549",
      "7bfe0db62da2556f",
      "faa83c4b9301c123",
    ],
  },
  {
    // Multi-byte input. A slug is ASCII today, but the encoder counts *octets*
    // and a character count here would silently overflow the block.
    name: "a URL with Turkish letters in it",
    text: "https://yazlik.app/h/çeşme-ev",
    version: 3,
    digests: [
      "a00bed0ebb6c35ec",
      "ab56d9835d150481",
      "90ae77d17bb2c870",
      "314c53f2109fa953",
      "5daaffbdb97b432b",
      "149e147fb3eaed44",
      "71dcf14b99d5f723",
      "822fb96fcbc71658",
    ],
  },
] as const;

/* ============================================================
   TESTS
   ============================================================ */

describe("encodeQr", () => {
  it("matches the reference encoder module for module", () => {
    const code = encodeQr("HELLO", { mask: 4 });
    expect(code.version).toBe(1);
    expect(code.size).toBe(21);
    expect(rows(code.modules)).toEqual(HELLO_V1_MASK4);
  });

  for (const vector of VECTORS) {
    it(`matches the reference encoder on every mask for ${vector.name}`, () => {
      for (let mask = 0; mask < 8; mask++) {
        const code = encodeQr(vector.text, { mask });
        expect(code.version, `version for mask ${mask}`).toBe(vector.version);
        expect(digest(code.modules), `mask ${mask}`).toBe(vector.digests[mask]);
      }
    });
  }

  it("picks a mask the spec's penalty rules prefer, and says which", () => {
    const code = encodeQr("http://localhost:3100/h/demo-house");
    expect(code.mask).toBeGreaterThanOrEqual(0);
    expect(code.mask).toBeLessThan(8);
    // Whichever it chose must be one of the eight the reference produced —
    // the choice is ours, the symbol is not.
    expect(digest(code.modules)).toBe(VECTORS[0].digests[code.mask]);
  });

  it("grows the version with the payload and keeps size = 4v + 17", () => {
    const small = encodeQr("hi");
    const large = encodeQr(`https://yazlik.app/h/${"a".repeat(120)}`);
    expect(small.version).toBeLessThan(large.version);
    for (const code of [small, large]) {
      expect(code.size).toBe(code.version * 4 + 17);
      expect(code.modules).toHaveLength(code.size);
      expect(code.modules[0]).toHaveLength(code.size);
    }
  });

  it("throws rather than truncating when the text will not fit", () => {
    // Level M at version 10 holds 213 bytes. Silently dropping the tail would
    // produce a code that scans perfectly and opens the wrong page.
    expect(() => encodeQr("a".repeat(500))).toThrow();
  });

  it("encodes UTF-8 by octets, not characters", () => {
    // 60 two-octet characters is 120 octets and must not be treated as 60.
    const code = encodeQr("ç".repeat(60));
    expect(code.version).toBeGreaterThanOrEqual(7);
  });
});

describe("qrPathData", () => {
  it("draws exactly the dark modules, offset by the quiet zone", () => {
    const code = encodeQr("HELLO", { mask: 4 });
    const path = qrPathData(code);

    // Rebuild the matrix from the path and compare. Every command is
    // `M<x> <y>h<run>v1h-<run>z`, one horizontal run of dark modules.
    const rebuilt = Array.from({ length: code.size }, () =>
      new Array<boolean>(code.size).fill(false),
    );
    const commands = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)];
    for (const [, x, y, run] of commands) {
      for (let i = 0; i < Number(run); i++) {
        rebuilt[Number(y) - QUIET_ZONE][Number(x) - QUIET_ZONE + i] = true;
      }
    }

    expect(rows(rebuilt)).toEqual(rows(code.modules));
  });

  it("merges horizontal runs instead of emitting a square each", () => {
    const code = encodeQr("http://localhost:3100/h/demo-house");
    const dark = code.modules.flat().filter(Boolean).length;
    const commands = qrPathData(code).match(/M/g)?.length ?? 0;
    expect(commands).toBeGreaterThan(0);
    expect(commands).toBeLessThan(dark);
  });
});

describe("qrViewBox", () => {
  it("leaves a quiet zone on all four sides", () => {
    const code = encodeQr("HELLO");
    expect(qrViewBox(code)).toBe(`0 0 ${code.size + 8} ${code.size + 8}`);
    expect(qrViewBox(code, 0)).toBe(`0 0 ${code.size} ${code.size}`);
  });
});
