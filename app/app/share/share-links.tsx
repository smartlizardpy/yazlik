"use client";

/**
 * The interactive half of the share screen: copying a link, and replacing the
 * one that leaked.
 *
 * ### Copying has to actually work on a phone
 *
 * `navigator.clipboard` is only defined in a secure context. `https://` and
 * `http://localhost` qualify; `http://192.168.1.7:3100` — which is exactly how
 * an owner opens this on their phone while sitting next to the laptop running
 * it — does not. So there are three tiers, in order:
 *
 * 1. `navigator.clipboard.writeText`, the real one.
 * 2. A hidden `<textarea>` and `document.execCommand("copy")`. Deprecated,
 *    still implemented everywhere, and the only thing that works off-origin.
 * 3. Select the link on screen so a long-press can copy it, and say so.
 *
 * Tier three is why {@link CopyLink} renders the URL as real selectable text
 * rather than as an opaque box with a button beside it. `select-all` also means
 * one tap selects the whole thing, which on a URL with no word boundaries in it
 * is the difference between copying a link and copying half of one.
 *
 * ### The feedback is on the button, not in a toast
 *
 * A toast for "Copied" lands at the edge of the screen, away from the thumb
 * that just tapped, and disappears on its own schedule. Swapping the button's
 * own label to *Copied* puts the answer under the finger that asked, and the
 * `aria-live` region carries the same words for a screen reader. Toasts stay
 * for the thing that changed the database.
 */

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, CopyIcon, XIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import { rotateFeedToken } from "./actions";

/** How long the button says "Copied" before it goes back to offering. */
const FEEDBACK_MS = 2000;

/* ============================================================
   CLIPBOARD
   ============================================================ */

/** Tier one and tier two. Returns false when both are unavailable. */
async function writeToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied, or a browser that exposes the API and refuses it off
    // a secure origin. Either way the fallback below is the answer.
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    // Off-screen but still focusable. `display: none` cannot be selected, and
    // scrolling the page to a visible one is worse than either.
    area.style.position = "fixed";
    area.style.top = "0";
    area.style.left = "0";
    area.style.opacity = "0";
    area.style.pointerEvents = "none";
    document.body.append(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/** Tier three: put the link in the browser's selection so a long-press can take it. */
function selectElement(element: HTMLElement | null): void {
  if (!element) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

/* ============================================================
   ONE LINK
   ============================================================ */

export type CopyLinkProps = {
  url: string;
  /** What the button offers to copy — "Copy guest link", not "Copy". */
  label: string;
  /**
   * `true` on the one link that is the point of the screen. Exactly one per
   * screen carries the accent; everything else is an outline.
   */
  primary?: boolean;
};

export function CopyLink({ url, label, primary = false }: CopyLinkProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = useCallback(async () => {
    const copied = await writeToClipboard(url);
    if (!copied) selectElement(textRef.current);
    setState(copied ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    // A failure keeps its message until the next tap: the sentence tells the
    // owner to do something, and two seconds is not long enough to read it and
    // then act on it.
    if (copied) timer.current = setTimeout(() => setState("idle"), FEEDBACK_MS);
  }, [url]);

  return (
    <div className="flex flex-col gap-2">
      <code
        ref={textRef}
        // `select-all` so one tap takes the whole URL; `break-all` because a
        // token has no spaces and would otherwise push the layout sideways.
        className="block rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-xs break-all select-all"
      >
        {url}
      </code>

      <Button
        type="button"
        variant={primary ? "default" : "outline"}
        onClick={copy}
        className="h-11 w-full text-base"
      >
        {state === "copied" ? (
          <CheckIcon className="size-4" aria-hidden="true" />
        ) : (
          <CopyIcon className="size-4" aria-hidden="true" />
        )}
        {state === "copied" ? "Copied" : label}
      </Button>

      {/* One region, always in the tree, so a screen reader announces the change
          instead of the arrival of a new element. */}
      <p
        aria-live="polite"
        className={
          state === "failed"
            ? "text-xs text-muted-foreground"
            : "sr-only"
        }
      >
        {state === "copied"
          ? "Copied to the clipboard."
          : state === "failed"
            ? "This browser blocked the clipboard. The link is selected — hold it and copy."
            : ""}
      </p>
    </div>
  );
}

/* ============================================================
   THE FEED LINK, WHICH CAN BE REPLACED
   ============================================================ */

export type FeedLinkProps = {
  /** Origin with no trailing slash, e.g. `http://localhost:3100`. */
  baseUrl: string;
  feedToken: string;
};

/** `.ics` on the end: several clients refuse a subscribe URL without it, and this route takes both. */
function feedUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/api/feed/${token}.ics`;
}

/**
 * The subscribe URL, plus the way out of a leak.
 *
 * The new token comes back from the action and goes straight into state, so the
 * URL on screen is the working one the moment the sheet closes — waiting for
 * `router.refresh()` to bring it back would leave a dead link on screen for as
 * long as the round trip takes, which is exactly when somebody copies it.
 */
export function FeedLink({ baseUrl, feedToken }: FeedLinkProps) {
  const router = useRouter();
  const [token, setToken] = useState(feedToken);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rotating, startRotate] = useTransition();

  function replace() {
    setError(null);
    startRotate(async () => {
      try {
        const result = await rotateFeedToken();
        if (result.ok) {
          setToken(result.feedToken);
          setOpen(false);
          toast.success("New calendar link. The old one stopped working.");
        } else {
          setError(result.error);
        }
      } catch (thrown) {
        console.error("[FeedLink] rotate failed", thrown);
        setError("The link did not change. Try again in a moment.");
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <CopyLink url={feedUrl(baseUrl, token)} label="Copy calendar link" />

      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="h-11 justify-start self-start px-0 text-sm text-muted-foreground underline underline-offset-4 hover:bg-transparent hover:text-foreground"
      >
        Replace this link
      </Button>

      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (!rotating) setOpen(next);
        }}
      >
        <SheetContent
          side="bottom"
          // shadcn's own close control is a 28px target and lives in a file this
          // slice does not own. Ours is in the header, at 44.
          showCloseButton={false}
          className="max-h-[92svh] gap-0 overflow-y-auto rounded-t-xl p-0"
        >
          <SheetHeader className="flex-row items-start justify-between gap-2 px-4 pt-4 pb-2">
            <div className="flex flex-col gap-0.5">
              <SheetTitle>Replace the calendar link?</SheetTitle>
              <SheetDescription>
                Every calendar subscribed to the old link stops updating. Most of
                them go quiet rather than warn anyone, so hand the new link to
                whoever was using the old one.
              </SheetDescription>
            </div>
            <SheetClose asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label="Close"
                className="size-11 shrink-0 p-0"
              >
                <XIcon className="size-5" aria-hidden="true" />
              </Button>
            </SheetClose>
          </SheetHeader>

          <div className="flex flex-col gap-2 px-4 pt-2 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {error ? (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              onClick={replace}
              disabled={rotating}
              className="h-11 w-full text-base"
            >
              {rotating ? "Replacing…" : "Replace link"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
