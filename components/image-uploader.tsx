"use client";

/**
 * The upload control. One button, the camera roll, and a queue.
 *
 * `<input type="file" accept="image/*" multiple>` is the whole interaction: on
 * iOS and Android it opens the photo library directly. There is deliberately no
 * drag-and-drop zone — nobody drags a file on a phone, and the target for it
 * would only crowd out the button that matters. The `panel` variant looks like
 * one and is not: it is the same button drawn large, for when there are no
 * photos above it and a 44px row would be the only thing on the screen.
 *
 * ### How an upload goes
 *
 * 1. Picking files adds one row each, showing a preview from
 *    `URL.createObjectURL` immediately. The photo is on screen before a byte
 *    has left the phone, which is most of what makes this feel fast.
 * 2. Files upload **one at a time**. A phone on a hotel connection sending four
 *    photos at once gets four stalled bars; sending them in turn gets one bar
 *    that actually moves and three photos that survive if the fourth fails.
 * 3. Each `POST /api/upload` runs through `XMLHttpRequest` rather than `fetch`,
 *    because `xhr.upload.onprogress` is the only way to know how many bytes
 *    have really gone. A percentage that comes from the network is worth the
 *    extra thirty lines over a spinner that is guessing.
 * 4. A failure keeps the file. **Try again** re-queues the same `File` object —
 *    nobody re-opens the camera roll to find the photo they already chose.
 *
 * ### What this component does not decide
 *
 * Whether a file is an acceptable photo. Type, size, and ownership are settled
 * on the server, and its `error` string is written for the person holding the
 * phone, so it is shown exactly as it arrives. Duplicating the 8MB ceiling here
 * would put the same rule in two places with nothing keeping them equal.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { CheckIcon, ImagePlusIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/* ============================================================
   TYPES
   ============================================================ */

/** What `/api/upload` returns, and what the parent gets told about. */
export type UploadedImage = {
  id: string;
  url: string;
  pathname: string;
};

export type ImageUploaderProps = {
  houseId: string;
  /** Set exactly one of these to attach the photo to a place or a section. */
  placeId?: string;
  sectionId?: string;
  /** How many photos this subject may hold in total. */
  max: number;
  /** How many it holds right now, from the server. */
  count: number;
  /**
   * `"button"` is the row that sits under photos that already exist.
   * `"panel"` is for when there are none: the same control drawn as the dashed
   * box that would otherwise be an untappable "no photos yet" placeholder above
   * it. Same input, same picker — one target instead of two shapes.
   */
  variant?: "button" | "panel";
  /** Called once per photo that lands. Revalidate from here. */
  onUploaded?: (image: UploadedImage) => void;
  className?: string;
};

type UploadStatus = "pending" | "uploading" | "done" | "failed";

type UploadItem = {
  /** Local identity. Two identical files picked twice are still two rows. */
  key: string;
  file: File;
  name: string;
  /** What the thumbnail renders: an object URL, then the stored URL. */
  src: string;
  /** The object URL that still needs revoking, or null once it is gone. */
  objectUrl: string | null;
  status: UploadStatus;
  /** 0–1, straight from the request's upload progress. */
  progress: number;
  error: string | null;
};

/* ============================================================
   TALKING TO /api/upload
   ============================================================ */

/** An upload that failed with a message already fit to show. */
class UploadFailure extends Error {}

const NETWORK_MESSAGE =
  "The upload did not finish — the connection dropped. Try again when you have signal.";

/** Only used when the response carries no message of its own. */
function fallbackMessage(status: number): string {
  if (status === 413) {
    return "That photo is too large to send. Pick a smaller one, or take it again at a lower resolution.";
  }
  if (status === 401 || status === 403) {
    return "You are not signed in any more. Sign in again, then add the photo.";
  }
  return "The photo did not upload. Try again in a moment.";
}

/** `{ error: "…" }` from the route, if that is what came back. */
function readError(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as { error?: unknown }).error;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/** `{ id, url, pathname }` from the route, if that is what came back. */
function readImage(payload: unknown): UploadedImage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { id, url, pathname } = payload as Record<string, unknown>;
  if (typeof id !== "string" || typeof url !== "string" || typeof pathname !== "string") {
    return null;
  }
  return { id, url, pathname };
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Sends one photo and reports how much of it has gone.
 *
 * Rejects with an `UploadFailure` whose message can be rendered as-is, or with
 * an `AbortError` when the component unmounts mid-flight.
 */
function postImage(options: {
  file: File;
  houseId: string;
  placeId?: string;
  sectionId?: string;
  signal: AbortSignal;
  onProgress: (fraction: number) => void;
}): Promise<UploadedImage> {
  const { file, houseId, placeId, sectionId, signal, onProgress } = options;

  return new Promise<UploadedImage>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }

    const body = new FormData();
    body.append("file", file);
    body.append("houseId", houseId);
    if (placeId) body.append("placeId", placeId);
    if (sectionId) body.append("sectionId", sectionId);

    const request = new XMLHttpRequest();
    const abort = () => request.abort();

    function settle(run: () => void) {
      signal.removeEventListener("abort", abort);
      run();
    }

    request.open("POST", "/api/upload");
    // Say what we can read back, so a route that content-negotiates picks JSON.
    request.setRequestHeader("Accept", "application/json");

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(event.loaded / event.total);
      }
    };

    request.onload = () => {
      const payload = parseJson(request.responseText ?? "");

      if (request.status >= 200 && request.status < 300) {
        const image = readImage(payload);
        settle(() =>
          image
            ? resolve(image)
            : reject(
                new UploadFailure(
                  "The photo was sent but the answer made no sense. Reload the page to see whether it saved.",
                ),
              ),
        );
        return;
      }

      const message = readError(payload) ?? fallbackMessage(request.status);
      settle(() => reject(new UploadFailure(message)));
    };

    request.onerror = () => settle(() => reject(new UploadFailure(NETWORK_MESSAGE)));
    request.ontimeout = () => settle(() => reject(new UploadFailure(NETWORK_MESSAGE)));
    request.onabort = () =>
      settle(() => reject(new DOMException("Upload aborted", "AbortError")));

    signal.addEventListener("abort", abort, { once: true });
    request.send(body);
  });
}

/* ============================================================
   COMPONENT
   ============================================================ */

/** A done row clears itself once the photo has appeared in the gallery. */
const DONE_LINGER_MS = 3000;

export function ImageUploader({
  houseId,
  placeId,
  sectionId,
  max,
  count,
  variant = "button",
  onUploaded,
  className,
}: ImageUploaderProps) {
  const baseId = useId();
  const hintId = `${baseId}-hint`;

  const [items, setItems] = useState<UploadItem[]>([]);
  // How many landed since the server last told us the count. Without it, the
  // cap would only tighten after the parent revalidates, and a fast picker
  // could get past it.
  const [added, setAdded] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  // Row identity. The same photo picked twice is two rows, so nothing derived
  // from the file itself will do.
  const seqRef = useRef(0);
  // The queue is a ref as well as state: the drain loop reads it between
  // awaits, where React's state would still be one render behind.
  const itemsRef = useRef<UploadItem[]>([]);
  const drainingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const timersRef = useRef<number[]>([]);
  // The parent's callback as of this render, so the upload loop never calls a
  // stale one and nothing has to re-create the loop when it changes identity.
  const onUploadedRef = useRef(onUploaded);
  useEffect(() => {
    onUploadedRef.current = onUploaded;
  });

  // A new count from the server is the truth; the session tally starts over.
  // This is also what makes a deletion give the room back.
  const countRef = useRef(count);
  useEffect(() => {
    if (countRef.current !== count) {
      countRef.current = count;
      setAdded(0);
    }
  }, [count]);

  // Unmount: stop the queue, stop the request in flight, drop the timers, and
  // hand every object URL back. A blob URL that outlives its component is a
  // leak the browser cannot see, and a queue that outlives it uploads photos
  // nobody is waiting for. Re-armed on the way in, because Strict Mode mounts,
  // unmounts, and mounts again in development.
  const goneRef = useRef(false);
  useEffect(() => {
    goneRef.current = false;
    const timers = timersRef.current;
    return () => {
      goneRef.current = true;
      abortRef.current?.abort();
      for (const timer of timers) window.clearTimeout(timer);
      for (const item of itemsRef.current) {
        if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
      }
    };
  }, []);

  /** The one writer. Ref and state move together or they drift. */
  function write(next: (current: UploadItem[]) => UploadItem[]) {
    itemsRef.current = next(itemsRef.current);
    setItems(itemsRef.current);
  }

  function patch(key: string, change: Partial<UploadItem>) {
    write((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
  }

  const inFlight = items.filter(
    (item) => item.status === "pending" || item.status === "uploading",
  ).length;
  const used = count + added + inFlight;
  const remaining = Math.max(0, max - used);
  const full = remaining === 0;

  async function uploadOne(key: string) {
    const item = itemsRef.current.find((candidate) => candidate.key === key);
    if (!item) return;

    patch(key, { status: "uploading", progress: 0, error: null });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const image = await postImage({
        file: item.file,
        houseId,
        placeId,
        sectionId,
        signal: controller.signal,
        onProgress: (fraction) => patch(key, { progress: fraction }),
      });

      // Resolved: the stored copy can be rendered, so the object URL has done
      // its job and goes back.
      if (item.objectUrl) URL.revokeObjectURL(item.objectUrl);
      patch(key, {
        status: "done",
        progress: 1,
        src: image.url,
        objectUrl: null,
        error: null,
      });
      setAdded((total) => total + 1);
      onUploadedRef.current?.(image);

      // The photo now lives in the gallery below. Leaving its row here forever
      // would show it twice.
      const timer = window.setTimeout(() => {
        write((current) => current.filter((candidate) => candidate.key !== key));
      }, DONE_LINGER_MS);
      timersRef.current.push(timer);
    } catch (error) {
      // An abort is this component going away. There is nobody left to tell.
      if (controller.signal.aborted) return;
      if (!(error instanceof UploadFailure)) {
        console.error("[ImageUploader] upload failed", error);
      }
      patch(key, {
        status: "failed",
        error:
          error instanceof UploadFailure
            ? error.message
            : "The photo did not upload. Try again in a moment.",
      });
    } finally {
      abortRef.current = null;
    }
  }

  /** One at a time, until nothing is waiting. Re-entrant calls fall through. */
  async function drain() {
    if (drainingRef.current) return;
    drainingRef.current = true;
    try {
      for (;;) {
        if (goneRef.current) return;
        const next = itemsRef.current.find((item) => item.status === "pending");
        if (!next) return;
        await uploadOne(next.key);
      }
    } finally {
      drainingRef.current = false;
    }
  }

  function handlePicked(files: FileList | null) {
    const picked = files ? Array.from(files) : [];
    if (picked.length === 0) return;

    const room = Math.max(0, max - (count + added + countInFlight()));
    const accepted = picked.slice(0, room);
    const leftOut = picked.length - accepted.length;

    setNotice(
      leftOut > 0
        ? leftOut === 1
          ? `One photo was left out — there is only room for ${max} in total.`
          : `${leftOut} photos were left out — there is only room for ${max} in total.`
        : null,
    );

    if (accepted.length > 0) {
      write((current) => [
        ...current,
        ...accepted.map((file) => {
          const objectUrl = URL.createObjectURL(file);
          return {
            key: `upload-${(seqRef.current += 1)}`,
            file,
            name: file.name || "Photo",
            src: objectUrl,
            objectUrl,
            status: "pending" as const,
            progress: 0,
            error: null,
          };
        }),
      ]);
      void drain();
    }
  }

  function countInFlight() {
    return itemsRef.current.filter(
      (item) => item.status === "pending" || item.status === "uploading",
    ).length;
  }

  function retry(key: string) {
    patch(key, { status: "pending", progress: 0, error: null });
    void drain();
  }

  function discard(key: string) {
    const item = itemsRef.current.find((candidate) => candidate.key === key);
    if (item?.objectUrl) URL.revokeObjectURL(item.objectUrl);
    write((current) => current.filter((candidate) => candidate.key !== key));
  }

  /**
   * One coarse sentence for screen readers. Deliberately not the percentage:
   * a live region that re-reads itself every 50ms is unusable.
   */
  const liveMessage = useMemo(() => {
    const uploading = items.find((item) => item.status === "uploading");
    if (uploading) return `Uploading ${uploading.name}.`;
    const waiting = items.filter((item) => item.status === "pending").length;
    if (waiting > 0) return `${waiting} photos waiting to upload.`;
    const failed = items.filter((item) => item.status === "failed").length;
    if (failed > 0) {
      return failed === 1
        ? "One photo did not upload."
        : `${failed} photos did not upload.`;
    }
    const done = items.filter((item) => item.status === "done").length;
    if (done > 0) return done === 1 ? "Photo added." : `${done} photos added.`;
    return "";
  }, [items]);

  const buttonLabel = max === 1 || remaining === 1 ? "Add a photo" : "Add photos";

  const hint = full
    ? max === 1
      ? "There is already a photo here. Remove it before you add another."
      : `That is all ${max} photos. Remove one before you add another.`
    : max === 1
      ? "Pick a photo from your camera roll."
      : used === 0
        ? // What happens to a queue of them is visible in the queue itself, a
          // moment later. It does not need saying up front.
          `Up to ${max} photos, and you can pick several at once.`
        : `${used} of ${max} added. Pick several at once.`;

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* The real control, kept out of the tab order: the button below is what
          a person sees and what a keyboard reaches. */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={remaining > 1}
        tabIndex={-1}
        className="sr-only"
        onChange={(event) => {
          handlePicked(event.target.files);
          // Same file twice in a row has to fire `change` twice.
          event.target.value = "";
        }}
      />

      {variant === "panel" ? (
        <button
          type="button"
          disabled={full}
          aria-describedby={hintId}
          onClick={() => inputRef.current?.click()}
          className="flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ImagePlusIcon
            className="size-5 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="font-heading text-lg">{buttonLabel}</span>
        </button>
      ) : (
        <Button
          type="button"
          variant="outline"
          disabled={full}
          aria-describedby={hintId}
          onClick={() => inputRef.current?.click()}
          className="h-11 w-full gap-2"
        >
          <ImagePlusIcon className="size-4" aria-hidden="true" />
          {buttonLabel}
        </Button>
      )}

      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>

      {notice ? (
        <p role="status" className="text-xs text-destructive">
          {notice}
        </p>
      ) : null}

      <p aria-live="polite" className="sr-only">
        {liveMessage}
      </p>

      {items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            const percent = Math.round(item.progress * 100);

            return (
              <li
                key={item.key}
                className="flex flex-col gap-2 rounded-lg border border-border p-2"
              >
                <div className="flex items-center gap-3">
                  <div className="size-14 shrink-0 overflow-hidden rounded-md bg-muted">
                    {/* A blob: URL cannot be optimised, and the stored copy is
                        only on screen for a moment before the gallery takes
                        over. next/image would buy nothing here. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.src}
                      alt=""
                      className="size-full object-cover"
                    />
                  </div>

                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="truncate text-xs text-muted-foreground">
                      {item.name}
                    </p>

                    {item.status === "uploading" ? (
                      <>
                        <div
                          role="progressbar"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={percent}
                          aria-label={`Uploading ${item.name}`}
                          className="h-1 w-full overflow-hidden rounded-full bg-muted"
                        >
                          <div
                            className="h-full bg-foreground transition-[width]"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <p className="num text-xs text-muted-foreground">
                          Uploading… {percent}%
                        </p>
                      </>
                    ) : null}

                    {item.status === "pending" ? (
                      <p className="text-xs text-muted-foreground">
                        Waiting its turn.
                      </p>
                    ) : null}

                    {item.status === "done" ? (
                      <p className="flex items-center gap-1 text-xs text-muted-foreground">
                        <CheckIcon className="size-3.5" aria-hidden="true" />
                        Added.
                      </p>
                    ) : null}

                    {item.status === "failed" && item.error ? (
                      <p className="text-xs text-destructive">{item.error}</p>
                    ) : null}
                  </div>

                  {item.status === "pending" ? (
                    <button
                      type="button"
                      onClick={() => discard(item.key)}
                      aria-label={`Do not upload ${item.name}`}
                      className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                    >
                      <XIcon className="size-5" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>

                {item.status === "failed" ? (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => retry(item.key)}
                      className="h-11 flex-1 gap-2"
                    >
                      <RotateCcwIcon className="size-4" aria-hidden="true" />
                      Try again
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => discard(item.key)}
                      aria-label={`Give up on ${item.name}`}
                      className="size-11 shrink-0"
                    >
                      <XIcon className="size-5" aria-hidden="true" />
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
