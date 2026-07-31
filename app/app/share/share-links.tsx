"use client";

/**
 * Handing a link to somebody, and replacing the one that leaked.
 *
 * ### The share sheet is the product
 *
 * The entire thing the owner does with this screen is paste a link into a
 * family WhatsApp group. A phone already has one control for that, it is the
 * one everybody's thumb knows, and it carries the message text alongside the
 * URL so the thing that arrives in the chat reads like an invitation instead of
 * a bare address. So `navigator.share` is the primary action, and copying is
 * what happens on a laptop where there is no share sheet to open.
 *
 * Detection runs in an effect rather than at render: `navigator` does not exist
 * on the server, and a button whose label depends on it would hydrate into a
 * mismatch. Until the effect runs the copy path is what is on screen, which is
 * the correct answer for anything that never gets JavaScript at all.
 *
 * `navigator.share` must be called inside the tap that asked for it — a
 * browser revokes user activation across an `await` — so nothing is awaited
 * before it. A dismissed sheet throws `AbortError` and means "changed my mind",
 * not "failed"; anything else falls back to the clipboard rather than leaving a
 * dead button.
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
 * Tier three is why the URL is real selectable text on the page rather than an
 * opaque box with a button beside it. It is no longer a monospace `<code>` in a
 * bordered grey well, though: that is developer chrome, and this screen is for
 * sending a link to your mother.
 *
 * ### The link is the artifact, so it goes first and it is legible
 *
 * It used to be 13px grey tucked *under* the black button, which made the
 * caption about the link larger than the link. On the one that matters it now
 * sits above the button, with the origin small and quiet and the house's own
 * slug in the display face — a name, set the way this product sets names. A
 * long-press still takes the whole thing: both spans live in one `<p>` and the
 * selection is of its contents, not of a span.
 *
 * The feed's URL keeps the quiet single-line treatment. Its last segment is a
 * random token; setting that in a serif would be a joke.
 *
 * ### The feedback is on the button, not in a toast
 *
 * A toast for "Copied" lands at the edge of the screen, away from the thumb
 * that just tapped, and disappears on its own schedule. Swapping the button's
 * own label puts the answer under the finger that asked, and the `aria-live`
 * region carries the same words for a screen reader. Toasts stay for the thing
 * that changed the database.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, XIcon } from "lucide-react";
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
   THE PHONE'S OWN SHARE SHEET
   ============================================================ */

/** What `navigator.share` takes, typed here so the file compiles on any lib.dom. */
type Sharable = { title: string; text: string; url: string };

type ShareCapableNavigator = Navigator & {
  share?: (data: Sharable) => Promise<void>;
  canShare?: (data: Sharable) => boolean;
};

function canOpenShareSheet(data: Sharable): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as ShareCapableNavigator;
  if (typeof nav.share !== "function") return false;
  // Present but refusing this payload — a desktop Safari with no target, say.
  if (typeof nav.canShare === "function" && !nav.canShare(data)) return false;
  return true;
}

/**
 * A browser capability is external state, so it is read the way external state
 * is read. `useSyncExternalStore` gives the server (and the hydration pass)
 * `false` and the client the truth, in one render, with no effect writing state
 * back into the component — which is the pattern that causes the cascading
 * re-render React now warns about.
 */
const NEVER_CHANGES = () => () => {};
const NOT_ON_THE_SERVER = () => false;

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

/**
 * Split a URL at its last slash: the part nobody reads, and the part that is a
 * name. `https://yazlik.app/h/cesme-evi` → `https://yazlik.app/h/` + `cesme-evi`.
 */
function splitAtLastSlash(url: string): [string, string] {
  const cut = url.lastIndexOf("/");
  if (cut < 0 || cut === url.length - 1) return [url, ""];
  return [url.slice(0, cut + 1), url.slice(cut + 1)];
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

export type ShareLinkProps = {
  url: string;
  /** Goes in the share sheet's title slot — the house, not the app. */
  title: string;
  /** The sentence that lands in the chat next to the link. */
  message: string;
  /** What the send button says. */
  sendLabel: string;
  /** What the copy button says when it is the only thing on offer. */
  copyLabel: string;
  /**
   * `true` on the one link that is the point of the screen. Exactly one per
   * screen carries the ink; everything else is an outline. It also decides how
   * loudly the URL itself is set — the link that is the point of the screen is
   * read, and the one that is plumbing is not.
   */
  primary?: boolean;
};

export function ShareLink({
  url,
  title,
  message,
  sendLabel,
  copyLabel,
  primary = false,
}: ShareLinkProps) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef<HTMLParagraphElement | null>(null);

  const canSend = useSyncExternalStore(
    NEVER_CHANGES,
    useCallback(
      () => canOpenShareSheet({ title, text: message, url }),
      [title, message, url],
    ),
    NOT_ON_THE_SERVER,
  );

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

  const send = useCallback(() => {
    const nav = navigator as ShareCapableNavigator;
    const share = nav.share;
    if (!share) {
      void copy();
      return;
    }
    // Not awaited before the call: an `await` here spends the user activation
    // the share sheet needs, and the browser refuses.
    share.call(nav, { title, text: message, url }).catch((thrown: unknown) => {
      // They opened the sheet and closed it again. Nothing happened, and
      // nothing should be said about it.
      if (thrown instanceof DOMException && thrown.name === "AbortError") return;
      void copy();
    });
  }, [copy, message, title, url]);

  const [origin, name] = splitAtLastSlash(url);

  return (
    <div className="flex flex-col gap-3">
      {/* The link itself, above the button that hands it over, and selectable,
          because tier three of the clipboard fallback is a long-press on
          exactly this text. */}
      {primary ? (
        <p ref={textRef} className="font-heading text-lg break-all select-all">
          <span className="font-sans text-sm text-muted-foreground">
            {origin}
          </span>
          {name}
        </p>
      ) : (
        <p
          ref={textRef}
          className="text-sm break-all text-muted-foreground select-all"
        >
          {url}
        </p>
      )}

      <div className="flex flex-col gap-1">
        <Button
          type="button"
          variant={primary ? "default" : "outline"}
          onClick={canSend ? send : () => void copy()}
          className="h-12 w-full text-base"
        >
          {state === "copied" ? (
            <CheckIcon className="size-4" aria-hidden="true" />
          ) : null}
          {state === "copied" ? "Copied" : canSend ? sendLabel : copyLabel}
        </Button>

        {/* Only when the sheet took the top slot. On a laptop the button above
            is already the copy button and this would be the same thing twice. */}
        {canSend ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => void copy()}
            className="h-11 w-full text-sm font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
          >
            {state === "copied" ? "Copied" : "Copy it instead"}
          </Button>
        ) : null}
      </div>

      {/* One region, always in the tree, so a screen reader announces the change
          instead of the arrival of a new element. */}
      <p aria-live="polite" className={state === "failed" ? "text-sm" : "sr-only"}>
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
  /** The house's name, for the share sheet's title. */
  houseName: string;
  /**
   * What this link does, in the caller's words. It sits between the link and
   * the way to replace it — deliberately, so the sentence about what the link
   * gives away and the way to take it back read as one thing.
   */
  children?: React.ReactNode;
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
export function FeedLink({
  baseUrl,
  feedToken,
  houseName,
  children,
}: FeedLinkProps) {
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
      <ShareLink
        url={feedUrl(baseUrl, token)}
        title={`${houseName} — who is staying`}
        message="Add this to your calendar and the weeks fill themselves in."
        sendLabel="Send the calendar link"
        copyLabel="Copy the calendar link"
      />

      {children}

      {/* Ink, not grey. It is the answer to the sentence directly above it, and
          a remedy printed quieter than the consequence is not offered. */}
      <Button
        type="button"
        variant="ghost"
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="-mt-1 h-11 justify-start self-start px-0 text-base font-normal underline underline-offset-4 hover:bg-transparent"
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
            <div className="flex flex-col gap-1">
              <SheetTitle className="text-lg">Replace the calendar link?</SheetTitle>
              <SheetDescription className="text-sm">
                Every calendar on the old link stops updating, quietly. Hand the
                new one to whoever was using it.
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
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button
              type="button"
              variant="destructive"
              onClick={replace}
              disabled={rotating}
              className="h-12 w-full text-base"
            >
              {rotating ? "Replacing…" : "Replace it"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
