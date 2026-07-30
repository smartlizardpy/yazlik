/**
 * Where photos live.
 *
 * One interface, two drivers, chosen by `STORAGE_DRIVER`:
 *
 * - **`local`** (the default) writes into `.uploads/` beside the source tree and
 *   serves the bytes back through `/api/uploads/<pathname>`. It needs no
 *   account, no token, and no network, so the whole upload → render → delete
 *   loop is verifiable on a laptop.
 * - **`blob`** writes to Vercel Blob with public access and hands back the CDN
 *   URL. Swapping drivers is one environment variable; nothing above this file
 *   knows which one is running.
 *
 * Callers get the same two strings either way — a `url` to render and a
 * `pathname` to store on the row so the file can be deleted with it.
 *
 * ### Everything that can be refused is refused here
 *
 * Content type, size, and the shape of the key are checked in this file and
 * nowhere else. A Server Action, a route handler, and a test all get identical
 * answers because they all come through `save()`. Failures are `StorageError`,
 * whose message is written to be shown to the person holding the phone.
 *
 * ### The filename is never the client's
 *
 * A browser can call a file `../../etc/passwd`, `photo.php`, or 400 characters
 * of Unicode. None of it is used. The key is `<prefix>/<token>.<ext>` where the
 * token is ours and the extension comes from the *content type*, so what we
 * write is always one of four known image extensions.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { newToken } from "@/lib/ids";

/* ============================================================
   TYPES
   ============================================================ */

/** What a caller stores on the row: one URL to render, one pathname to delete. */
export type StoredFile = {
  /** Renderable source. Same-origin path on `local`, absolute CDN URL on `blob`. */
  url: string;
  /** The key inside the store. Pass it back to `remove()`. */
  pathname: string;
};

/** The two ways this app can store a photo. */
export type StorageDriver = "local" | "blob";

/** Why a storage call was refused. `type` and `size` are the two a guest can cause. */
export type StorageErrorCode =
  | "type"
  | "size"
  | "empty"
  | "key"
  | "config"
  | "driver"
  | "write";

/**
 * A refusal with a message fit to render.
 *
 * Every `throw` in this file is one of these, so a caller can put
 * `error.message` straight into an action result without translating anything.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

/** Narrowing helper for `catch` blocks, which see `unknown`. */
export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}

/* ============================================================
   WHAT COUNTS AS A PHOTO
   ============================================================ */

/** The only four types accepted, each mapped to the extension we write. */
export const ALLOWED_CONTENT_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
} as const satisfies Record<string, string>;

/** A content type this app will store. */
export type AllowedContentType = keyof typeof ALLOWED_CONTENT_TYPES;

/**
 * The reverse map, used when serving a file back.
 * `jpeg` is here because a hand-copied file may use it; `save()` only ever
 * writes `jpg`.
 */
export const CONTENT_TYPE_BY_EXTENSION: Record<string, AllowedContentType> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
};

/** 8MB. A phone photo is 2–5MB; anything past this is a mistake or an attack. */
export const MAX_BYTES = 8 * 1024 * 1024;

/** Directory that holds every file the `local` driver writes. Gitignored. */
export const UPLOADS_DIRNAME = ".uploads";

/** Where `/api/uploads/...` serves from. Resolved per call so tests can chdir. */
export function uploadsRoot(): string {
  return path.resolve(process.cwd(), UPLOADS_DIRNAME);
}

/* ============================================================
   DRIVER SELECTION
   ============================================================ */

/**
 * Which driver is running.
 *
 * Unset means `local`: a machine with no configuration should store photos on
 * its own disk rather than reach for a network service. A value that is neither
 * throws instead of falling back — a typo in `STORAGE_DRIVER` on a deployed
 * server must be loud, not quietly write to a container filesystem that
 * disappears on the next request.
 */
export function driver(): StorageDriver {
  const raw = (process.env.STORAGE_DRIVER ?? "").trim().toLowerCase();
  if (raw === "" || raw === "local") return "local";
  if (raw === "blob") return "blob";
  throw new StorageError(
    "driver",
    `Photo storage is misconfigured: STORAGE_DRIVER is "${process.env.STORAGE_DRIVER}". Set it to "local" or "blob".`,
  );
}

/* ============================================================
   VALIDATION
   ============================================================ */

/** `image/JPEG; charset=binary` and `image/jpeg` are the same claim. */
function normalizeContentType(value: string): string {
  return value.split(";")[0]!.trim().toLowerCase();
}

/** Bytes as a number a person reads, e.g. `12.4MB`. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * The file's type, or a refusal. HEIC is in the list because that is what an
 * iPhone hands over by default and telling someone to convert it is not an
 * answer.
 */
function checkContentType(file: File): AllowedContentType {
  const type = normalizeContentType(file.type ?? "");
  if (type in ALLOWED_CONTENT_TYPES) return type as AllowedContentType;
  throw new StorageError(
    "type",
    "That file is not a photo we can use. Upload a JPEG, PNG, WebP, or HEIC image.",
  );
}

/** Nothing empty, nothing over the ceiling. */
function checkSize(file: File): void {
  if (file.size <= 0) {
    throw new StorageError(
      "empty",
      "That file is empty. Pick the photo again and upload it.",
    );
  }
  if (file.size > MAX_BYTES) {
    throw new StorageError(
      "size",
      `That photo is ${megabytes(file.size)}. Photos have to be under ${megabytes(MAX_BYTES)} — shrink it, or pick another.`,
    );
  }
}

/** A folder segment we generate: ids, table names, nothing exotic, no dots. */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Cleans the caller's prefix into `a/b/c`.
 *
 * The prefix comes from our own code (`houses/<id>`, `places/<id>`), never from
 * a request — so a bad one is a bug, and it is caught at the point it would
 * otherwise become a path.
 */
export function normalizeKeyPrefix(keyPrefix: string): string {
  const segments = String(keyPrefix ?? "")
    .split("/")
    .filter((segment) => segment.length > 0);

  const valid =
    segments.length > 0 &&
    segments.length <= 6 &&
    segments.every((segment) => segment.length <= 64 && KEY_SEGMENT.test(segment));

  if (!valid) {
    throw new StorageError(
      "key",
      "The photo could not be filed — its storage folder is not a valid name. This is a bug; nothing was uploaded.",
    );
  }
  return segments.join("/");
}

/* ============================================================
   READING A PATH BACK — the traversal guard
   ============================================================ */

/** A request for a stored file that has been proven safe to open. */
export type ResolvedUpload = {
  /** The key, normalized: `houses/abc/def.jpg`. */
  pathname: string;
  /** Absolute path on disk, proven to sit inside the uploads root. */
  absolutePath: string;
  /** Content type to serve, derived from the extension we wrote. */
  contentType: AllowedContentType;
};

/**
 * A single path segment we are willing to open.
 *
 * An allowlist, not a blocklist — the first character must be alphanumeric,
 * which alone rejects `.`, `..`, and every dotfile, and the rest excludes `/`,
 * `\`, `%`, NUL, and anything else that changes meaning further down the stack.
 * `%` is refused so that a double-encoded segment can never be decoded twice
 * into a separator by something downstream.
 */
const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Is `candidate` a real path inside `root`? Used again after `realpath`. */
export function isInsideUploadsRoot(candidate: string, root = uploadsRoot()): boolean {
  const base = path.resolve(root);
  const target = path.resolve(candidate);
  return target.startsWith(base + path.sep);
}

/**
 * Turns the `[...path]` of a request into a file we are willing to open, or
 * `null` — and `null` always means 404, never 403. Telling a prober that
 * `/api/uploads/../../.env` exists but is forbidden is telling them it exists.
 *
 * Three independent gates, any of which is sufficient on its own:
 *
 * 1. **Every segment must match the allowlist.** `..`, `.`, an empty segment,
 *    a backslash, a NUL, and a percent-encoded separator are all rejected here.
 *    This is what stops `../../etc/passwd` and its `..%2f..%2fetc%2fpasswd`
 *    form, which the framework hands us already decoded as a single segment.
 * 2. **The extension must be one of the four we write.** Even a path that
 *    somehow escaped could only ever name an image, never `.env` or a `.ts`.
 * 3. **The resolved absolute path must still be under the root.** The
 *    arithmetic answer, checked after `path.resolve` has done its worst.
 *
 * Exported, and pure, because a security check nobody can unit test is a
 * security check that rots. `root` is a parameter for the same reason.
 */
export function resolveUploadPath(
  input: string | readonly string[],
  root = uploadsRoot(),
): ResolvedUpload | null {
  const joined = (typeof input === "string" ? input : input.join("/")).trim();
  if (joined.length === 0 || joined.length > 512) return null;

  const segments = joined.split("/");
  if (segments.length === 0 || segments.length > 10) return null;

  for (const segment of segments) {
    if (segment.length === 0 || segment.length > 128) return null;
    if (!PATH_SEGMENT.test(segment)) return null;
  }

  const filename = segments[segments.length - 1]!;
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return null;

  const extension = filename.slice(dot + 1).toLowerCase();
  const contentType = CONTENT_TYPE_BY_EXTENSION[extension];
  if (!contentType) return null;

  const base = path.resolve(root);
  const absolutePath = path.resolve(base, ...segments);

  // Belt and braces: the segments alone should make this impossible.
  if (absolutePath !== path.join(base, ...segments)) return null;
  if (!isInsideUploadsRoot(absolutePath, base)) return null;

  return { pathname: segments.join("/"), absolutePath, contentType };
}

/* ============================================================
   SAVE
   ============================================================ */

/**
 * Stores one photo and returns what to write on the row.
 *
 * `keyPrefix` is the folder it belongs in — `houses/<houseId>` for a gallery
 * photo, `places/<placeId>` for a place. The filename is generated: a 16
 * character token plus the extension implied by the content type.
 *
 * Throws `StorageError` for a file that is not an allowed image, is empty, or
 * is over 8MB — the message is ready to show. Anything else that goes wrong
 * (a full disk, an unreachable blob store) also arrives as a `StorageError`,
 * with the underlying cause logged rather than shown.
 */
export async function save(file: File, keyPrefix: string): Promise<StoredFile> {
  const contentType = checkContentType(file);
  checkSize(file);

  const prefix = normalizeKeyPrefix(keyPrefix);
  const pathname = `${prefix}/${newToken()}.${ALLOWED_CONTENT_TYPES[contentType]}`;

  return driver() === "blob"
    ? saveToBlob(file, pathname, contentType)
    : saveToLocal(file, pathname);
}

/** Writes into `.uploads/`, creating the folder on the way. */
async function saveToLocal(file: File, pathname: string): Promise<StoredFile> {
  const target = resolveUploadPath(pathname);
  if (!target) {
    // Unreachable: the key was built from a validated prefix and our own token.
    throw new StorageError(
      "key",
      "The photo could not be filed — its storage name is not valid. This is a bug; nothing was uploaded.",
    );
  }

  try {
    await mkdir(path.dirname(target.absolutePath), { recursive: true });
    const bytes = new Uint8Array(await file.arrayBuffer());
    // `wx` fails rather than overwrites. With a 16-character token a collision
    // is not a real event, but silently replacing someone's photo would be.
    await writeFile(target.absolutePath, bytes, { flag: "wx" });
  } catch (error) {
    console.error("[storage:local] write failed", pathname, error);
    throw new StorageError("write", "The photo did not save. Try uploading it again.");
  }

  return { url: `/api/uploads/${target.pathname}`, pathname: target.pathname };
}

/**
 * Writes to Vercel Blob.
 *
 * The token is read and checked before `@vercel/blob` is imported, so an
 * unconfigured environment fails with a sentence instead of a network error —
 * and so a test of this path costs no network. `addRandomSuffix` is off: the
 * name is already random, and a suffix would make the returned pathname differ
 * from the key we built.
 */
async function saveToBlob(
  file: File,
  pathname: string,
  contentType: AllowedContentType,
): Promise<StoredFile> {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    throw new StorageError(
      "config",
      "Photos cannot be uploaded yet — the blob store is not connected. Add BLOB_READ_WRITE_TOKEN to the environment, or set STORAGE_DRIVER=local.",
    );
  }

  try {
    const { put } = await import("@vercel/blob");
    const result = await put(pathname, file, {
      access: "public",
      contentType,
      addRandomSuffix: false,
      token,
    });
    return { url: result.url, pathname: result.pathname };
  } catch (error) {
    console.error("[storage:blob] put failed", pathname, error);
    throw new StorageError("write", "The photo did not save. Try uploading it again.");
  }
}

/* ============================================================
   REMOVE
   ============================================================ */

/**
 * Deletes a stored file. Never throws.
 *
 * Deleting a photo means deleting a row and its file, and the row is the part
 * that matters: if the store is unreachable, the owner still has to be able to
 * remove the photo from their page. A file left behind is recoverable and
 * logged; a delete button that fails because a CDN hiccuped is not. Callers can
 * therefore `await remove(...)` and carry on.
 *
 * A pathname that is already gone is a success — deleting the same row twice is
 * a normal thing to happen.
 */
export async function remove(pathname: string): Promise<void> {
  const key = String(pathname ?? "").trim();
  if (key.length === 0) return;

  try {
    if (driver() === "blob") {
      const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
      if (!token) {
        console.warn("[storage:blob] cannot delete without BLOB_READ_WRITE_TOKEN", key);
        return;
      }
      const { del } = await import("@vercel/blob");
      await del(key, { token });
      return;
    }

    const target = resolveUploadPath(key);
    if (!target) {
      console.warn("[storage:local] refused to delete an unsafe pathname", key);
      return;
    }
    // `force` makes a missing file a no-op rather than an ENOENT.
    await rm(target.absolutePath, { force: true });
  } catch (error) {
    console.error("[storage] delete failed, file left behind", key, error);
  }
}
