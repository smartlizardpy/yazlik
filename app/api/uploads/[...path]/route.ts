/**
 * Serves the photos the `local` storage driver wrote.
 *
 * When `STORAGE_DRIVER=blob` the browser fetches images straight from the CDN
 * and this route answers 404 to everything — it exists so that a machine with
 * no blob store still has a working `<img src>`, which is what makes the whole
 * image flow testable before anyone provisions anything.
 *
 * ### This route reads files off the disk from a string in a URL
 *
 * So it assumes the string is hostile. `resolveUploadPath()` in `lib/storage.ts`
 * is the guard — an allowlist per path segment, an extension check, and a
 * containment check after `path.resolve` — and it is unit tested there. This
 * file adds the one check that needs the filesystem: after resolving, the real
 * path (symlinks followed) has to still be inside the uploads root.
 *
 * Every refusal is **404**, never 403. A 403 would confirm that something is
 * there, which is precisely the fact a prober is fishing for. A traversal
 * attempt and a typo get the same four bytes of answer.
 *
 * There is no `export const dynamic` here: without Cache Components a `GET`
 * route handler is already dynamic, and this one reads the disk per request.
 */

import { readFile, realpath, stat } from "node:fs/promises";

import { driver, isInsideUploadsRoot, resolveUploadPath } from "@/lib/storage";

/** One answer for "not here", "not allowed", and "not while on blob". */
function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  // On the blob driver these files are not ours to serve.
  if (driver() !== "local") return notFound();

  const { path: segments } = await context.params;
  const resolved = resolveUploadPath(segments ?? []);
  if (!resolved) return notFound();

  try {
    // A symlink inside .uploads could point anywhere. Nothing we write makes
    // one, so this only ever fires on a planted file — but it fires cheaply.
    const real = await realpath(resolved.absolutePath);
    if (!isInsideUploadsRoot(real)) return notFound();

    const info = await stat(real);
    if (!info.isFile()) return notFound();

    const bytes = await readFile(real);

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "content-type": resolved.contentType,
        "content-length": String(bytes.byteLength),
        // The filename carries a random token, so the bytes at a URL never
        // change: cache them for a year and never revalidate.
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    // ENOENT, EACCES, a directory, a race with a delete — all the same answer.
    return notFound();
  }
}
