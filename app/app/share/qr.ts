/**
 * A QR encoder, by hand, no dependency.
 *
 * The share screen needs one thing from QR: turn a link into something a second
 * phone can point a camera at. Every npm QR package brings a canvas renderer, a
 * React wrapper, or both, and `package.json` is not mine to edit tonight — so
 * this is the encoder, and nothing else.
 *
 * ### What it does and does not do
 *
 * - **Byte mode only.** Numeric and alphanumeric modes pack tighter, but the
 *   input is always a URL with a lowercase slug in it, which alphanumeric mode
 *   cannot represent anyway. One mode is one code path.
 * - **Error correction level M**, ~15% recovery. L would fit more characters in
 *   a smaller symbol; M is what survives a phone camera at an angle, in a
 *   kitchen, on a screen with a fingerprint on it.
 * - **Versions 1–10**, which at level M hold 213 bytes. The longest URL this
 *   product makes is an origin plus `/h/` plus a 12-character slug. If a caller
 *   ever exceeds that, {@link encodeQr} throws rather than silently truncating.
 *
 * ### Where the bodies are buried
 *
 * Four things decide whether a scanner reads the result, and all four are
 * invisible if you get them wrong — the picture still looks like a QR code:
 *
 * 1. **Interleaving.** Above version 2 the codewords are split into blocks and
 *    then woven back together column-wise. Writing the blocks end to end
 *    produces a symbol that looks perfect and scans as garbage.
 * 2. **Reserved modules.** Finders, timing, alignment, format and version areas
 *    are skipped by the data walk *and* left unmasked. A mask applied over the
 *    timing pattern breaks the scanner's grid lock.
 * 3. **The column-6 skip.** The data walk moves right to left in column pairs
 *    and has to step over the vertical timing pattern.
 * 4. **Mask choice.** All eight are tried and scored by the spec's four penalty
 *    rules. The mask is not decoration: a bad one puts finder-like patterns in
 *    the data area and the scanner locks onto the wrong thing.
 *
 * Verified against the `qrcode` Python package, matrix for matrix, for every
 * mask — see `qr.test.ts`.
 */

/* ============================================================
   GF(256) — THE FIELD REED–SOLOMON LIVES IN
   ============================================================ */

/**
 * The QR primitive polynomial, x^8 + x^4 + x^3 + x^2 + 1. Every QR
 * implementation uses this one; a different polynomial gives a different field
 * and unreadable error correction.
 */
const PRIMITIVE = 0x11d;

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  // Doubled so `EXP[LOG[a] + LOG[b]]` never needs a modulo — the sum of two
  // logs is at most 508.
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** (x − α⁰)(x − α¹)…(x − α^(degree−1)), highest power first. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let d = 0; d < degree; d++) {
    const next = new Uint8Array(poly.length + 1);
    for (let i = 0; i < poly.length; i++) {
      next[i] ^= poly[i];
      next[i + 1] ^= mul(poly[i], EXP[d]);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division; the remainder *is* the error correction. */
function ecCodewords(data: Uint8Array, count: number): Uint8Array {
  const gen = generatorPoly(count);
  const work = new Uint8Array(data.length + count);
  work.set(data);

  for (let i = 0; i < data.length; i++) {
    const factor = work[i];
    if (factor === 0) continue;
    // gen[0] is 1, so this step always zeroes work[i].
    for (let j = 0; j < gen.length; j++) work[i + j] ^= mul(gen[j], factor);
  }

  return work.slice(data.length);
}

/* ============================================================
   THE TABLES
   ============================================================ */

/** How one version splits its codewords, at error correction level M. */
type BlockSpec = {
  ecPerBlock: number;
  groups: ReadonlyArray<{ blocks: number; dataCodewords: number }>;
};

/**
 * ISO/IEC 18004 table 13–22, the level-M rows, versions 1 to 10.
 *
 * Versions 8, 9 and 10 have two groups whose blocks differ in length by one
 * codeword. That is not a typo in the standard and it is what makes
 * interleaving fiddly.
 */
const BLOCKS: Readonly<Record<number, BlockSpec>> = {
  1: { ecPerBlock: 10, groups: [{ blocks: 1, dataCodewords: 16 }] },
  2: { ecPerBlock: 16, groups: [{ blocks: 1, dataCodewords: 28 }] },
  3: { ecPerBlock: 26, groups: [{ blocks: 1, dataCodewords: 44 }] },
  4: { ecPerBlock: 18, groups: [{ blocks: 2, dataCodewords: 32 }] },
  5: { ecPerBlock: 24, groups: [{ blocks: 2, dataCodewords: 43 }] },
  6: { ecPerBlock: 16, groups: [{ blocks: 4, dataCodewords: 27 }] },
  7: { ecPerBlock: 18, groups: [{ blocks: 4, dataCodewords: 31 }] },
  8: {
    ecPerBlock: 22,
    groups: [
      { blocks: 2, dataCodewords: 38 },
      { blocks: 2, dataCodewords: 39 },
    ],
  },
  9: {
    ecPerBlock: 22,
    groups: [
      { blocks: 3, dataCodewords: 36 },
      { blocks: 2, dataCodewords: 37 },
    ],
  },
  10: {
    ecPerBlock: 26,
    groups: [
      { blocks: 4, dataCodewords: 43 },
      { blocks: 1, dataCodewords: 44 },
    ],
  },
};

/** Row and column centres of the alignment patterns. Version 1 has none. */
const ALIGNMENT: Readonly<Record<number, readonly number[]>> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MIN_VERSION = 1;
const MAX_VERSION = 10;

/** Byte mode. */
const MODE_BYTE = 0b0100;

/** Level M is `00` in the format string. Not 2, not 1 — the encoding is its own. */
const EC_LEVEL_M = 0b00;

/** Modules of blank margin around the symbol. The spec says four; scanners agree. */
export const QUIET_ZONE = 4;

/*
 * Remainder bits — the 7 spare modules versions 2 to 6 have after the last
 * codeword — need no code of their own. They are zeros, and `placeCodewords`
 * writes zeros once the bit stream runs out, so the walk fills them on its way
 * past. `applyMask` then masks them like any other data module, which is what
 * the spec asks for. Verified against a reference encoder at versions 3 and 4,
 * where getting this wrong would show.
 */

/** 8 bits up to version 9, 16 from version 10. Getting this wrong shifts everything. */
function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function totalDataCodewords(version: number): number {
  return BLOCKS[version].groups.reduce(
    (sum, group) => sum + group.blocks * group.dataCodewords,
    0,
  );
}

/* ============================================================
   BCH — FORMAT AND VERSION INFORMATION
   ============================================================ */

function bitLength(value: number): number {
  let length = 0;
  let rest = value;
  while (rest !== 0) {
    length++;
    rest >>>= 1;
  }
  return length;
}

/** 15-bit format information: 5 data bits, 10 BCH bits, XOR-masked. */
function formatInfo(mask: number): number {
  const data = (EC_LEVEL_M << 3) | mask;
  let rest = data << 10;
  const g = 0b10100110111;
  while (bitLength(rest) >= 11) rest ^= g << (bitLength(rest) - 11);
  // The XOR stops an all-zero format area, which would look like blank paper.
  return ((data << 10) | rest) ^ 0b101010000010010;
}

/** 18-bit version information. Only versions 7 and up carry it. */
function versionInfo(version: number): number {
  let rest = version << 12;
  const g = 0b1111100100101;
  while (bitLength(rest) >= 13) rest ^= g << (bitLength(rest) - 13);
  return (version << 12) | rest;
}

/* ============================================================
   BITS IN, CODEWORDS OUT
   ============================================================ */

function chooseVersion(byteLength: number): number {
  for (let version = MIN_VERSION; version <= MAX_VERSION; version++) {
    const capacity = totalDataCodewords(version) * 8;
    const needed = 4 + charCountBits(version) + byteLength * 8;
    if (needed <= capacity) return version;
  }
  throw new RangeError(
    `That is too much data for a version ${MAX_VERSION} QR code at level M (${byteLength} bytes).`,
  );
}

/** Mode, length, payload, terminator, byte alignment, then the two pad bytes. */
function dataCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = totalDataCodewords(version);
  const bits: number[] = [];

  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  put(MODE_BYTE, 4);
  put(bytes.length, charCountBits(version));
  for (const byte of bytes) put(byte, 8);

  // Terminator: up to four zeros, fewer if the symbol is nearly full.
  const room = capacity * 8 - bits.length;
  put(0, Math.min(4, room));
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(capacity);
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    codewords[i / 8] = byte;
  }

  // 0b11101100, 0b00010001 alternating — the spec's pad bytes, chosen because
  // they are visually noisy and keep the symbol from going blank.
  const PAD = [0xec, 0x11];
  for (let i = bits.length / 8, p = 0; i < capacity; i++, p++) {
    codewords[i] = PAD[p % 2];
  }

  return codewords;
}

/**
 * Split into blocks, add error correction, weave back together.
 *
 * The weave is the part that matters: all the first data codewords, then all
 * the seconds, and so on — skipping blocks that ran out, because a short block
 * and a long block can differ by one. Then the same over the EC codewords,
 * which are all the same length so no skipping is needed.
 */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const spec = BLOCKS[version];

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];

  let offset = 0;
  for (const group of spec.groups) {
    for (let b = 0; b < group.blocks; b++) {
      const block = data.subarray(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;
      dataBlocks.push(block);
      ecBlocks.push(ecCodewords(block, spec.ecPerBlock));
    }
  }

  const out: number[] = [];

  const longest = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) {
      if (i < block.length) out.push(block[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }

  return Uint8Array.from(out);
}

/* ============================================================
   THE MATRIX
   ============================================================ */

/** A finished symbol. `modules[row][col]` — true is dark. */
export type QrCode = {
  version: number;
  /** Width and height in modules: `4 * version + 17`. */
  size: number;
  /** Which of the eight masks scored best. Useful in tests, nowhere else. */
  mask: number;
  modules: boolean[][];
};

type Grid = { modules: boolean[][]; reserved: boolean[][] };

function blankGrid(size: number): Grid {
  return {
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    reserved: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const { modules, reserved } = grid;
  const size = modules.length;

  // Finders, with their one-module separators. Walking −1…7 draws both at once:
  // inside the 7×7 is the finder, the ring around it is the separator.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = top + dr;
        const c = left + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const ring = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const core = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        modules[r][c] = inside && (ring || core);
        reserved[r][c] = true;
      }
    }
  }

  // Timing patterns. Written across the full row and column; the finder ends
  // are already reserved and are skipped rather than overwritten.
  for (let i = 0; i < size; i++) {
    if (!reserved[6][i]) {
      modules[6][i] = i % 2 === 0;
      reserved[6][i] = true;
    }
    if (!reserved[i][6]) {
      modules[i][6] = i % 2 === 0;
      reserved[i][6] = true;
    }
  }

  // Alignment patterns, except the three centres that would sit on a finder.
  const centres = ALIGNMENT[version];
  const last = size - 7;
  for (const r of centres) {
    for (const c of centres) {
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          modules[r + dr][c + dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          reserved[r + dr][c + dc] = true;
        }
      }
    }
  }

  // The dark module. Always dark, always here, no reason given by the standard.
  modules[size - 8][8] = true;
  reserved[size - 8][8] = true;

  // Format information areas — reserved now, written once the mask is chosen.
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[size - 1 - i][8] = true;
    reserved[8][size - 1 - i] = true;
  }

  // Version information areas, versions 7 and up.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      reserved[a][b] = true;
      reserved[b][a] = true;
    }
  }
}

/**
 * The data walk: column pairs from the right edge leftwards, alternating
 * upward and downward, stepping over the vertical timing pattern at column 6.
 */
function placeCodewords(grid: Grid, codewords: Uint8Array): void {
  const { modules, reserved } = grid;
  const size = modules.length;

  let bit = 0;
  const totalBits = codewords.length * 8;
  const nextBit = () => {
    if (bit >= totalBits) return false; // remainder bits are zeros
    const value = (codewords[bit >>> 3] >>> (7 - (bit & 7))) & 1;
    bit++;
    return value === 1;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // column 6 is timing; the pair shifts left
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const col = right - k;
        if (reserved[row][col]) continue;
        modules[row][col] = nextBit();
      }
    }
    upward = !upward;
  }
}

function writeFormatInfo(grid: Grid, mask: number): void {
  const { modules } = grid;
  const size = modules.length;
  const bits = formatInfo(mask);

  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;

    // Down the left of the top-left finder, then up the bottom-left one.
    if (i < 6) modules[i][8] = dark;
    else if (i < 8) modules[i + 1][8] = dark;
    else modules[size - 15 + i][8] = dark;

    // Along the top-right, then back along the top of the top-left finder.
    if (i < 8) modules[8][size - 1 - i] = dark;
    else if (i === 8) modules[8][7] = dark;
    else modules[8][14 - i] = dark;
  }
}

function writeVersionInfo(grid: Grid, version: number): void {
  if (version < 7) return;
  const { modules } = grid;
  const size = modules.length;
  const bits = versionInfo(version);

  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    modules[a][b] = dark;
    modules[b][a] = dark;
  }
}

/* ============================================================
   MASKING
   ============================================================ */

const MASKS: ReadonlyArray<(row: number, col: number) => boolean> = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number): void {
  const { modules, reserved } = grid;
  const size = modules.length;
  const rule = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (reserved[r][c]) continue;
      if (rule(r, c)) modules[r][c] = !modules[r][c];
    }
  }
}

/** The finder-lookalike sequences rule 3 hunts for, in both orientations. */
const RUN_1_1_3_1_1 = [true, false, true, true, true, false, true];

/**
 * The spec's four penalty rules. Lower is better; the winning mask is the one
 * that leaves the least structure a scanner could mistake for a finder.
 */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  // Rule 1 — runs of five or more of the same colour, in rows and in columns.
  for (let i = 0; i < size; i++) {
    for (const read of [
      (j: number) => modules[i][j],
      (j: number) => modules[j][i],
    ]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (read(j) === read(j - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // Rule 2 — every 2×2 block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = modules[r][c];
      if (modules[r][c + 1] === v && modules[r + 1][c] === v && modules[r + 1][c + 1] === v) {
        score += 3;
      }
    }
  }

  // Rule 3 — a 1:1:3:1:1 run with four light modules on one side of it.
  const matches = (read: (j: number) => boolean, at: number): boolean => {
    for (let k = 0; k < 7; k++) {
      if (read(at + k) !== RUN_1_1_3_1_1[k]) return false;
    }
    return true;
  };
  const lightRun = (read: (j: number) => boolean, at: number): boolean => {
    for (let k = 0; k < 4; k++) {
      if (read(at + k)) return false;
    }
    return true;
  };
  for (let i = 0; i < size; i++) {
    for (const read of [
      (j: number) => (j >= 0 && j < size ? modules[i][j] : false),
      (j: number) => (j >= 0 && j < size ? modules[j][i] : false),
    ]) {
      for (let j = 0; j <= size - 7; j++) {
        if (!matches(read, j)) continue;
        // Out of bounds counts as light — the quiet zone is light.
        if (lightRun(read, j - 4) || lightRun(read, j + 7)) score += 40;
      }
    }
  }

  // Rule 4 — how far the dark proportion strays from half, in 5% steps.
  let dark = 0;
  for (const row of modules) {
    for (const cell of row) if (cell) dark++;
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ============================================================
   THE ENCODER
   ============================================================ */

export type EncodeOptions = {
  /**
   * Force a mask, 0–7. Only tests should pass this — leaving it off tries all
   * eight and keeps the one the spec's penalty rules prefer.
   */
  mask?: number;
};

/** Encode `text` as a QR symbol. Throws only when the text is too long. */
export function encodeQr(text: string, options: EncodeOptions = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;
  const codewords = interleave(dataCodewords(bytes, version), version);

  const candidates = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];

  let best: QrCode | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const mask of candidates) {
    const grid = blankGrid(size);
    drawFunctionPatterns(grid, version);
    placeCodewords(grid, codewords);
    applyMask(grid, mask);
    writeFormatInfo(grid, mask);
    writeVersionInfo(grid, version);

    const score = penalty(grid.modules);
    if (score < bestScore) {
      bestScore = score;
      best = { version, size, mask, modules: grid.modules };
    }
  }

  // Unreachable: `candidates` is never empty.
  if (!best) throw new Error("No mask produced a symbol.");
  return best;
}

/* ============================================================
   SVG
   ============================================================ */

/**
 * One `<path d="…">` for the whole symbol.
 *
 * Horizontal runs are merged into a single rectangle each, which turns a
 * version-3 code from roughly 400 path commands into about 90 — worth doing
 * because this string is server-rendered into the HTML on every load of the
 * share screen.
 *
 * Coordinates are in modules, offset by the quiet zone, so the caller's
 * `viewBox` is the only place a pixel size appears.
 */
export function qrPathData(code: QrCode, quietZone = QUIET_ZONE): string {
  const parts: string[] = [];

  for (let r = 0; r < code.size; r++) {
    let c = 0;
    while (c < code.size) {
      if (!code.modules[r][c]) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < code.size && code.modules[r][c + run]) run++;
      parts.push(`M${c + quietZone} ${r + quietZone}h${run}v1h-${run}z`);
      c += run;
    }
  }

  return parts.join("");
}

/** The `viewBox` that matches {@link qrPathData}, quiet zone included. */
export function qrViewBox(code: QrCode, quietZone = QUIET_ZONE): string {
  const side = code.size + quietZone * 2;
  return `0 0 ${side} ${side}`;
}
