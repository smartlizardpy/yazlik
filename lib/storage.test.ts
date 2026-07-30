/**
 * The storage layer, tested with no network, no database, and no blob store.
 *
 * Two things are being pinned down here. First, that a file which should be
 * refused is refused in exactly one place, so no caller can forget to check.
 * Second — and this is the one that would actually hurt — that
 * `resolveUploadPath()` cannot be talked into opening a file outside
 * `.uploads/`. That guard is a pure function precisely so it can be tested
 * like this rather than trusted.
 *
 * The local driver tests write real bytes to real disk under a throwaway
 * prefix, because a storage layer that has never written a file has not been
 * tested. They clean up after themselves.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALLOWED_CONTENT_TYPES,
  MAX_BYTES,
  StorageError,
  driver,
  isInsideUploadsRoot,
  isStorageError,
  normalizeKeyPrefix,
  remove,
  resolveUploadPath,
  save,
  uploadsRoot,
} from "@/lib/storage";

/* ============================================================
   HELPERS
   ============================================================ */

/** A file the way a browser hands one over: named by the client, typed by it too. */
function fakeFile(options: {
  name?: string;
  type: string;
  bytes?: number;
  body?: string;
}): File {
  const body = options.body
    ? new TextEncoder().encode(options.body)
    : new Uint8Array(options.bytes ?? 64).fill(7);
  return new File([body], options.name ?? "upload", { type: options.type });
}

/** Every test writes under this prefix so cleanup is one `rm`. */
const TEST_PREFIX_ROOT = "test-storage";
const TEST_PREFIX = `${TEST_PREFIX_ROOT}/houses`;

/** What the caller gets back when a `StorageError` was expected. */
async function refusal(run: () => Promise<unknown>): Promise<StorageError> {
  try {
    await run();
  } catch (error) {
    if (isStorageError(error)) return error;
    throw error;
  }
  throw new Error("Expected a StorageError, but the call succeeded.");
}

const ORIGINAL_DRIVER = process.env.STORAGE_DRIVER;
const ORIGINAL_BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

beforeEach(() => {
  process.env.STORAGE_DRIVER = "local";
  delete process.env.BLOB_READ_WRITE_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_DRIVER === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = ORIGINAL_DRIVER;

  if (ORIGINAL_BLOB_TOKEN === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = ORIGINAL_BLOB_TOKEN;
});

afterAll(async () => {
  await rm(path.join(uploadsRoot(), TEST_PREFIX_ROOT), { recursive: true, force: true });
});

/* ============================================================
   DRIVER SELECTION
   ============================================================ */

describe("driver", () => {
  it("defaults to local when nothing is configured", () => {
    delete process.env.STORAGE_DRIVER;
    expect(driver()).toBe("local");

    process.env.STORAGE_DRIVER = "";
    expect(driver()).toBe("local");
  });

  it("reads the environment at call time, not at import time", () => {
    process.env.STORAGE_DRIVER = "blob";
    expect(driver()).toBe("blob");
    process.env.STORAGE_DRIVER = "local";
    expect(driver()).toBe("local");
  });

  it("ignores case and stray whitespace", () => {
    process.env.STORAGE_DRIVER = "  BLOB ";
    expect(driver()).toBe("blob");
  });

  it("refuses to guess at an unknown driver", () => {
    process.env.STORAGE_DRIVER = "s3";
    expect(() => driver()).toThrowError(StorageError);
    // A typo must not quietly fall back to writing on a disposable disk.
    expect(() => driver()).toThrowError(/STORAGE_DRIVER/);
  });
});

/* ============================================================
   WHAT SAVE REFUSES
   ============================================================ */

describe("save — content type", () => {
  it("accepts the four image types the product supports", async () => {
    for (const type of Object.keys(ALLOWED_CONTENT_TYPES)) {
      const stored = await save(fakeFile({ type, body: "hello" }), TEST_PREFIX);
      expect(stored.pathname.startsWith(`${TEST_PREFIX}/`)).toBe(true);
      await remove(stored.pathname);
    }
  });

  it("refuses a type that is not an allowed image", async () => {
    for (const type of ["image/gif", "image/svg+xml", "application/pdf", "text/html"]) {
      const error = await refusal(() => save(fakeFile({ type }), TEST_PREFIX));
      expect(error.code).toBe("type");
      expect(error.message).toMatch(/JPEG, PNG, WebP, or HEIC/);
    }
  });

  it("refuses a file with no type at all", async () => {
    const error = await refusal(() => save(fakeFile({ type: "" }), TEST_PREFIX));
    expect(error.code).toBe("type");
  });

  it("refuses a renamed script even though its extension looks safe", async () => {
    // `.png` on the outside, `text/html` on the inside. The name is not evidence.
    const error = await refusal(() =>
      save(fakeFile({ name: "beach.png", type: "text/html" }), TEST_PREFIX),
    );
    expect(error.code).toBe("type");
  });

  it("normalises casing and parameters before deciding", async () => {
    const stored = await save(
      fakeFile({ type: "IMAGE/JPEG; charset=binary", body: "x" }),
      TEST_PREFIX,
    );
    expect(stored.pathname.endsWith(".jpg")).toBe(true);
    await remove(stored.pathname);
  });
});

describe("save — size", () => {
  it("refuses a photo over 8MB and says how big it was", async () => {
    const error = await refusal(() =>
      save(fakeFile({ type: "image/jpeg", bytes: MAX_BYTES + 1 }), TEST_PREFIX),
    );
    expect(error.code).toBe("size");
    expect(error.message).toMatch(/8\.0MB/);
  });

  it("accepts a photo exactly on the limit", async () => {
    const stored = await save(
      fakeFile({ type: "image/jpeg", bytes: MAX_BYTES }),
      TEST_PREFIX,
    );
    const written = await stat(path.join(uploadsRoot(), stored.pathname));
    expect(written.size).toBe(MAX_BYTES);
    await remove(stored.pathname);
  });

  it("refuses an empty file", async () => {
    const error = await refusal(() =>
      save(fakeFile({ type: "image/png", bytes: 0 }), TEST_PREFIX),
    );
    expect(error.code).toBe("empty");
  });
});

describe("save — the key", () => {
  it("takes the extension from the content type, never the filename", async () => {
    const cases = [
      { name: "holiday.heic", type: "image/png", extension: "png" },
      { name: "holiday.png", type: "image/jpeg", extension: "jpg" },
      { name: "holiday.jpg", type: "image/webp", extension: "webp" },
      { name: "holiday.txt", type: "image/heic", extension: "heic" },
      { name: "no-extension-at-all", type: "image/png", extension: "png" },
    ];

    for (const testCase of cases) {
      const stored = await save(
        fakeFile({ name: testCase.name, type: testCase.type, body: "x" }),
        TEST_PREFIX,
      );
      expect(stored.pathname.endsWith(`.${testCase.extension}`)).toBe(true);
      await remove(stored.pathname);
    }
  });

  it("throws the client's filename away entirely", async () => {
    const hostile = "../../etc/passwd";
    const stored = await save(
      fakeFile({ name: hostile, type: "image/png", body: "x" }),
      TEST_PREFIX,
    );

    expect(stored.pathname).not.toContain("passwd");
    expect(stored.pathname).not.toContain("..");
    expect(stored.pathname).toMatch(
      new RegExp(`^${TEST_PREFIX}/[a-z0-9]{16}\\.png$`),
    );
    await remove(stored.pathname);
  });

  it("gives two uploads of the same file two names", async () => {
    const first = await save(fakeFile({ type: "image/png", body: "x" }), TEST_PREFIX);
    const second = await save(fakeFile({ type: "image/png", body: "x" }), TEST_PREFIX);
    expect(first.pathname).not.toBe(second.pathname);
    await remove(first.pathname);
    await remove(second.pathname);
  });

  it("refuses a prefix that is not a plain folder path", async () => {
    for (const prefix of ["", "/", "../secrets", "houses/../..", "hou ses", "a/./b"]) {
      const error = await refusal(() =>
        save(fakeFile({ type: "image/png", body: "x" }), prefix),
      );
      expect(error.code).toBe("key");
    }
  });

  it("keeps a normal prefix as it was written", () => {
    expect(normalizeKeyPrefix("houses/abc-123")).toBe("houses/abc-123");
    expect(normalizeKeyPrefix("/places/xyz/")).toBe("places/xyz");
  });
});

/* ============================================================
   THE LOCAL DRIVER, END TO END
   ============================================================ */

describe("local driver", () => {
  it("writes the bytes, returns a servable url, and deletes on request", async () => {
    const stored = await save(
      fakeFile({ type: "image/webp", body: "the beach at seven" }),
      TEST_PREFIX,
    );

    expect(stored.url).toBe(`/api/uploads/${stored.pathname}`);

    const absolute = path.join(uploadsRoot(), stored.pathname);
    expect(await readFile(absolute, "utf8")).toBe("the beach at seven");

    // What came back has to survive the route's own guard, or the file is
    // written somewhere nothing can serve it from.
    const resolved = resolveUploadPath(stored.pathname);
    expect(resolved?.absolutePath).toBe(absolute);
    expect(resolved?.contentType).toBe("image/webp");

    await remove(stored.pathname);
    await expect(stat(absolute)).rejects.toThrow();
  });

  it("treats deleting something already gone as done", async () => {
    await expect(remove(`${TEST_PREFIX}/2222222222222222.png`)).resolves.toBeUndefined();
  });

  it("never throws out of remove, whatever it is handed", async () => {
    await expect(remove("")).resolves.toBeUndefined();
    await expect(remove("../../package.json")).resolves.toBeUndefined();
    // Proof the refusal was a refusal: the file it named is still there.
    expect(await stat(path.resolve(process.cwd(), "package.json"))).toBeTruthy();
  });
});

/* ============================================================
   THE BLOB DRIVER, WITHOUT A BLOB STORE
   ============================================================ */

describe("blob driver", () => {
  it("validates before it reaches for the network", async () => {
    process.env.STORAGE_DRIVER = "blob";
    // No token is set, but the file is refused on its type first — validation
    // does not depend on the driver being reachable.
    const error = await refusal(() =>
      save(fakeFile({ type: "application/pdf" }), TEST_PREFIX),
    );
    expect(error.code).toBe("type");
  });

  it("says what is missing when the store is not connected", async () => {
    process.env.STORAGE_DRIVER = "blob";
    const error = await refusal(() =>
      save(fakeFile({ type: "image/png", body: "x" }), TEST_PREFIX),
    );
    expect(error.code).toBe("config");
    expect(error.message).toMatch(/BLOB_READ_WRITE_TOKEN/);
  });
});

/* ============================================================
   PATH TRAVERSAL — the guard behind /api/uploads
   ============================================================ */

describe("resolveUploadPath", () => {
  const root = "/srv/app/.uploads";

  it("resolves a normal path to a file inside the uploads root", () => {
    const resolved = resolveUploadPath(["houses", "abc123", "9k2m.jpg"], root);
    expect(resolved).not.toBeNull();
    expect(resolved!.pathname).toBe("houses/abc123/9k2m.jpg");
    expect(resolved!.absolutePath).toBe("/srv/app/.uploads/houses/abc123/9k2m.jpg");
    expect(resolved!.contentType).toBe("image/jpeg");
  });

  it("accepts a string and an array identically", () => {
    const fromArray = resolveUploadPath(["places", "p1.png"], root);
    const fromString = resolveUploadPath("places/p1.png", root);
    expect(fromString).toEqual(fromArray);
  });

  it("maps each extension we write to the type we serve", () => {
    const expected: Record<string, string> = {
      "a.jpg": "image/jpeg",
      "a.jpeg": "image/jpeg",
      "a.PNG": "image/png",
      "a.webp": "image/webp",
      "a.heic": "image/heic",
    };
    for (const [name, type] of Object.entries(expected)) {
      expect(resolveUploadPath([name], root)?.contentType).toBe(type);
    }
  });

  it("refuses every shape of ../ escape", () => {
    const attacks: (string | string[])[] = [
      // The classic, split by the framework into segments.
      ["..", "..", "etc", "passwd"],
      // `..%2f..%2fetc%2fpasswd` — arrives already decoded, one segment.
      "../../etc/passwd",
      ["../../etc/passwd"],
      // A real file in this repo, one level up from .uploads.
      "../../package.json",
      ["..", "package.json"],
      // With an allowed extension, so only the traversal check can catch it.
      "../../secret.png",
      ["..", "..", "secret.png"],
      ["houses", "..", "..", "secret.png"],
      // Dot segments on their own.
      [".."],
      ["."],
      ["houses", ".", "a.png"],
      // Absolute, or empty segments from a leading or doubled slash.
      "/etc/passwd",
      "/a.png",
      "houses//a.png",
      "houses/",
      // Windows-flavoured, and a NUL truncation attempt.
      "..\\..\\a.png",
      "houses\\a.png",
      "houses/a.png .txt",
      // Still encoded — decoding this again is somebody else's bug, not ours.
      "%2e%2e/%2e%2e/a.png",
      "..%2f..%2fetc%2fpasswd",
      // Dotfiles, which start with a character the allowlist does not permit.
      [".env"],
      ["houses", ".env.local"],
    ];

    for (const attack of attacks) {
      expect(resolveUploadPath(attack, root), JSON.stringify(attack)).toBeNull();
    }
  });

  it("refuses anything that is not one of the four image extensions", () => {
    for (const name of [
      "route.ts",
      "package.json",
      "notes.txt",
      "photo",
      "photo.",
      ".jpg",
      "photo.jpg.exe",
      "photo.svg",
    ]) {
      expect(resolveUploadPath([name], root), name).toBeNull();
    }
  });

  it("refuses empty, oversized, and absurdly deep requests", () => {
    expect(resolveUploadPath([], root)).toBeNull();
    expect(resolveUploadPath("", root)).toBeNull();
    expect(resolveUploadPath("   ", root)).toBeNull();
    expect(resolveUploadPath([`${"a".repeat(200)}.png`], root)).toBeNull();
    expect(resolveUploadPath(`${"a/".repeat(40)}b.png`, root)).toBeNull();
    expect(resolveUploadPath(`${"ab/".repeat(200)}b.png`, root)).toBeNull();
  });

  it("never returns a path outside the root, whatever it is given", () => {
    const probes = [
      "../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "/etc/passwd",
      "houses/../../a.png",
      "....//....//a.png",
    ];
    for (const probe of probes) {
      const resolved = resolveUploadPath(probe, root);
      if (resolved) {
        // If anything ever does resolve, it still has to be contained.
        expect(isInsideUploadsRoot(resolved.absolutePath, root)).toBe(true);
      }
    }
  });

  it("does not confuse a sibling directory with the root", () => {
    expect(isInsideUploadsRoot("/srv/app/.uploads-elsewhere/a.png", root)).toBe(false);
    expect(isInsideUploadsRoot("/srv/app/.uploads", root)).toBe(false);
    expect(isInsideUploadsRoot("/srv/app/.uploads/a.png", root)).toBe(true);
    expect(isInsideUploadsRoot("/etc/passwd", root)).toBe(false);
  });

  it("catches a symlink pointing out of the root, which only the filesystem knows", async () => {
    // The guard is arithmetic; symlinks are not. This is why the route checks
    // `realpath` as well, and this proves the check it relies on works.
    const sandbox = await mkdtemp(path.join(tmpdir(), "yazlik-uploads-"));
    const outside = path.join(sandbox, "outside.png");
    const sandboxRoot = path.join(sandbox, "root");
    const link = path.join(sandboxRoot, "escape.png");

    try {
      await writeFile(outside, "not yours");
      await mkdir(sandboxRoot, { recursive: true });
      await symlink(outside, link);

      // The pure resolver is happy: the string itself is well formed.
      const resolved = resolveUploadPath(["escape.png"], sandboxRoot);
      expect(resolved).not.toBeNull();

      // The filesystem check the route adds on top is what refuses it.
      const real = await realpath(resolved!.absolutePath);
      expect(isInsideUploadsRoot(real, sandboxRoot)).toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});
